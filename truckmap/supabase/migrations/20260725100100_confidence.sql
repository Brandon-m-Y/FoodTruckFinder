-- ============================================================================
-- 0002 — the decay model + the map's query surface
--
-- THE KEY ARCHITECTURAL DIFFERENCE FROM OpenDrop
-- ----------------------------------------------
-- OpenDrop materializes confidence into a column and recomputes it in a trigger,
-- because it only changes when someone WRITES (a vote, a new source).
--
-- Appearance confidence changes with the PASSAGE OF TIME ALONE. No write event
-- happens when a truck's lunch window ends. A trigger cannot fire on "an hour
-- went by", so materializing it would mean a cron job racing wall-clock time and
-- always being slightly wrong.
--
-- Therefore:
--   * appearance confidence  -> COMPUTED AT QUERY TIME, parameterized by `as_of`
--   * truck confidence       -> materialized in a column, trigger/cron maintained
--
-- Parameterizing on `as_of` (rather than hardcoding now()) is what makes the
-- time-scrubber UI possible: "where can I eat at 6pm Friday?" is the same code
-- path as "what's open now".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Exponential decay. w(0) = 1, w(half_life) = 0.5, w(2*half_life) = 0.25.
--
-- IMMUTABLE because `as_of` is an argument, not now(). That is what lets the
-- planner inline it and what makes the model unit-testable at a fixed clock.
-- The 30-day short-circuit also keeps numeric power() away from underflow.
-- ---------------------------------------------------------------------------
create or replace function public.decay_weight(
  p_observed_at   timestamptz,
  p_as_of         timestamptz,
  p_half_life_min numeric
) returns numeric language sql immutable parallel safe as $$
  select case
    when p_observed_at is null or p_half_life_min <= 0 then 0::numeric
    when p_observed_at > p_as_of                       then 0::numeric   -- future claim: no weight yet
    when p_as_of - p_observed_at > interval '30 days'  then 0::numeric
    else power(
      0.5::numeric,
      (extract(epoch from (p_as_of - p_observed_at)) / 60.0 / p_half_life_min)::numeric
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- PLAN component — how much do we believe the claim, given who made it and
-- how long ago they made it?
--
--   source          base   half-life   rationale
--   operator          80    4 days     the vendor said so; ages out over a week
--   venue_calendar    65    7 days     brewery published it; edited, but slowly
--   recurring         50    never      a standing rule has no assertion to age;
--                                      it is gated by the truck's reliability instead
--   scraped           45    3 days
--   crowd             35    2 days     someone else's guess about a third party
--
-- TUNE HERE. These five numbers are the entire editorial policy of the map.
-- ---------------------------------------------------------------------------
create or replace function public.plan_weight(
  p_source      public.appearance_source,
  p_asserted_at timestamptz,
  p_as_of       timestamptz
) returns numeric language sql immutable parallel safe as $$
  select case p_source
    when 'operator'       then 80 * public.decay_weight(p_asserted_at, p_as_of,  5760)
    when 'venue_calendar' then 65 * public.decay_weight(p_asserted_at, p_as_of, 10080)
    when 'recurring'      then 50::numeric
    when 'scraped'        then 45 * public.decay_weight(p_asserted_at, p_as_of,  4320)
    when 'crowd'          then 35 * public.decay_weight(p_asserted_at, p_as_of,  2880)
    else 0::numeric
  end;
$$;

-- ---------------------------------------------------------------------------
-- WINDOW GATE — where `as_of` sits relative to the service window. Multiplies
-- the PLAN component only (see appearance_confidence for why).
--
--   > 6h before start        0.35   "on the schedule", not "happening"
--   6h .. 1h before          0.55
--   final hour before start  0.55 -> 1.00 (linear ramp)
--   inside the window        1.00
--   30 min after end         1.00 -> 0.00 (linear ramp; trucks run late)
--   beyond that              0.00
-- ---------------------------------------------------------------------------
create or replace function public.window_gate(
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_as_of     timestamptz
) returns numeric language sql immutable parallel safe as $$
  select case
    when p_as_of < p_starts_at - interval '6 hours' then 0.35::numeric
    when p_as_of < p_starts_at - interval '1 hour'  then 0.55::numeric
    when p_as_of < p_starts_at then
      0.55::numeric + 0.45::numeric *
        (1 - (extract(epoch from (p_starts_at - p_as_of)) / 3600.0)::numeric)
    when p_as_of <= p_ends_at then 1.00::numeric
    when p_as_of <= p_ends_at + interval '30 minutes' then
      1.00::numeric - (extract(epoch from (p_as_of - p_ends_at)) / 1800.0)::numeric
    else 0::numeric
  end;
$$;

-- ---------------------------------------------------------------------------
-- SIGHTING component — live crowd corroboration. 45-minute half-life: a report
-- from 45 min ago is worth half of a fresh one, and after ~3 hours it is noise.
--
-- Negative reports weigh 1.5x positive ones and have a deeper floor, so "I drove
-- past, it isn't there" can drive a confident-looking scheduled appearance to
-- zero. That asymmetry is deliberate — the cost of sending someone to an empty
-- lot is much higher than the cost of under-advertising a truck that is there.
--
-- NOTE the COALESCE *inside* each LEAST. Postgres LEAST/GREATEST skip NULL
-- inputs, so LEAST(40, NULL) = 40 — a zero-sighting appearance would otherwise
-- score a full +40. (OpenDrop shipped exactly this bug and fixed it in its
-- migration 0002; same trap, same fix.)
-- ---------------------------------------------------------------------------
create or replace function public.sighting_weight(
  p_appearance_id bigint,
  p_as_of         timestamptz
) returns numeric language sql stable as $$
  select
      least(40::numeric, coalesce(sum(
        case when s.kind = 'here'
             then 20 * public.decay_weight(s.seen_at, p_as_of, 45) else 0 end), 0))
    - least(60::numeric, coalesce(sum(
        case when s.kind = 'not_here'
             then 30 * public.decay_weight(s.seen_at, p_as_of, 45) else 0 end), 0))
  from private.sightings s
  where s.appearance_id = p_appearance_id
    and s.seen_at <= p_as_of
    and s.seen_at >  p_as_of - interval '6 hours';   -- past this, a 45-min half-life is dead
$$;

-- ---------------------------------------------------------------------------
-- APPEARANCE CONFIDENCE — "is this truck at this spot at time T?"
--
--   confidence = clamp(0, 100,  plan * reliability * gate  +  sightings )
--
-- The gate multiplies the PLAN only; sightings stand on their own. A live
-- eyewitness report is direct evidence and should not be discounted just
-- because the posted window already closed — that IS the signal that a truck
-- stayed late. Its own 45-minute half-life retires it soon enough.
-- ---------------------------------------------------------------------------
create or replace function public.appearance_confidence(
  p_appearance_id bigint,
  p_as_of         timestamptz default now()
) returns numeric language sql stable as $$
  select case
    when a.status = 'cancelled' then 0::numeric
    else greatest(0::numeric, least(100::numeric,
        public.plan_weight(a.source, a.asserted_at, p_as_of)
          * t.reliability
          * public.window_gate(a.starts_at, a.ends_at, p_as_of)
        + public.sighting_weight(a.id, p_as_of)
    ))
  end
  from public.appearances a
  join public.trucks t on t.id = a.truck_id
  where a.id = p_appearance_id;
$$;

-- UI buckets. `live` is the only one that should ever read as a promise.
create or replace function public.confidence_bucket(p_confidence numeric)
returns text language sql immutable parallel safe as $$
  select case
    when p_confidence >= 70 then 'live'
    when p_confidence >= 40 then 'likely'
    when p_confidence >= 20 then 'scheduled'
    else 'unlikely'
  end;
$$;

-- ---------------------------------------------------------------------------
-- trucks_at() — the single RPC the map calls.
--
-- SECURITY DEFINER because it aggregates private.sightings. It returns only
-- counts and timestamps, never an ip_hash. This is the ONLY route by which
-- sighting data reaches a browser.
--
-- Call it from the client as:
--   supabase.rpc('trucks_at', { p_as_of: iso, p_west: ..., p_min_confidence: 20 })
-- ---------------------------------------------------------------------------
create or replace function public.trucks_at(
  p_as_of          timestamptz default now(),
  p_west           double precision default null,
  p_south          double precision default null,
  p_east           double precision default null,
  p_north          double precision default null,
  p_min_confidence numeric default 20,
  p_cuisines       text[] default null
) returns table (
  appearance_id bigint,
  truck_id      bigint,
  slug          text,
  truck_name    text,
  cuisines      text[],
  logo_path     text,
  venue_id      bigint,
  venue_name    text,
  lon           double precision,
  lat           double precision,
  starts_at     timestamptz,
  ends_at       timestamptz,
  source        public.appearance_source,
  confidence    numeric,
  bucket        text,
  recent_here     integer,
  recent_not_here integer,
  last_seen_here  timestamptz
)
language sql stable security definer set search_path = public, private, extensions as $$
  with candidate as (
    select a.*
    from public.appearances a
    join public.trucks t on t.id = a.truck_id
    where a.status <> 'cancelled'
      and t.status not in ('hidden', 'closed')
      -- The window gate's support: outside this span confidence is 0 anyway,
      -- so this is a lossless index-driven prefilter, not a heuristic.
      and a.starts_at - interval '6 hours'   <= p_as_of
      and a.ends_at   + interval '30 minutes' >= p_as_of
      and (p_west is null or a.geom && extensions.ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326))
      and (p_cuisines is null or t.cuisines && p_cuisines)
  ),
  scored as (
    select c.id, c.truck_id, c.venue_id, c.starts_at, c.ends_at, c.source, c.geom,
           public.appearance_confidence(c.id, p_as_of) as conf
    from candidate c
  )
  select
    s.id, t.id, t.slug, t.name, t.cuisines, t.logo_path,
    v.id, v.name,
    extensions.ST_X(s.geom), extensions.ST_Y(s.geom),
    s.starts_at, s.ends_at, s.source,
    round(s.conf, 1), public.confidence_bucket(s.conf),
    coalesce(sig.here, 0)::integer,
    coalesce(sig.not_here, 0)::integer,
    sig.last_here
  from scored s
  join public.trucks t on t.id = s.truck_id
  left join public.venues v on v.id = s.venue_id
  left join lateral (
    select count(*) filter (where g.kind = 'here')     as here,
           count(*) filter (where g.kind = 'not_here') as not_here,
           max(g.seen_at) filter (where g.kind = 'here') as last_here
    from private.sightings g
    where g.appearance_id = s.id
      and g.seen_at <= p_as_of
      and g.seen_at >  p_as_of - interval '6 hours'
  ) sig on true
  where s.conf >= p_min_confidence
  order by s.conf desc, s.starts_at;
$$;

-- ---------------------------------------------------------------------------
-- TRUCK CONFIDENCE — the slow axis. "Does this business exist and operate?"
-- This one DOES only change on write events, so it is materialized in a column
-- exactly like OpenDrop's recompute_confidence().
--
--   source_component  = min(85, license 45 + claimed 35 + crowd-seen 15)
--   crowd_component   = clamp(-40, 30, 4 * days-seen-alive  -  8 * 'gone' reports)
--   staleness_penalty = min(30, 2 per month since last_verified_at)
--
-- A "venue vouched for it" component was cut in the de-bloat pass: it tested for
-- venue_calendar appearances, and there is no venue-calendar feed yet.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_truck_confidence(p_truck_id bigint)
returns void language plpgsql security definer set search_path = public, private as $$
declare
  v_source numeric := 0;
  v_crowd  numeric := 0;
  v_stale  numeric := 0;
  v_days   integer := 0;
  v_gone   integer := 0;
  v_conf   numeric;
  v_row    public.trucks%rowtype;
begin
  select * into v_row from public.trucks where id = p_truck_id;
  if not found then return; end if;

  if v_row.license_number is not null
     and (v_row.license_expires_at is null or v_row.license_expires_at >= current_date) then
    v_source := v_source + 45;
  end if;
  if v_row.owner_id is not null then
    v_source := v_source + 35;
  end if;
  if exists (select 1 from private.sightings s
              where s.truck_id = p_truck_id and s.kind = 'here') then
    v_source := v_source + 15;
  end if;
  v_source := least(85, v_source);

  -- Distinct DAYS on which someone saw it alive (not raw report count) — one
  -- enthusiastic fan on one afternoon shouldn't outweigh six separate weeks.
  select count(distinct (s.seen_at at time zone 'America/New_York')::date)
    into v_days
  from private.sightings s
  where s.truck_id = p_truck_id and s.kind = 'here'
    and s.seen_at > now() - interval '180 days';

  select count(*) into v_gone
  from private.sightings s
  where s.truck_id = p_truck_id and s.kind = 'gone'
    and s.seen_at > now() - interval '180 days';

  v_crowd := greatest(-40, least(30, 4 * v_days - 8 * v_gone));

  if v_row.last_verified_at is not null then
    v_stale := least(30, 2 * (extract(epoch from (now() - v_row.last_verified_at)) / 2592000.0));
  end if;

  v_conf := greatest(0, least(100, v_source + v_crowd - v_stale));

  update public.trucks
     set confidence = round(v_conf, 2),
         status = case
                    when status in ('hidden', 'closed') then status   -- terminal / manual
                    when v_gone >= 3 and v_conf < 25 then 'dormant'::public.truck_status
                    when v_conf >= 25 then 'active'::public.truck_status
                    else 'dormant'::public.truck_status
                  end,
         updated_at = now()
   where id = p_truck_id;
end;
$$;
