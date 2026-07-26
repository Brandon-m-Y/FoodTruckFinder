-- ============================================================================
-- 0010 — a submitted truck with a location now appears on the map.
--
-- Before this, submit_truck() wrote a row to truck_submissions and stopped.
-- Nothing promoted it, so a contributor filled in a form and saw no effect —
-- the worst possible outcome for a crowd-sourced project.
--
-- THE RULE
--   location given  -> promote immediately: create the truck, create a 'crowd'
--                      appearance, mark the submission 'applied'.
--   no location     -> stays 'pending'. There is nothing to put on a map.
--
-- WHY IMMEDIATE PROMOTION IS SAFE-ISH
-- The confidence model already handles low-trust data — that is what it is for.
-- A 'crowd' appearance scores plan_weight 35, landing in the `scheduled` bucket:
-- visible, pale, and visibly unconfirmed. It rises only when real people report
-- "it's here" (+20 each, 45-minute half-life) and falls when they report
-- otherwise. An unattended bogus pin decays into irrelevance on its own.
--
-- This is NOT a substitute for moderation. It bounds the damage; it does not
-- prevent it. See the SPAM note in migration 0007.
-- ============================================================================

-- Provenance: which submission produced this truck. Also feeds confidence below.
alter table public.trucks
  add column submission_id bigint references public.truck_submissions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Slug generation. trucks.slug has a strict format CHECK and a unique index,
-- so a name like "Café Ortiz & Sons!!" has to become "cafe-ortiz-sons" — and
-- then dodge a collision if that already exists.
-- ---------------------------------------------------------------------------
-- Defined BEFORE slugify, which calls it: Postgres validates SQL function
-- bodies at CREATE time, so a forward reference fails outright.
--
-- unaccent isn't enabled (another extension for one job). Fold the Latin-1
-- letters local business names actually use — "Café Ortiz" must not become
-- "caf-ortiz". Anything else falls through to the [^a-z0-9] scrub and hyphenates.
create or replace function public.unaccent_fallback(p_text text)
returns text language sql immutable as $$
  select translate(
    coalesce(p_text, ''),
    'àáâãäåèéêëìíîïòóôõöùúûüñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÑÇ',
    'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC');
$$;

create or replace function public.slugify(p_text text)
returns text language sql immutable as $$
  select coalesce(
    nullif(
      trim(both '-' from
        regexp_replace(
          regexp_replace(lower(public.unaccent_fallback(p_text)), '[^a-z0-9]+', '-', 'g'),
          '-+', '-', 'g')),
      ''),
    'truck');
$$;

create or replace function public.unique_slug(p_base text)
returns text language plpgsql as $$
declare v_slug text; v_n integer := 1;
begin
  v_slug := public.slugify(p_base);
  while exists (select 1 from public.trucks where lower(slug) = lower(v_slug)) loop
    v_n := v_n + 1;
    v_slug := public.slugify(p_base) || '-' || v_n;
  end loop;
  return v_slug;
end;
$$;

-- ---------------------------------------------------------------------------
-- Community-submitted trucks get a small existence credit, so a freshly
-- promoted truck is not immediately marked 'dormant' by the nightly sweep for
-- having no licence, no owner, and no sightings yet.
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
                    when status in ('hidden', 'closed') then status
                    when v_gone >= 3 and v_conf < 25 then 'dormant'::public.truck_status
                    when v_conf >= 25 then 'active'::public.truck_status
                    else 'dormant'::public.truck_status
                  end,
         updated_at = now()
   where id = p_truck_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- submit_truck, now with promotion.
-- ---------------------------------------------------------------------------
drop function if exists public.submit_truck(
  text, text[], text, text, text, text, text, text,
  double precision, double precision, text, text, integer);

create or replace function public.submit_truck(
  p_name           text,
  p_cuisines       text[],
  p_description    text,
  p_where_note     text,
  p_website        text,
  p_facebook       text,
  p_instagram      text,
  p_phone          text,
  p_lat            double precision,
  p_lon            double precision,
  p_ip_hash        text,
  p_turnstile_hash text,
  p_daily_cap      integer,
  p_hours          integer default 3   -- how long the stop is assumed to last
) returns jsonb
language plpgsql security definer set search_path = public, private, extensions as $$
declare
  v_used   integer;
  v_sub    bigint;
  v_truck  bigint;
  v_appear bigint;
  v_slug   text;
begin
  select count(*) into v_used
    from private.submission_audit
   where kind = 'submission' and ip_hash = p_ip_hash
     and created_at > now() - interval '24 hours';
  if v_used >= p_daily_cap then
    raise exception 'daily submission limit reached' using errcode = 'TM429';
  end if;

  insert into public.truck_submissions
    (name, cuisines, description, where_note, website, facebook, instagram, phone, lat, lon)
  values
    (p_name, p_cuisines, p_description, p_where_note, p_website, p_facebook,
     p_instagram, p_phone, p_lat, p_lon)
  returning id into v_sub;

  insert into private.submission_audit (kind, entity_id, ip_hash, turnstile_hash)
  values ('submission', v_sub, p_ip_hash, p_turnstile_hash);

  -- No coordinates -> nothing to map. Leave it queued for a human.
  if p_lat is null or p_lon is null then
    return jsonb_build_object('id', v_sub, 'promoted', false);
  end if;

  v_slug := public.unique_slug(p_name);

  insert into public.trucks
    (slug, name, cuisines, description, website, facebook, instagram, phone,
     submission_id, last_verified_at)
  values
    (v_slug, p_name, coalesce(p_cuisines, '{}'), p_description, p_website,
     p_facebook, p_instagram, p_phone, v_sub, now())
  returning id into v_truck;

  -- An ad-hoc stop: no venue row, geom carried on the appearance itself.
  insert into public.appearances
    (truck_id, venue_id, geom, starts_at, ends_at, source, asserted_at, status)
  values
    (v_truck, null,
     extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326),
     now(), now() + make_interval(hours => greatest(1, least(12, p_hours))),
     'crowd', now(), 'scheduled')
  returning id into v_appear;

  update public.truck_submissions
     set status = 'applied', promoted_truck_id = v_truck, resolved_at = now()
   where id = v_sub;

  perform public.recompute_truck_confidence(v_truck);

  return jsonb_build_object(
    'id', v_sub, 'promoted', true,
    'truck_id', v_truck, 'appearance_id', v_appear, 'slug', v_slug);
end;
$$;

revoke execute on function public.submit_truck(
  text, text[], text, text, text, text, text, text,
  double precision, double precision, text, text, integer, integer) from anon, authenticated;
