-- ============================================================================
-- 0012 — let exempt addresses post MULTIPLE reviews on one truck.
--
-- The one-review-per-person rule stays exactly as it is for everyone else: a
-- second review from the same author edits the first, the way Google and Yelp
-- work. It is a good rule and this migration does not weaken it.
--
-- The problem it solves is purely local: on a dev machine every request shares
-- one loopback address, so every review is "the same person" and each one
-- silently replaces the last. Testing a review LIST is impossible when the list
-- can never exceed one row.
--
-- WHY NOT JUST SKIP THE AUTHOR ROW
-- private.review_authors carries UNIQUE(truck_id, ip_hash), so a straight second
-- insert violates it. Skipping the author row instead would leave a review with
-- no owner: un-editable forever, and invisible to the one-per-truck rule. So the
-- author hash is made unique per review instead — `<hash>:<review_id>` — which
-- keeps the constraint doing its job, keeps every review owned, and makes the
-- exempted rows obvious in the table.
-- ============================================================================

drop function if exists public.submit_review(
  bigint, smallint, text, text, text, text, integer);

create or replace function public.submit_review(
  p_truck_id       bigint,
  p_rating         smallint,
  p_body           text,
  p_author_name    text,
  p_ip_hash        text,
  p_turnstile_hash text,
  p_daily_cap      integer,
  p_allow_multiple boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare
  v_existing bigint;
  v_used     integer;
  v_id       bigint;
begin
  -- Normal path: find this author's existing review and edit it in place.
  -- Exempt path: skip the lookup entirely so every submission is a new row.
  if not p_allow_multiple then
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

  -- Exempt rows get a per-review author hash so UNIQUE(truck_id, ip_hash) still
  -- holds. Everyone else stores the real hash, which is what enforces the rule.
  insert into private.review_authors (review_id, truck_id, ip_hash)
  values (
    v_id,
    p_truck_id,
    case when p_allow_multiple then p_ip_hash || ':' || v_id::text else p_ip_hash end
  );

  insert into private.submission_audit (kind, entity_id, ip_hash, turnstile_hash)
  values ('review', v_id, p_ip_hash, p_turnstile_hash);

  return jsonb_build_object('id', v_id, 'updated', false);
end;
$$;

revoke execute on function public.submit_review(
  bigint, smallint, text, text, text, text, integer, boolean) from anon, authenticated;
