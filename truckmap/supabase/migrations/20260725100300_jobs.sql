-- ============================================================================
-- 0004 — scheduled maintenance (pg_cron)
--
-- Enable pg_cron in the Supabase dashboard (Database > Extensions) before
-- running this, or the cron.schedule() calls at the bottom will fail.
--
-- Two jobs. The de-bloat pass cut two more:
--   * recompute_reliability() — needs ~90 days of sighting history to output
--     anything but 1.0, so it would ship as dead code. trucks.reliability sits
--     at its 1.000 default until then, which makes it a no-op in the formula.
--     GROWTH: add the learner as its own migration once there is data.
--   * a 15-minute expire_appearances tick — 96 runs/day to maintain a field
--     that is purely cosmetic (confidence already reads 0 past the window).
--     Folded into the nightly sweep.
-- ============================================================================

create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- 1. Materialize recurring schedules into appearances.
--
-- Rolling 14-day horizon, idempotent via appearances_schedule_slot_uq. Schedule
-- times are LOCAL wall-clock, so `AT TIME ZONE 'America/New_York'` resolves them
-- to absolute instants — a 5pm Thursday slot stays 5pm across the DST boundary.
--
-- Day expansion is `current_date + n` over generate_series(0, p_days): date
-- arithmetic, no timestamp casting, no timezone ambiguity in the join.
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
  join public.trucks t on t.id = s.truck_id and t.status = 'active'
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
-- 2. Close out appearances whose window (plus the 30-minute grace the window
--    gate allows) has fully passed. Cosmetic for the map — confidence already
--    reads 0 — but it keeps `status` honest for history queries.
-- ---------------------------------------------------------------------------
create or replace function public.expire_appearances()
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  update public.appearances
     set status = 'ended'
   where status in ('scheduled', 'confirmed')
     and ends_at + interval '30 minutes' < now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Truck confidence carries a staleness term, which only moves as time
--    passes — so unlike a vote-driven recompute it needs a periodic sweep.
--    A few hundred rows; a full pass is trivial.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_all_truck_confidence()
returns integer language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_n integer := 0;
begin
  for v_id in select id from public.trucks where status not in ('closed', 'hidden') loop
    perform public.recompute_truck_confidence(v_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- The single nightly sweep: expire dead windows, then re-age every truck.
create or replace function public.nightly_maintenance()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.expire_appearances();
  perform public.refresh_all_truck_confidence();
end;
$$;

-- ---------------------------------------------------------------------------
-- Keep truck confidence fresh on write events too (the fast path), so a new
-- sighting or a claimed truck updates immediately rather than at 3am.
-- ---------------------------------------------------------------------------
create or replace function public.trg_sighting_touch_truck()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_truck_id bigint;
begin
  -- Branch on TG_OP rather than COALESCE(new.x, old.x): in a row-level DELETE
  -- trigger NEW is an UNASSIGNED record, and referencing a field on it is an
  -- error in PL/pgSQL, not a NULL. The coalesce idiom only looks safe.
  if tg_op = 'DELETE' then
    v_truck_id := old.truck_id;
  else
    v_truck_id := new.truck_id;
  end if;

  perform public.recompute_truck_confidence(v_truck_id);

  if tg_op = 'INSERT' and new.kind = 'here' then
    update public.trucks
       set last_verified_at = greatest(coalesce(last_verified_at, new.seen_at), new.seen_at)
     where id = new.truck_id;
  end if;
  return null;
end;
$$;

create trigger sightings_after_write
  after insert or delete on private.sightings
  for each row execute function public.trg_sighting_touch_truck();

-- ---------------------------------------------------------------------------
-- Schedule. Times are UTC (pg_cron runs on the DB clock); 07:xx UTC is the
-- small hours in America/New_York.
-- ---------------------------------------------------------------------------

select cron.schedule('materialize-schedules', '15 7 * * *', $$select public.materialize_schedules(14)$$);
select cron.schedule('nightly-maintenance',   '45 7 * * *', $$select public.nightly_maintenance()$$);
