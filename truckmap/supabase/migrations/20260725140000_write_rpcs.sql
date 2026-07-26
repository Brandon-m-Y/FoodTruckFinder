-- ============================================================================
-- 0009 — server-side write RPCs.
--
-- WHY THIS EXISTS
-- ---------------
-- The write handlers originally reached into `private` directly with the
-- service_role key, on the assumption that service_role bypasses everything.
-- It does not. service_role bypasses ROW LEVEL SECURITY; it does not bypass
-- PostgREST SCHEMA EXPOSURE. `private` is deliberately not in the exposed
-- schema list, so `db.schema("private")` fails for every caller, secret key or
-- not — which is exactly the guarantee we wanted, just applied more broadly
-- than expected.
--
-- The fix is not to expose `private`. It is to reach it through SECURITY
-- DEFINER functions that live in `public`, are the only door in, and are
-- EXECUTE-revoked from anon and authenticated.
--
-- Bonus: each write becomes ONE ATOMIC STATEMENT instead of three REST round
-- trips. The old code inserted a review, then its author row, then an audit
-- row, with a hand-rolled compensating DELETE if the second failed. That whole
-- failure mode disappears inside a transaction.
--
-- Custom SQLSTATE 'TM429' signals a rate-limit refusal to the caller.
-- ============================================================================

-- --- reviews ----------------------------------------------------------------
create or replace function public.submit_review(
  p_truck_id       bigint,
  p_rating         smallint,
  p_body           text,
  p_author_name    text,
  p_ip_hash        text,
  p_turnstile_hash text,
  p_daily_cap      integer
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare
  v_existing bigint;
  v_used     integer;
  v_id       bigint;
begin
  -- One review per (truck, author). A second submission edits the first.
  select review_id into v_existing
    from private.review_authors
   where truck_id = p_truck_id and ip_hash = p_ip_hash;

  if v_existing is not null then
    update public.reviews
       set rating = p_rating, body = p_body,
           author_name = p_author_name, updated_at = now()
     where id = v_existing;
    return jsonb_build_object('id', v_existing, 'updated', true);
  end if;

  select count(*) into v_used
    from private.submission_audit
   where kind = 'review' and ip_hash = p_ip_hash
     and created_at > now() - interval '24 hours';
  if v_used >= p_daily_cap then
    raise exception 'daily review limit reached' using errcode = 'TM429';
  end if;

  insert into public.reviews (truck_id, rating, body, author_name)
  values (p_truck_id, p_rating, p_body, p_author_name)
  returning id into v_id;

  insert into private.review_authors (review_id, truck_id, ip_hash)
  values (v_id, p_truck_id, p_ip_hash);

  insert into private.submission_audit (kind, entity_id, ip_hash, turnstile_hash)
  values ('review', v_id, p_ip_hash, p_turnstile_hash);

  return jsonb_build_object('id', v_id, 'updated', false);
end;
$$;

-- --- description / detail edits ---------------------------------------------
create or replace function public.submit_edit(
  p_truck_id       bigint,
  p_field          text,
  p_value          text,
  p_note           text,
  p_ip_hash        text,
  p_turnstile_hash text,
  p_daily_cap      integer
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v_used integer; v_id bigint;
begin
  select count(*) into v_used
    from private.submission_audit
   where kind = 'edit' and ip_hash = p_ip_hash
     and created_at > now() - interval '24 hours';
  if v_used >= p_daily_cap then
    raise exception 'daily edit limit reached' using errcode = 'TM429';
  end if;

  insert into public.truck_edits (truck_id, field, value, note)
  values (p_truck_id, p_field, p_value, p_note)
  returning id into v_id;

  insert into private.submission_audit (kind, entity_id, ip_hash, turnstile_hash)
  values ('edit', v_id, p_ip_hash, p_turnstile_hash);

  return jsonb_build_object('id', v_id);
end;
$$;

-- --- new-truck submissions ---------------------------------------------------
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
  p_daily_cap      integer
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v_used integer; v_id bigint;
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
  returning id into v_id;

  insert into private.submission_audit (kind, entity_id, ip_hash, turnstile_hash)
  values ('submission', v_id, p_ip_hash, p_turnstile_hash);

  return jsonb_build_object('id', v_id);
end;
$$;

-- --- sightings ---------------------------------------------------------------
create or replace function public.submit_sighting(
  p_truck_id       bigint,
  p_appearance_id  bigint,
  p_kind           text,
  p_lat            double precision,
  p_lon            double precision,
  p_ip_hash        text,
  p_turnstile_hash text,
  p_daily_cap      integer
) returns jsonb
language plpgsql security definer set search_path = public, private, extensions as $$
declare v_used integer; v_id bigint;
begin
  select count(*) into v_used
    from private.submission_audit
   where kind = 'sighting' and ip_hash = p_ip_hash
     and created_at > now() - interval '24 hours';
  if v_used >= p_daily_cap then
    raise exception 'daily sighting limit reached' using errcode = 'TM429';
  end if;

  -- sightings_one_per_hour_uq raises 23505 on a repeat report; the caller maps
  -- that to a friendly 429 rather than a 500.
  insert into private.sightings (truck_id, appearance_id, kind, geom, ip_hash, turnstile_hash)
  values (
    p_truck_id, p_appearance_id, p_kind::public.sighting_kind,
    extensions.ST_SetSRID(extensions.ST_MakePoint(p_lon, p_lat), 4326),
    p_ip_hash, p_turnstile_hash
  )
  returning id into v_id;

  insert into private.submission_audit (kind, entity_id, ip_hash, turnstile_hash)
  values ('sighting', v_id, p_ip_hash, p_turnstile_hash);

  return jsonb_build_object('id', v_id);
end;
$$;

-- These are the ONLY door into `private`, and only the server may open it.
revoke execute on function public.submit_review(bigint, smallint, text, text, text, text, integer) from anon, authenticated;
revoke execute on function public.submit_edit(bigint, text, text, text, text, text, integer) from anon, authenticated;
revoke execute on function public.submit_truck(text, text[], text, text, text, text, text, text, double precision, double precision, text, text, integer) from anon, authenticated;
revoke execute on function public.submit_sighting(bigint, bigint, text, double precision, double precision, text, text, integer) from anon, authenticated;
