-- ============================================================================
-- 0017 — provenance for imported licence records, and the import RPC.
--
-- First real seed data arrived: 97 mobile food service licences from Warren
-- County Health District, by public records request. Three more districts
-- pending (Butler, Hamilton/Cincinnati, Montgomery).
--
-- WHAT THE EXPORT CONTAINS, AND THE ONE COLUMN WE MUST NOT USE
-- -----------------------------------------------------------
--   RECORD NAME      the truck. This is the whole value of the dataset.
--   CONTACT TYPE     'License Holder' (90 of 97), 'Facility', 'Manager', ...
--   ADDR FULL LINE   *** THE LICENCE HOLDER'S REGISTERED ADDRESS ***
--
-- That last column is not where the truck operates. It is where the business is
-- registered, which for a one-truck operation is almost always the owner's home:
-- 55 of the 97 are residential street addresses — Courts, Lanes, Drives.
--
-- Geocoding them onto the map would be wrong twice over. Factually, because no
-- truck serves lunch in its owner's driveway. And in the way that actually
-- matters, because it would publish the home addresses of ninety-odd small
-- business owners on a public map, sourced from a records request they had no
-- say in. A food truck map is not a reason to do that.
--
-- So the street line is DISCARDED at import and never stored. Town and county
-- are kept: "Lebanon-based" is genuinely useful for judging whether a truck is
-- likely to turn up near you, and a town of 20,000 identifies nobody.
--
-- These rows land 'dormant': licensed and real, but with no evidence of current
-- operation and no location. They become identity records the crowd can then
-- attach sightings to — which is the whole model. A dormant truck has no
-- appearances, so it never appears on the map until someone reports it
-- somewhere.
-- ============================================================================

alter table public.trucks
  add column if not exists data_source text,
  add column if not exists home_city   text,
  add column if not exists home_county text,
  add column if not exists imported_at timestamptz;

comment on column public.trucks.data_source is
  'Provenance, e.g. warren_county_health. Null for crowd submissions.';
comment on column public.trucks.home_city is
  'Town from the licence record. NEVER the street address — see migration 0017.';

create index if not exists trucks_source_ix on public.trucks (data_source)
  where data_source is not null;

-- ---------------------------------------------------------------------------
-- Import one licence record.
--
-- A SECURITY DEFINER RPC rather than an insert from the script, for one
-- specific reason: slug generation must use public.unique_slug so imported
-- slugs match crowd-submitted ones exactly. 0013 revoked EXECUTE on slugify and
-- unique_slug from everyone including service_role, so the importer cannot call
-- them — and reimplementing slugify in JavaScript would be a second definition
-- of "the same name" that is free to drift from the SQL one.
--
-- Idempotent on name: re-running an import, or importing the same truck from two
-- districts (licences are valid statewide, so overlap is expected), updates
-- provenance rather than creating a duplicate.
-- ---------------------------------------------------------------------------
create or replace function public.import_truck(
  p_name        text,
  p_source      text,
  p_home_city   text default null,
  p_home_county text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id      bigint;
  v_slug    text;
  v_created boolean := false;
begin
  if p_name is null or length(btrim(p_name)) < 2 then
    raise exception 'name is required' using errcode = '22023';
  end if;

  select id into v_id from public.trucks where lower(name) = lower(btrim(p_name));

  if v_id is null then
    v_slug := public.unique_slug(public.slugify(p_name));
    insert into public.trucks (slug, name, status, data_source, home_city, home_county, imported_at)
    values (v_slug, btrim(p_name), 'dormant', p_source, p_home_city, p_home_county, now())
    returning id into v_id;
    v_created := true;
  else
    -- Already known — from an earlier run, a crowd submission, or an adjacent
    -- county's list. Record the provenance without touching anything a human or
    -- the crowd may have curated since.
    update public.trucks
       set data_source = coalesce(data_source, p_source),
           home_city   = coalesce(home_city, p_home_city),
           home_county = coalesce(home_county, p_home_county),
           imported_at = coalesce(imported_at, now()),
           updated_at  = now()
     where id = v_id
    returning slug into v_slug;
  end if;

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'created', v_created);
end;
$$;

revoke all on function public.import_truck(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.import_truck(text, text, text, text) to service_role;
