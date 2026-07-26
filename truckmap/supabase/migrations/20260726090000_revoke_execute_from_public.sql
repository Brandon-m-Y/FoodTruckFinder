-- ============================================================================
-- 0013 — SECURITY: actually revoke EXECUTE on the write RPCs.
--
-- THE BUG
-- -------
-- Every `revoke execute ... from anon, authenticated` in migrations 0003, 0009,
-- 0010, 0011 and 0012 was a no-op. PostgreSQL grants EXECUTE on a new function
-- to the pseudo-role PUBLIC by default, and anon/authenticated inherit it there.
-- Revoking from the role by name does not touch the grant they are actually
-- using — so every one of those statements reported success and changed nothing.
--
-- Verified against the live project with nothing but the publishable key, i.e.
-- exactly what is sitting in frontend/js/config.js:
--
--   submit_review(...)   -> {"id":26,"updated":false}
--   submit_sighting(...) -> {"id":5}
--   submit_edit(...)     -> {"id":4}
--   submit_truck(...)    -> {"id":12,"promoted":true,"truck_id":14,"appearance_id":19}
--
-- That last one put a truck on the public map from a browser console.
--
-- WHAT IT DEFEATED
-- ----------------
-- These RPCs are SECURITY DEFINER and take p_ip_hash and p_daily_cap as
-- ARGUMENTS. The caller therefore chooses their own identity and their own rate
-- limit. Reaching them directly bypassed, in one fetch:
--   - Cloudflare Turnstile verification
--   - the per-IP daily caps
--   - salted IP hashing (p_ip_hash was simply made up)
--   - every input validation rule in server/handlers.mjs
--
-- The claim in the 0003 header, in 0007, and in README's trust model — "the
-- browser physically cannot write" — was false from 0009 onward. The no-anon-
-- INSERT-policy posture was real and still holds; it just was not the only door.
--
-- THE FIX
-- -------
-- Revoke from PUBLIC (which is what the grant actually is), then grant back an
-- explicit allowlist. Default privileges are changed too, so a function added by
-- a later migration is closed on creation rather than depending on whoever
-- writes it remembering to revoke.
--
-- Owner rights are unaffected: `postgres` owns these functions and always has
-- EXECUTE, so the pg_cron jobs in 0004 keep running.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Close everything in `public`.
--
-- A loop over pg_proc rather than a list of signatures: the list is what failed
-- the first time. Signatures drift (submit_truck has been redefined three times,
-- submit_review twice) and a stale one revokes from a function that no longer
-- exists while the live one stays open.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'          -- plain functions; triggers are not callable
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;

-- Future functions in `public` start closed.
alter default privileges in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 2. Grant back exactly what a browser needs.
--
-- trucks_at() is the map's only read call. The other two are pure, side-effect
-- free scoring helpers that scripts/smoke.mjs asserts against — they leak
-- nothing a caller cannot already read from the appearance row.
-- ---------------------------------------------------------------------------
grant execute on function public.trucks_at(
  timestamptz, double precision, double precision, double precision, double precision,
  numeric, text[]
) to anon, authenticated;

grant execute on function public.appearance_confidence(bigint, timestamptz) to anon, authenticated;
grant execute on function public.confidence_bucket(numeric)                 to anon, authenticated;

-- decay_weight is IMMUTABLE arithmetic over its arguments and reads no table.
-- smoke.mjs calls it to prove the half-life math, not just that it parses.
grant execute on function public.decay_weight(timestamptz, timestamptz, numeric)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The write path keeps working — service_role is what server/handlers.mjs
--    holds, and it is the only role that should reach these.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname in ('submit_review', 'submit_edit', 'submit_truck', 'submit_sighting')
  loop
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

-- pg_cron runs as the function owner, but be explicit so a future job scheduled
-- under service_role does not fail mysteriously.
grant execute on function public.materialize_schedules(integer)      to service_role;
grant execute on function public.expire_appearances()                to service_role;
grant execute on function public.refresh_all_truck_confidence()      to service_role;
grant execute on function public.nightly_maintenance()               to service_role;
grant execute on function public.recompute_truck_confidence(bigint)  to service_role;
grant execute on function public.recompute_truck_rating(bigint)      to service_role;

-- ---------------------------------------------------------------------------
-- 4. Defence in depth: bound materialize_schedules.
--
-- It was reachable above, and `p_days` sizes a generate_series that inserts one
-- appearance row per schedule per day. materialize_schedules(1000000) is a
-- storage bomb from a single anonymous call. EXECUTE is revoked now, so this is
-- belt-and-braces — but an unbounded loop counter taken from an argument should
-- not depend on a grant for its safety.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_schedules(p_days integer default 14)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_n    integer;
  v_days integer := least(greatest(coalesce(p_days, 14), 0), 60);
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
  cross join generate_series(0, v_days) as offs(n)
  where s.active
    and extract(dow from (current_date + offs.n))::smallint = s.day_of_week
    and (current_date + offs.n) >= s.valid_from
    and (s.valid_until is null or (current_date + offs.n) <= s.valid_until)
  on conflict (schedule_id, starts_at) where schedule_id is not null do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.materialize_schedules(integer) from public, anon, authenticated;
grant execute on function public.materialize_schedules(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Remove the rows the audit probe wrote while demonstrating the hole.
--    Identified by the deliberately obvious forged hash it passed in.
-- ---------------------------------------------------------------------------
delete from private.sightings        where ip_hash = 'forged-by-audit';
delete from private.submission_audit where ip_hash = 'forged-by-audit';
