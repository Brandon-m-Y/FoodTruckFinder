-- ============================================================================
-- 0019 — repair materialize_schedules. 0018 rebuilt it from the WRONG ANCESTOR.
--
-- 0018 needed to change one join condition in materialize_schedules, and did it
-- by pasting the function body from 0004 and editing that. But 0004's body had
-- been superseded twice, and `create or replace function` takes whatever it is
-- given: both later fixes were silently reverted.
--
--   LOST FROM 0005 — the ON CONFLICT index predicate.
--     appearances_schedule_slot_uq is PARTIAL (`where schedule_id is not null`).
--     Postgres will not resolve a bare `on conflict (schedule_id, starts_at)` to
--     a partial index unless the predicate is repeated, so EVERY call raised
--     42P10 and inserted nothing. This is the identical failure 0005 exists to
--     fix — reintroduced by copying the file that predates it.
--
--   LOST FROM 0013 — the p_days clamp.
--     p_days sizes a generate_series that emits one appearance per schedule per
--     day. Unclamped, materialize_schedules(1000000) is a storage bomb. EXECUTE
--     is revoked from everyone but service_role, so the clamp is defence in
--     depth — but an unbounded loop counter taken from an argument should not
--     rely on a grant for its safety, which is exactly why 0013 added it.
--
-- The first was caught within minutes because curate_truck() calls this and the
-- verification run failed loudly. The second is silent and would not have
-- surfaced on its own. Both are the same underlying mistake: a `create or
-- replace` of a function that has a history, written against its first version
-- rather than its current one.
--
-- This definition carries forward everything: the 0005 predicate, the 0013
-- clamp, and 0018's status change.
-- ============================================================================

create or replace function public.materialize_schedules(p_days integer default 14)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_n    integer;
  -- 0013. Bounded regardless of caller.
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
  -- 0018. Was `t.status = 'active'`, which let the nightly confidence sweep
  -- switch the materializer off for every truck in the database.
  join public.trucks t on t.id = s.truck_id and t.status not in ('hidden', 'closed')
  cross join generate_series(0, v_days) as offs(n)
  where s.active
    and extract(dow from (current_date + offs.n))::smallint = s.day_of_week
    and (current_date + offs.n) >= s.valid_from
    and (s.valid_until is null or (current_date + offs.n) <= s.valid_until)
  -- 0005. This `where` is the INDEX PREDICATE, not a row filter — it is what
  -- lets Postgres resolve the inference to the partial unique index.
  on conflict (schedule_id, starts_at) where schedule_id is not null do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Restating 0013's lockdown. `create or replace` of an EXISTING function keeps
-- its ACL — only a genuinely new function picks up the default grant, and 0013
-- also cleared that default for this schema — so this should already hold. It is
-- asserted rather than assumed because the cost of being wrong is an anonymously
-- callable writer, and the cost of being right is two redundant statements.
revoke all on function public.materialize_schedules(integer) from public, anon, authenticated;
grant execute on function public.materialize_schedules(integer) to service_role;
