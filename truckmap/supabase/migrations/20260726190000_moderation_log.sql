-- ============================================================================
-- 0015 — forward-fix for 0014, plus a real moderation audit trail.
--
-- TWO THINGS 0014 GOT WRONG
--
-- 1. THE COLUMN REVOKES WERE NO-OPS.
--    `revoke select (created_by) on public.appearances from anon` does nothing
--    when anon already holds SELECT on the WHOLE table: the table-level
--    privilege still permits every column, and Postgres reports success either
--    way. Verified against the live project — created_by and moderation_note
--    were all still readable by the publishable key after 0014 applied.
--
--    Exactly the same class of mistake as the EXECUTE grants in 0013: a
--    privilege statement that names a role which is not where the permission is
--    actually coming from. The correct form is to revoke the table privilege
--    and grant back the columns you want.
--
-- 2. moderation_note DID NOT BELONG IN A PUBLIC TABLE.
--    A moderation note routinely quotes the abuse it is about, so it is the
--    last thing that should sit one forgotten grant away from being served.
--    Keeping it public-adjacent also meant enumerating every column of `trucks`
--    and `reviews` in a grant, which breaks silently the next time either table
--    gains a column.
--
--    It moves to private.moderation_log, which PostgREST does not expose at all
--    — the same posture as sightings and ip_hashes. That also turns one
--    overwritable field into an append-only history, which is what you actually
--    want when someone asks why their listing disappeared three weeks ago.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Undo the note columns. moderated_at stays: a bare timestamp reveals
--    nothing, and it is genuinely useful on the public row.
-- ---------------------------------------------------------------------------
alter table public.trucks  drop column if exists moderation_note;
alter table public.reviews drop column if exists moderation_note;

-- ---------------------------------------------------------------------------
-- 2. Hide appearances.created_by the way that actually works.
--
-- Columns are enumerated, so a column added later is NOT exposed until someone
-- adds it here. That is the fail-safe direction: a new column defaults to
-- private rather than to public.
-- ---------------------------------------------------------------------------
revoke select on public.appearances from anon, authenticated;

grant select (
  id, truck_id, venue_id, geom, starts_at, ends_at,
  source, asserted_at, schedule_id, status, note, created_at
) on public.appearances to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The audit trail.
-- ---------------------------------------------------------------------------
create table if not exists private.moderation_log (
  id          bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('truck', 'review', 'edit', 'submission')),
  entity_id   bigint not null,
  action      text not null check (action in ('hide', 'show', 'reject', 'approve')),
  reason      text,
  -- Free text, not a FK to auth.users: there are no moderator accounts yet, and
  -- "who ran the script" is still worth recording. Becomes a real reference when
  -- the operator flow lands.
  actor       text,
  created_at  timestamptz not null default now()
);

create index if not exists moderation_log_entity_ix
  on private.moderation_log (entity_type, entity_id, created_at desc);

revoke all on private.moderation_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Moderation RPCs.
--
-- service_role bypasses RLS but NOT PostgREST schema exposure, so `private` is
-- unreachable from the CLI directly — the same wall migration 0009 hit. These
-- are the door, and they make each action atomic: the status flip and the log
-- entry land together or not at all. A takedown with no recorded reason is the
-- failure mode this exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.moderate_truck(
  p_truck_id bigint,
  p_hide     boolean,
  p_reason   text default null,
  p_actor    text default null
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v_name text;
begin
  -- Restoring sets 'active' rather than the previous status: the old value is
  -- not recorded anywhere, and 'active' is the only one that puts a truck back
  -- on the map, which is the entire point of un-hiding it.
  update public.trucks
     set status = case when p_hide then 'hidden'::truck_status else 'active'::truck_status end,
         moderated_at = case when p_hide then now() else null end,
         updated_at = now()
   where id = p_truck_id
  returning name into v_name;

  if v_name is null then
    raise exception 'no truck with id %', p_truck_id using errcode = 'P0002';
  end if;

  insert into private.moderation_log (entity_type, entity_id, action, reason, actor)
  values ('truck', p_truck_id, case when p_hide then 'hide' else 'show' end, p_reason, p_actor);

  return jsonb_build_object('id', p_truck_id, 'name', v_name, 'hidden', p_hide);
end;
$$;

create or replace function public.moderate_review(
  p_review_id bigint,
  p_hide      boolean,
  p_reason    text default null,
  p_actor     text default null
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v_truck_id bigint;
begin
  update public.reviews
     set status = case when p_hide then 'hidden'::review_status else 'visible'::review_status end,
         moderated_at = case when p_hide then now() else null end,
         updated_at = now()
   where id = p_review_id
  returning truck_id into v_truck_id;

  if v_truck_id is null then
    raise exception 'no review with id %', p_review_id using errcode = 'P0002';
  end if;

  insert into private.moderation_log (entity_type, entity_id, action, reason, actor)
  values ('review', p_review_id, case when p_hide then 'hide' else 'show' end, p_reason, p_actor);

  -- reviews_after_write recomputes the aggregate over visible rows only, so the
  -- truck's average has already corrected itself. Return it so the caller can
  -- report what happened instead of asserting it.
  return (
    select jsonb_build_object('id', p_review_id, 'truck_id', v_truck_id, 'hidden', p_hide,
                              'rating_avg', t.rating_avg, 'rating_count', t.rating_count)
      from public.trucks t where t.id = v_truck_id
  );
end;
$$;

create or replace function public.moderate_resolve(
  p_kind   text,      -- 'edit' | 'submission'
  p_id     bigint,
  p_reject boolean default true,
  p_actor  text default null
) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare v_status public.contribution_status;
begin
  v_status := case when p_reject then 'rejected' else 'applied' end;

  if p_kind = 'edit' then
    update public.truck_edits set status = v_status, resolved_at = now() where id = p_id;
  elsif p_kind = 'submission' then
    update public.truck_submissions set status = v_status, resolved_at = now() where id = p_id;
  else
    raise exception 'unknown kind %, expected edit or submission', p_kind using errcode = '22023';
  end if;

  if not found then
    raise exception 'no % with id %', p_kind, p_id using errcode = 'P0002';
  end if;

  insert into private.moderation_log (entity_type, entity_id, action, reason, actor)
  values (p_kind, p_id, case when p_reject then 'reject' else 'approve' end, null, p_actor);

  return jsonb_build_object('kind', p_kind, 'id', p_id, 'status', v_status);
end;
$$;

/** History for one entity, so the CLI can answer "why is this hidden?". */
create or replace function public.moderation_history(
  p_entity_type text default null,
  p_entity_id   bigint default null,
  p_limit       integer default 50
) returns table (
  id bigint, entity_type text, entity_id bigint,
  action text, reason text, actor text, created_at timestamptz
)
language sql security definer set search_path = public, private as $$
  select m.id, m.entity_type, m.entity_id, m.action, m.reason, m.actor, m.created_at
    from private.moderation_log m
   where (p_entity_type is null or m.entity_type = p_entity_type)
     and (p_entity_id   is null or m.entity_id   = p_entity_id)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- ---------------------------------------------------------------------------
-- 5. Lock them down. Revoke from PUBLIC, not just anon/authenticated — that is
--    the bug 0013 existed to fix, and it applies to every function added since.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('moderate_truck', 'moderate_review', 'moderate_resolve',
                         'moderation_history')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
