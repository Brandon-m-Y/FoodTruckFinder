-- ============================================================================
-- 0011 — a submitter is a witness.
--
-- THE BUG
-- A truck promoted from a submission scored 20 (the submission credit alone),
-- landing below the 25 activation floor and reading as `dormant` — "probably
-- out of business" — for a truck someone had just watched serving food.
--
-- THE FIX (and why not simply raise the constant to 25)
-- Bumping the credit would paper over a modelling error. Someone who fills in
-- "this truck is here, at this pin, right now" IS reporting a sighting; that is
-- what a sighting is. The submission was recording the claim without recording
-- the evidence, so every downstream consumer of sightings under-counted it.
--
-- Recording it properly makes the whole model agree by itself:
--   appearance:  plan 35 (crowd) + sighting 20  = 55  -> `likely`, not `scheduled`
--   truck:       submission 20 + crowd-seen 15 + 4 (one distinct day) = 39 -> `active`
--
-- No constant was tuned. The numbers moved because the evidence is now on the
-- books, which is the difference between a fix and a fudge.
-- ============================================================================

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
  p_hours          integer default 3
) returns jsonb
language plpgsql security definer set search_path = public, private, extensions as $$
declare
  v_used   integer;
  v_sub    bigint;
  v_truck  bigint;
  v_appear bigint;
  v_slug   text;
  v_geom   extensions.geometry(Point, 4326);
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

  if p_lat is null or p_lon is null then
    return jsonb_build_object('id', v_sub, 'promoted', false);
  end if;

  v_slug := public.unique_slug(p_name);
  v_geom := extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326);

  insert into public.trucks
    (slug, name, cuisines, description, website, facebook, instagram, phone,
     submission_id, last_verified_at)
  values
    (v_slug, p_name, coalesce(p_cuisines, '{}'), p_description, p_website,
     p_facebook, p_instagram, p_phone, v_sub, now())
  returning id into v_truck;

  insert into public.appearances
    (truck_id, venue_id, geom, starts_at, ends_at, source, asserted_at, status)
  values
    (v_truck, null, v_geom,
     now(), now() + make_interval(hours => greatest(1, least(12, p_hours))),
     'crowd', now(), 'scheduled')
  returning id into v_appear;

  -- The submitter's own report. Same weight and same 45-minute half-life as any
  -- other sighting — no special case, so it decays like everything else and a
  -- drive-by submission cannot prop a phantom pin up indefinitely.
  insert into private.sightings
    (truck_id, appearance_id, kind, geom, ip_hash, turnstile_hash)
  values
    (v_truck, v_appear, 'here', v_geom, p_ip_hash, p_turnstile_hash);

  update public.truck_submissions
     set status = 'applied', promoted_truck_id = v_truck, resolved_at = now()
   where id = v_sub;

  -- Runs AFTER the sighting insert so the crowd-seen component counts it.
  perform public.recompute_truck_confidence(v_truck);

  return jsonb_build_object(
    'id', v_sub, 'promoted', true,
    'truck_id', v_truck, 'appearance_id', v_appear, 'slug', v_slug);
end;
$$;

revoke execute on function public.submit_truck(
  text, text[], text, text, text, text, text, text,
  double precision, double precision, text, text, integer, integer) from anon, authenticated;
