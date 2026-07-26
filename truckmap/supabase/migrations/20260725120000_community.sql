-- ============================================================================
-- 0007 — community contributions: reviews, description edits, new-truck
--        submissions.
--
-- WHY THESE ARE NOT SIGHTINGS
-- ---------------------------
-- private.sightings answers "is it there RIGHT NOW" — an ephemeral fact with a
-- 45-minute half-life that feeds appearance confidence. Reviews answer "is the
-- food good" — a durable opinion that accumulates and never decays. Conflating
-- them would mean either decaying reviews (wrong) or persisting sightings
-- (wrong). Separate tables, separate lifecycles.
--
-- ⚠ SPAM IS NOT SOLVED. reviews.status defaults to 'visible', so anything that
--   reaches this table is publicly readable immediately. That is a deliberate,
--   temporary choice: defaulting to 'pending' would make the feature inert
--   because there is no moderator. The mitigations that make this safe are NOT
--   built yet:
--     - Cloudflare Turnstile on every write            (todo)
--     - per-IP cooldown via private.submission_audit   (table exists, unused)
--     - a moderation queue + operator takedown         (todo)
--   Until they exist, the ONLY thing standing between this table and abuse is
--   that no anonymous INSERT policy is granted — every write must go through
--   the server-side handler holding the secret key. Do not add an anon INSERT
--   policy to these tables as a shortcut.
-- ============================================================================

create type public.review_status as enum ('visible', 'pending', 'hidden');

-- Shared lifecycle for anything proposed and then adopted or refused.
create type public.contribution_status as enum ('pending', 'applied', 'rejected');

-- ---------------------------------------------------------------------------
-- reviews — one star rating, optional prose. Attached to the TRUCK, not the
-- appearance: you are reviewing the food, not the parking spot it was in.
--
-- Note what is NOT here: no ip_hash. Reviews must be publicly readable, and a
-- column-level revoke would make `select *` fail rather than omit the column.
-- Author identity lives in private.review_authors instead, unreachable from
-- PostgREST entirely.
-- ---------------------------------------------------------------------------
create table public.reviews (
  id          bigint generated always as identity primary key,
  truck_id    bigint not null references public.trucks(id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  body        text     check (body is null or char_length(body) between 2 and 2000),
  -- Optional display name. Free text, so it is a spam surface; length-capped.
  author_name text     check (author_name is null or char_length(author_name) between 1 and 40),
  status      public.review_status not null default 'visible',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index reviews_truck_ix on public.reviews (truck_id, created_at desc)
  where status = 'visible';

create table private.review_authors (
  review_id   bigint primary key references public.reviews(id) on delete cascade,
  -- Denormalized from the review so the one-per-truck rule is a plain UNIQUE.
  truck_id    bigint not null references public.trucks(id) on delete cascade,
  ip_hash     text   not null,
  reporter_id uuid   references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),

  -- One review per author per truck. Editing updates in place rather than
  -- stacking. Blunt for shared IPs (a household gets one), but without accounts
  -- it is the only handle we have — same tradeoff the sighting cooldown makes.
  constraint uq_review_per_truck unique (truck_id, ip_hash)
);

-- --- denormalized aggregate, trigger-maintained ------------------------------
alter table public.trucks
  add column rating_avg   numeric(3,2),
  add column rating_count integer not null default 0;

create or replace function public.recompute_truck_rating(p_truck_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.trucks t
     set rating_avg = sub.avg_rating,
         rating_count = sub.n,
         updated_at = now()
    from (
      select round(avg(rating)::numeric, 2) as avg_rating, count(*)::integer as n
      from public.reviews
      where truck_id = p_truck_id and status = 'visible'
    ) sub
   where t.id = p_truck_id;
end;
$$;

create or replace function public.trg_review_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_truck_id bigint;
begin
  -- TG_OP branch, not COALESCE(new.x, old.x): NEW is unassigned in a DELETE
  -- trigger and touching a field on it raises in PL/pgSQL.
  if tg_op = 'DELETE' then v_truck_id := old.truck_id;
  else                     v_truck_id := new.truck_id;
  end if;
  perform public.recompute_truck_rating(v_truck_id);

  -- An UPDATE that moves a review to another truck must re-score both.
  if tg_op = 'UPDATE' and old.truck_id is distinct from new.truck_id then
    perform public.recompute_truck_rating(old.truck_id);
  end if;
  return null;
end;
$$;

create trigger reviews_after_write
  after insert or update or delete on public.reviews
  for each row execute function public.trg_review_write();

-- ---------------------------------------------------------------------------
-- truck_edits — proposed changes to a truck's descriptive fields.
--
-- One generic (field, value) table rather than a column per field: adding
-- "menu_url" later becomes a CHECK change, not a schema migration plus new
-- write path plus new UI branch.
--
-- Everything lands 'pending'. Nothing auto-applies — that decision needs the
-- spam story first.
-- ---------------------------------------------------------------------------
create table public.truck_edits (
  id          bigint generated always as identity primary key,
  truck_id    bigint not null references public.trucks(id) on delete cascade,
  field       text   not null check (field in
                ('description', 'website', 'facebook', 'instagram', 'phone', 'cuisines')),
  value       text   not null check (char_length(value) between 1 and 2000),
  note        text   check (note is null or char_length(note) <= 500),
  status      public.contribution_status not null default 'pending',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null
);

create index truck_edits_open_ix on public.truck_edits (truck_id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- truck_submissions — "you're missing a truck". Intake queue; a human (or the
-- CSV importer reconciling against license data) promotes these into `trucks`.
-- Never writes public.trucks directly — same posture as OpenDrop's
-- pending_locations.
-- ---------------------------------------------------------------------------
create table public.truck_submissions (
  id           bigint generated always as identity primary key,
  name         text not null check (char_length(name) between 2 and 120),
  cuisines     text[] not null default '{}',
  description  text check (description is null or char_length(description) <= 2000),
  website      text,
  facebook     text,
  instagram    text,
  phone        text,
  -- Optional "and I saw it here" hint. Not a venue reference — the submitter
  -- may be describing somewhere we have no row for yet.
  lat          double precision check (lat is null or lat between -90 and 90),
  lon          double precision check (lon is null or lon between -180 and 180),
  where_note   text check (where_note is null or char_length(where_note) <= 300),

  status       public.contribution_status not null default 'pending',
  promoted_truck_id bigint references public.trucks(id) on delete set null,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

create index truck_submissions_open_ix on public.truck_submissions (created_at desc)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- RLS. Reads are public; writes are server-side only (no anon INSERT policy).
-- ---------------------------------------------------------------------------
alter table public.reviews           enable row level security;
alter table public.truck_edits       enable row level security;
alter table public.truck_submissions enable row level security;

create policy reviews_public_read on public.reviews
  for select to anon, authenticated using (status = 'visible');

-- Proposals are readable so the community can see what is queued (and so a
-- truck owner can review edits to their own listing without a separate tool).
create policy truck_edits_public_read on public.truck_edits
  for select to anon, authenticated using (true);

create policy truck_submissions_public_read on public.truck_submissions
  for select to anon, authenticated using (status = 'pending');

-- An owner may resolve edits on their own truck.
create policy truck_edits_owner_resolve on public.truck_edits
  for update to authenticated
  using      (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())))
  with check (exists (select 1 from public.trucks t
                       where t.id = truck_id and t.owner_id = (select auth.uid())));

revoke all on all tables in schema private from anon, authenticated;

-- ---------------------------------------------------------------------------
-- trucks_at() gains rating columns so the map/list can show stars without a
-- second round trip. RETURNS TABLE cannot be widened by CREATE OR REPLACE, so
-- this is a DROP + CREATE — which also drops the grant, reissued at the end.
-- ---------------------------------------------------------------------------
drop function if exists public.trucks_at(
  timestamptz, double precision, double precision, double precision, double precision,
  numeric, text[]);

create or replace function public.trucks_at(
  p_as_of          timestamptz default now(),
  p_west           double precision default null,
  p_south          double precision default null,
  p_east           double precision default null,
  p_north          double precision default null,
  p_min_confidence numeric default 20,
  p_cuisines       text[] default null
) returns table (
  appearance_id bigint,
  truck_id      bigint,
  slug          text,
  truck_name    text,
  cuisines      text[],
  logo_path     text,
  venue_id      bigint,
  venue_name    text,
  lon           double precision,
  lat           double precision,
  starts_at     timestamptz,
  ends_at       timestamptz,
  source        public.appearance_source,
  confidence    numeric,
  bucket        text,
  recent_here     integer,
  recent_not_here integer,
  last_seen_here  timestamptz,
  rating_avg    numeric,
  rating_count  integer
)
language sql stable security definer set search_path = public, private, extensions as $$
  with candidate as (
    select a.*
    from public.appearances a
    join public.trucks t on t.id = a.truck_id
    where a.status <> 'cancelled'
      and t.status not in ('hidden', 'closed')
      and a.starts_at - interval '6 hours'    <= p_as_of
      and a.ends_at   + interval '30 minutes' >= p_as_of
      and (p_west is null or a.geom && extensions.ST_MakeEnvelope(p_west, p_south, p_east, p_north, 4326))
      and (p_cuisines is null or t.cuisines && p_cuisines)
  ),
  scored as (
    select c.id, c.truck_id, c.venue_id, c.starts_at, c.ends_at, c.source, c.geom,
           public.appearance_confidence(c.id, p_as_of) as conf
    from candidate c
  )
  select
    s.id, t.id, t.slug, t.name, t.cuisines, t.logo_path,
    v.id, v.name,
    extensions.ST_X(s.geom), extensions.ST_Y(s.geom),
    s.starts_at, s.ends_at, s.source,
    round(s.conf, 1), public.confidence_bucket(s.conf),
    coalesce(sig.here, 0)::integer,
    coalesce(sig.not_here, 0)::integer,
    sig.last_here,
    t.rating_avg,
    t.rating_count
  from scored s
  join public.trucks t on t.id = s.truck_id
  left join public.venues v on v.id = s.venue_id
  left join lateral (
    select count(*) filter (where g.kind = 'here')     as here,
           count(*) filter (where g.kind = 'not_here') as not_here,
           max(g.seen_at) filter (where g.kind = 'here') as last_here
    from private.sightings g
    where g.appearance_id = s.id
      and g.seen_at <= p_as_of
      and g.seen_at >  p_as_of - interval '6 hours'
  ) sig on true
  where s.conf >= p_min_confidence
  order by s.conf desc, s.starts_at;
$$;

grant execute on function public.trucks_at(
  timestamptz, double precision, double precision, double precision, double precision,
  numeric, text[]
) to anon, authenticated;
