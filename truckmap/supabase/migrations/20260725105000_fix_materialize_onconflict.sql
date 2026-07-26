-- ============================================================================
-- Fix: materialize_schedules() could never insert a row.
--
-- appearances_schedule_slot_uq (0001) is a PARTIAL unique index:
--
--   create unique index appearances_schedule_slot_uq
--     on public.appearances (schedule_id, starts_at) where schedule_id is not null;
--
-- 0004 inferred it with a bare `on conflict (schedule_id, starts_at)`. Postgres
-- will not match an inference specification to a partial index unless the
-- index's WHERE predicate is repeated in the ON CONFLICT clause, so every call
-- failed with:
--
--   42P10: there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- Caught by the first real push, not by the parser — it is a catalog-resolution
-- error, syntactically valid either way.
--
-- Fixed forward (0004 is already applied; `db push` tracks by version and will
-- never re-run it) rather than by editing the shipped file.
-- ============================================================================

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
  -- The `where` below is the INDEX PREDICATE, not a row filter. It is what lets
  -- Postgres resolve the inference to the partial index above.
  on conflict (schedule_id, starts_at) where schedule_id is not null do nothing;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
