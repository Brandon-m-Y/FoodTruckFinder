-- ============================================================================
-- 0003 — Row Level Security + grants
--
-- Two-tier trust model:
--
--   OPERATORS  authenticate via Supabase Auth, claim a truck (trucks.owner_id),
--              and write their own appearances directly through PostgREST.
--              RLS scopes them to their own truck. No custom auth code.
--
--   THE CROWD  is anonymous — no accounts, ever. There is deliberately NO anon
--              INSERT policy on any table. The only anonymous write path is an
--              Edge Function holding the service_role key, which verifies a
--              Cloudflare Turnstile token and applies a per-IP cooldown before
--              it writes. Absence of a policy is the enforcement; the Edge
--              Function bypasses RLS by virtue of service_role.
-- ============================================================================

alter table public.trucks      enable row level security;
alter table public.venues      enable row level security;
alter table public.schedules   enable row level security;
alter table public.appearances enable row level security;
alter table public.cuisines    enable row level security;

-- ---------------------------------------------------------------------------
-- Public reads
-- ---------------------------------------------------------------------------

create policy trucks_public_read on public.trucks
  for select to anon, authenticated
  using (status <> 'hidden');

create policy venues_public_read on public.venues
  for select to anon, authenticated using (true);

create policy cuisines_public_read on public.cuisines
  for select to anon, authenticated using (true);

create policy schedules_public_read on public.schedules
  for select to anon, authenticated using (active);

create policy appearances_public_read on public.appearances
  for select to anon, authenticated
  using (
    status <> 'cancelled'
    and exists (select 1 from public.trucks t
                 where t.id = truck_id and t.status <> 'hidden')
  );

-- ---------------------------------------------------------------------------
-- Operator writes — scoped to the truck they own
-- ---------------------------------------------------------------------------

create policy trucks_owner_update on public.trucks
  for update to authenticated
  using      (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy appearances_owner_insert on public.appearances
  for insert to authenticated
  with check (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())));

create policy appearances_owner_update on public.appearances
  for update to authenticated
  using      (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())));

create policy schedules_owner_all on public.schedules
  for all to authenticated
  using      (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())));

-- An operator may not silently rewrite provenance: anything they insert is
-- 'operator'-sourced, asserted now. Enforced in a trigger rather than a CHECK
-- because it must overwrite, not merely reject.
create or replace function public.stamp_operator_appearance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select auth.uid()) is not null
     and exists (select 1 from public.trucks t
                  where t.id = new.truck_id and t.owner_id = (select auth.uid())) then
    new.source      := 'operator';
    new.asserted_at := now();
    new.created_by  := (select auth.uid());
  end if;
  return new;
end;
$$;

create trigger appearances_stamp_operator
  before insert on public.appearances
  for each row execute function public.stamp_operator_appearance();

-- ---------------------------------------------------------------------------
-- Lock down the private schema. PostgREST does not expose it, but revoke
-- anyway — defence in depth against a future `expose_schemas` change.
-- ---------------------------------------------------------------------------

revoke all on schema private from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
alter default privileges in schema private revoke all on tables from anon, authenticated;

-- The map's only read path into sighting data.
grant execute on function public.trucks_at(
  timestamptz, double precision, double precision, double precision, double precision,
  numeric, text[]
) to anon, authenticated;

-- Keep the confidence internals callable for debugging/tests but harmless.
grant execute on function public.appearance_confidence(bigint, timestamptz) to anon, authenticated;
grant execute on function public.confidence_bucket(numeric)                 to anon, authenticated;

-- recompute_truck_confidence mutates — service_role / cron only.
revoke execute on function public.recompute_truck_confidence(bigint) from anon, authenticated;
