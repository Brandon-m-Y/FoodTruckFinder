-- ============================================================================
-- 0014 — stop serving un-reviewed and rejected user content.
--
-- Migration 0007 made the contribution queues publicly readable so "the
-- community can see what is queued". Reasonable intent, wrong result: the two
-- policies it wrote expose precisely the content that has NOT been vetted, and
-- keep serving content a moderator has actively refused.
--
--   truck_submissions   using (status = 'pending')
--     'pending' means NOBODY HAS LOOKED AT THIS YET. So the un-vetted rows were
--     public and the approved ones were hidden — inverted with respect to risk.
--     Anyone could POST free-text name / description / phone / website /
--     facebook and read it straight back from /rest/v1/truck_submissions. It
--     never rendered on the map without a pin, which is presumably why it read
--     as harmless, but PostgREST served it to anyone who asked. Three per IP per
--     day, no review, permanent: a spam publishing channel that merely lacked a
--     UI.
--
--   truck_edits        using (true)
--     Every status, including 'rejected'. A rejected edit is by definition the
--     content someone decided not to publish, and it stayed publicly readable.
--
-- Neither is read by the browser. api.js touches trucks, cuisines, reviews and
-- truck_edits — and its truck_edits query already filters to status='pending'
-- itself, so tightening the policy to match costs nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. truck_submissions: no anonymous read at all.
--
-- Not "only show applied ones" — an applied submission has already been
-- promoted into public.trucks, so the map shows it and the queue row is
-- redundant. There is no reader for this table that is not a moderator, and
-- moderators use the service_role key. A policy that grants nothing to anon is
-- the honest description of that.
-- ---------------------------------------------------------------------------
drop policy if exists truck_submissions_public_read on public.truck_submissions;

-- ---------------------------------------------------------------------------
-- 2. truck_edits: pending only.
--
-- Keeps the original intent — you can see what has been proposed for a truck —
-- while dropping 'rejected' and 'applied'. Applied edits are visible as the
-- truck's actual fields; rejected ones should not be reachable at all.
-- ---------------------------------------------------------------------------
drop policy if exists truck_edits_public_read on public.truck_edits;

create policy truck_edits_public_read on public.truck_edits
  for select to anon, authenticated
  using (status = 'pending');

-- ---------------------------------------------------------------------------
-- 3. appearances.created_by is an auth.users id. Nothing needs it publicly.
--
-- A column-level revoke rather than a narrower policy, because the leak is one
-- column and the rest of the row is genuinely public data.
--
-- CAVEAT, and the reason 0007 rejected this approach for reviews.ip_hash:
-- `select *` as anon will now FAIL on this table rather than silently omitting
-- the column. Nothing does that today — the map reads through trucks_at(), and
-- smoke.mjs asks for `id` — but code added later must name its columns.
-- ---------------------------------------------------------------------------
revoke select (created_by) on public.appearances from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Moderation support: record WHY something was hidden.
--
-- trucks.status already supports 'hidden' and every read path honours it —
-- trucks_public_read, the appearances policy, and trucks_at() all exclude it —
-- so one flip is a complete takedown. What was missing is any record of who did
-- it and why, which is the part you need when someone asks a week later.
-- ---------------------------------------------------------------------------
alter table public.trucks
  add column if not exists moderation_note text,
  add column if not exists moderated_at    timestamptz;

alter table public.reviews
  add column if not exists moderation_note text,
  add column if not exists moderated_at    timestamptz;

-- The note is internal. Revoke rather than rely on nobody selecting it: a
-- moderation note routinely quotes the abuse it is about.
revoke select (moderation_note) on public.trucks  from anon, authenticated;
revoke select (moderation_note) on public.reviews from anon, authenticated;

comment on column public.trucks.moderation_note is
  'Internal. Why this truck was hidden. Never exposed to anon.';
comment on column public.reviews.moderation_note is
  'Internal. Why this review was hidden. Never exposed to anon.';
