-- ============================================================================
-- 0018 — curated trucks: the ones you vouch for stay on the map.
--
-- THE PROBLEM
-- There was no way to put a truck on the map and have it STAY there. Two gaps,
-- and between them the only durable pins on the site belonged to demo data:
--
--   1. A submitted truck with a pin got ONE appearance lasting 1-12 hours.
--      When that window closed the truck row survived but became unreachable —
--      no pin, and no search yet, so it existed only in the database. The single
--      most discouraging outcome for someone who just filled in a form.
--
--   2. Recurring schedules — the mechanism that DOES persist, and the only
--      reason the demo trucks are still visible — could not be created by
--      anyone. They existed solely because migration 0006 hand-wrote six INSERTs.
--
-- So "make my truck stay on the map like the demo ones do, without calling it a
-- demo" had no answer. This migration is that answer.
--
-- WHAT 'CURATED' MEANS
-- The maintainer vouches for this truck: it is real, it operates, and it should
-- not be quietly demoted by an automated sweep. It is NOT a display label —
-- nothing in the UI renders it, no [DEMO] prefix, no badge. A visitor cannot
-- tell a curated truck from any other, which is the point: these are real
-- businesses, and the flag is about maintenance, not presentation.
--
-- Curation is deliberately a maintainer-only act. It is EXECUTE-granted to
-- service_role alone, so it is reachable from scripts/moderate.mjs and from
-- nowhere else — in particular not from the browser, which still has no write
-- path to any table. See migration 0013 for why that revoke names `public`.
-- ============================================================================

alter table public.trucks
  add column if not exists curated boolean not null default false;

comment on column public.trucks.curated is
  'The maintainer vouches for this truck: pinned active, never auto-demoted. '
  'Not a display flag — nothing in the UI shows it. See migration 0018.';

create index if not exists trucks_curated_ix on public.trucks (curated) where curated;

-- ---------------------------------------------------------------------------
-- 1. THE TIMEBOMB: materialize_schedules only built appearances for trucks
--    whose status was exactly 'active'.
--
-- That reads as a sensible guard until you follow the loop. The nightly sweep
-- recomputes truck confidence; a truck with no licence, no owner and no
-- sightings scores 0 and is set 'dormant'; the materializer then skips it
-- forever. Every schedule in the database belongs to such a truck, so the
-- rolling 14-day horizon quietly stopped advancing 70 hours after launch and
-- the map was due to empty completely on 2026-08-08 — with no error anywhere,
-- because each individual step was behaving exactly as written.
--
-- A standing weekly rule is itself the evidence that a truck operates. Letting
-- a confidence heuristic switch the materializer off is the tail wagging the
-- dog. Hidden and closed still stop it, because those are decisions somebody
-- actually made.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_schedules(p_days integer default 14)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  insert into public.appearances
    (truck_id, venue_id, geom, starts_at, ends_at, source, asserted_at, schedule_id, status)
  select
    s.truck_id,
    s.venue_id,
    v.geom,
    (((current_date + offs.n) + s.start_time) at time zone 'America/New_York'),
    (((current_date + offs.n) + s.end_time)   at time zone 'America/New_York'),
    'recurring',
    now(),
    s.id,
    'scheduled'
  from public.schedules s
  join public.venues v on v.id = s.venue_id
  -- Was `t.status = 'active'`. See the note above.
  join public.trucks t on t.id = s.truck_id and t.status not in ('hidden', 'closed')
  cross join generate_series(0, p_days) as offs(n)
  where s.active
    and extract(dow from (current_date + offs.n))::smallint = s.day_of_week
    and (current_date + offs.n) >= s.valid_from
    and (s.valid_until is null or (current_date + offs.n) <= s.valid_until)
  on conflict (schedule_id, starts_at) do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. One standing rule per truck, place, day and start time.
--
-- Without this, running `moderate place` twice on the same truck silently built
-- a second identical schedule, and the map grew two stacked pins for one truck
-- that nothing would ever reconcile. Deactivate any existing exact duplicates
-- first so the index can be created — there should be none, but a partial
-- unique index that aborts the migration is a poor way to find out.
-- ---------------------------------------------------------------------------
update public.schedules s
   set active = false
 where s.active
   and exists (
     select 1 from public.schedules o
      where o.active and o.id < s.id
        and o.truck_id    = s.truck_id
        and o.venue_id    = s.venue_id
        and o.day_of_week = s.day_of_week
        and o.start_time  = s.start_time);

create unique index if not exists schedules_rule_uq
  on public.schedules (truck_id, venue_id, day_of_week, start_time) where active;

-- ---------------------------------------------------------------------------
-- 3. Truck confidence honours curation.
--
-- Carries forward every branch from 0002 and 0010 — including the submission_id
-- credit, which is easy to drop when redefining this function and shows up only
-- as freshly submitted trucks going dormant overnight.
--
-- A curated truck gets a source credit comparable to a licence, and is pinned
-- 'active' outright. The pin is the load-bearing half: 'dormant' is what stops
-- the materializer, so without it a truck you curated on Monday would fall off
-- the map by Tuesday morning and every part of the system would look correct.
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
  if v_row.curated then
    v_source := v_source + 50;   -- a human who runs this map checked it
  end if;
  if v_row.submission_id is not null then
    v_source := v_source + 20;   -- a human filled in a form for it
  end if;
  if exists (select 1 from private.sightings s
              where s.truck_id = p_truck_id and s.kind = 'here') then
    v_source := v_source + 15;
  end if;
  v_source := least(85, v_source);

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
                    when v_row.curated then 'active'::public.truck_status
                    when v_gone >= 3 and v_conf < 25 then 'dormant'::public.truck_status
                    when v_conf >= 25 then 'active'::public.truck_status
                    else 'dormant'::public.truck_status
                  end,
         updated_at = now()
   where id = p_truck_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The moderation log gains two verbs. Curating a truck is an editorial act
--    with a name attached to it, and belongs in the same append-only history as
--    a takedown — "why is this truck on the map?" deserves an answer too.
-- ---------------------------------------------------------------------------
alter table private.moderation_log drop constraint if exists moderation_log_action_check;
alter table private.moderation_log add constraint moderation_log_action_check
  check (action in ('hide', 'show', 'reject', 'approve', 'curate', 'uncurate'));

-- ---------------------------------------------------------------------------
-- 5. curate_truck — create or adopt a truck, vouch for it, and optionally give
--    it a standing weekly rule so it keeps a pin.
--
-- ONE function rather than add/place/curate, because all three have to happen
-- together to produce a visible truck and any two of them alone produce a
-- confusing half-state: a truck with no pin, or a pin on a truck the nightly
-- sweep will demote tonight.
--
-- Identify by p_truck_id (adopt an existing row — an imported licence, say) or
-- by p_name (find by name, create if new). Detail fields are only written when
-- non-null, so re-running to add a schedule never blanks a description.
-- ---------------------------------------------------------------------------
create or replace function public.curate_truck(
  p_truck_id    bigint  default null,
  p_name        text    default null,
  p_cuisines    text[]  default null,
  p_description text    default null,
  p_website     text    default null,
  p_facebook    text    default null,
  p_instagram   text    default null,
  p_phone       text    default null,
  p_lat         double precision default null,
  p_lon         double precision default null,
  p_place_name  text    default null,
  p_venue_type  text    default 'other',
  p_days        smallint[] default null,      -- 0=Sun .. 6=Sat; null => all seven
  p_start       time    default '11:00',
  p_end         time    default '19:00',
  p_actor       text    default null
) returns jsonb
language plpgsql security definer
set search_path = public, private, extensions as $$
declare
  v_id       bigint;
  v_slug     text;
  v_name     text;
  v_created  boolean := false;
  v_venue    bigint;
  v_vname    text;
  v_vtype    public.venue_type := 'other';
  v_geom     extensions.geometry;
  v_days     smallint[];
  v_sched    integer := 0;
  v_pins     integer := 0;
  v_day      smallint;
begin
  -- --- identify or create ---------------------------------------------------
  if p_truck_id is not null then
    select id, name into v_id, v_name from public.trucks where id = p_truck_id;
    if v_id is null then
      raise exception 'no truck with id %', p_truck_id using errcode = 'P0002';
    end if;
  elsif p_name is not null and length(btrim(p_name)) >= 2 then
    select id, name into v_id, v_name
      from public.trucks where lower(name) = lower(btrim(p_name));
    if v_id is null then
      v_name := btrim(p_name);
      v_slug := public.unique_slug(public.slugify(v_name));
      insert into public.trucks (slug, name, status, data_source, curated, last_verified_at)
      values (v_slug, v_name, 'active', 'maintainer', true, now())
      returning id into v_id;
      v_created := true;
    end if;
  else
    raise exception 'need either a truck id or a name' using errcode = '22023';
  end if;

  -- --- vouch, and fill in whatever was supplied -----------------------------
  update public.trucks
     set curated     = true,
         status      = case when status in ('hidden', 'closed')
                            then status                       -- respect a takedown
                            else 'active'::public.truck_status end,
         cuisines    = coalesce(p_cuisines, cuisines),
         description = coalesce(p_description, description),
         website     = coalesce(p_website, website),
         facebook    = coalesce(p_facebook, facebook),
         instagram   = coalesce(p_instagram, instagram),
         phone       = coalesce(p_phone, phone),
         last_verified_at = now(),
         updated_at  = now()
   where id = v_id
  returning slug, name into v_slug, v_name;

  -- --- place it, if coordinates were given ----------------------------------
  if p_lat is not null and p_lon is not null then
    if p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
      raise exception 'coordinates out of range' using errcode = '22023';
    end if;
    if p_end <= p_start then
      raise exception 'the end time must be after the start time' using errcode = '22023';
    end if;

    begin
      v_vtype := p_venue_type::public.venue_type;
    exception when others then
      v_vtype := 'other';   -- an unknown type is not worth failing a placement over
    end;

    v_geom  := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326);
    v_vname := coalesce(nullif(btrim(p_place_name), ''), v_name || ' — regular stop');

    -- Reuse a venue of the same name within 150m rather than accumulating a new
    -- row per placement. Same name at the far end of town is a different place;
    -- same name 40m away is someone re-picking the spot on the map.
    select id into v_venue
      from public.venues
     where lower(name) = lower(v_vname)
       and extensions.ST_DWithin(geom::extensions.geography, v_geom::extensions.geography, 150)
     limit 1;

    if v_venue is null then
      insert into public.venues (name, venue_type, geom, state)
      values (v_vname, v_vtype, v_geom, 'OH')
      returning id into v_venue;
    end if;

    -- No days given means "it's generally there" — every day, which is the
    -- honest reading of a maintainer dropping one pin with no schedule.
    v_days := coalesce(p_days, array[0,1,2,3,4,5,6]::smallint[]);

    foreach v_day in array v_days loop
      if v_day between 0 and 6 then
        insert into public.schedules (truck_id, venue_id, day_of_week, start_time, end_time)
        values (v_id, v_venue, v_day, p_start, p_end)
        on conflict (truck_id, venue_id, day_of_week, start_time) where active do nothing;
        -- FOUND is false when ON CONFLICT swallowed the row, so this counts
        -- rules actually added rather than rules asked for. Re-running a
        -- placement should report "0 added", not repeat the original number.
        if found then v_sched := v_sched + 1; end if;
      end if;
    end loop;

    -- Build the horizon now. Waiting for the 07:15 UTC cron would mean adding a
    -- truck and being told it worked while the map still showed nothing.
    perform public.materialize_schedules(14);

    select count(*) into v_pins
      from public.appearances
     where truck_id = v_id and ends_at >= now() and status <> 'cancelled';
  end if;

  perform public.recompute_truck_confidence(v_id);

  insert into private.moderation_log (entity_type, entity_id, action, reason, actor)
  values ('truck', v_id, 'curate',
          case when v_venue is null then 'curated (no location)'
               else format('curated and placed at %s', v_vname) end,
          p_actor);

  return jsonb_build_object(
    'id', v_id, 'slug', v_slug, 'name', v_name, 'created', v_created,
    'venue_id', v_venue, 'venue_name', v_vname,
    'schedules_added', v_sched, 'upcoming_appearances', v_pins);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. uncurate_truck — undo it. Curation is an editorial claim, so it has to be
--    retractable without a takedown: "I was wrong that this truck is out there"
--    is a different statement from "this listing is abuse".
--
-- Dropping the schedules also cancels the FUTURE appearances they built.
-- Deactivating the rule alone would leave up to 14 days of already-materialized
-- pins standing, which is the opposite of what anyone means by removing it.
-- Past appearances stay: they are history, and sightings hang off them.
-- ---------------------------------------------------------------------------
create or replace function public.uncurate_truck(
  p_truck_id        bigint,
  p_drop_schedules  boolean default true,
  p_reason          text    default null,
  p_actor           text    default null
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare
  v_name  text;
  v_rules integer := 0;
  v_pins  integer := 0;
begin
  update public.trucks set curated = false, updated_at = now()
   where id = p_truck_id
  returning name into v_name;

  if v_name is null then
    raise exception 'no truck with id %', p_truck_id using errcode = 'P0002';
  end if;

  if p_drop_schedules then
    with dropped as (
      update public.schedules set active = false
       where truck_id = p_truck_id and active
      returning id
    ), cancelled as (
      update public.appearances set status = 'cancelled'
       where truck_id = p_truck_id
         and starts_at > now()
         and status <> 'cancelled'
         and schedule_id in (select id from dropped)
      returning id
    )
    select (select count(*) from dropped), (select count(*) from cancelled)
      into v_rules, v_pins;
  end if;

  -- Now that curated is false this may legitimately demote it to 'dormant'.
  perform public.recompute_truck_confidence(p_truck_id);

  insert into private.moderation_log (entity_type, entity_id, action, reason, actor)
  values ('truck', p_truck_id, 'uncurate', p_reason, p_actor);

  return jsonb_build_object('id', p_truck_id, 'name', v_name,
    'schedules_deactivated', v_rules, 'appearances_cancelled', v_pins);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lock them down. Revoke from PUBLIC, not just anon/authenticated — a new
--    function is granted EXECUTE to PUBLIC on creation, so naming only the two
--    roles is the no-op that migration 0013 exists to fix.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('curate_truck', 'uncurate_truck')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
