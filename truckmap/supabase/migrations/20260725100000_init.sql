-- ============================================================================
-- 0001 — core schema: trucks, venues, schedules, appearances, sightings
--
-- Modelling note (the whole reason this differs from OpenDrop):
--   OpenDrop models a FIXED POINT whose EXISTENCE decays over months.
--   We model a MOVING VENDOR whose LOCATION is true for a few hours.
--   So the unit the map queries is not `trucks` — it is `appearances`
--   (truck x place x time window). `trucks` is just identity.
--
-- Scale target: one county, tens-to-low-hundreds of trucks. Indexes and
-- extensions are chosen for that, not for a national dataset. Growth seams
-- are marked GROWTH: throughout.
-- ============================================================================

-- PostGIS only. pg_trgm and citext were cut in the de-bloat pass: fuzzy name
-- search over ~60 trucks is a sequential scan either way, and a case-insensitive
-- slug is a unique index on lower(slug).
create extension if not exists postgis with schema extensions;

-- Anything holding an ip_hash lives here. PostgREST only exposes `public`,
-- so a private-schema table is unreachable from the browser by construction —
-- not merely by an RLS policy someone might later loosen.
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.truck_status as enum ('active', 'dormant', 'closed', 'hidden');

create type public.venue_type as enum (
  'brewery',        -- the dominant food-truck host in this region
  'park',
  'business_park',
  'festival',
  'street',
  'private_lot',
  'market',
  'other'
);

-- Where an appearance claim came from. Drives its base credibility (0002).
-- 'venue_calendar' and 'scraped' have no feed yet — they are retained because
-- they document the intended credibility ordering, and ALTER TYPE ADD VALUE
-- mid-flight is more disruptive than an unused label.
create type public.appearance_source as enum (
  'operator',        -- the vendor posted it (highest)
  'venue_calendar',  -- GROWTH: the brewery/venue published it
  'recurring',       -- materialized from a standing weekly rule
  'scraped',         -- GROWTH
  'crowd'            -- someone else says the truck will be / is there
);

create type public.appearance_status as enum ('scheduled', 'confirmed', 'cancelled', 'ended');

-- 'gone' is stronger than 'not_here': it means "this truck is out of business",
-- not "it isn't at this spot right now". It feeds truck confidence, not appearance.
create type public.sighting_kind as enum ('here', 'not_here', 'gone');

-- ---------------------------------------------------------------------------
-- trucks — vendor identity. Slow-moving. One row per business, forever.
-- ---------------------------------------------------------------------------

create table public.trucks (
  id                bigint generated always as identity primary key,
  slug              text   not null,
  name              text   not null,

  -- Cuisines are deliberately text[] + a reference table, NOT an enum: food
  -- trucks add and drop menus constantly, and an enum change is a migration.
  cuisines          text[] not null default '{}',
  description       text,

  website           text,
  facebook          text,
  instagram         text,
  phone             text,
  logo_path         text,          -- Supabase Storage object path

  -- Ohio mobile food service operation license, issued through the county
  -- health district. This is the authoritative public-record seed source —
  -- the OSM-equivalent for this domain.
  license_number    text,
  license_expires_at date,

  -- Set when a vendor claims their truck through Supabase Auth. NULL = unclaimed.
  owner_id          uuid references auth.users(id) on delete set null,

  status            public.truck_status not null default 'active',

  -- Does this business exist and still operate? Slow decay, months. Trigger-
  -- maintained (it only changes on write events) — see 0002.
  confidence        numeric(5,2) not null default 0,

  -- GROWTH: learned show-rate. Multiplies the PLAN component of appearance
  -- confidence. The LEARNER is deliberately not built yet — it needs ~90 days
  -- of sighting history to say anything, so shipping it now would be dead code.
  -- Held at 1.000 until then, which makes the confidence formula a no-op on it.
  -- Adding the learner later is one migration and zero refactoring.
  reliability       numeric(4,3) not null default 1.000,

  last_verified_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint trucks_slug_format      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint trucks_confidence_range check (confidence  between 0    and 100),
  constraint trucks_reliability_range check (reliability between 0.50 and 1.25)
);

create unique index trucks_slug_uq on public.trucks (lower(slug));
create index trucks_owner_ix on public.trucks (owner_id) where owner_id is not null;

-- Controlled vocabulary for the filter UI. A table, not an enum, so adding
-- "birria" is an INSERT.
create table public.cuisines (
  key   text primary key,
  label text not null,
  sort  smallint not null default 100
);

insert into public.cuisines (key, label, sort) values
  ('tacos',    'Tacos',              10),
  ('mexican',  'Mexican',            20),
  ('bbq',      'BBQ',                30),
  ('burgers',  'Burgers',            40),
  ('pizza',    'Pizza',              50),
  ('asian',    'Asian',              60),
  ('soul',     'Soul food',          70),
  ('desserts', 'Desserts & sweets',  80),
  ('coffee',   'Coffee & drinks',    90),
  ('other',    'Other',             999);

-- ---------------------------------------------------------------------------
-- venues — recurring host spots (a brewery lot, a park, an office park)
-- ---------------------------------------------------------------------------

create table public.venues (
  id           bigint generated always as identity primary key,
  name         text not null,
  venue_type   public.venue_type not null default 'other',
  geom         extensions.geometry(Point, 4326) not null,

  address_line text,
  city         text,
  state        varchar(2),
  postal_code  text,
  website      text,

  created_at   timestamptz not null default now(),

  constraint venues_state_format check (state is null or state ~ '^[A-Z]{2}$')
);

create index venues_geom_gix on public.venues using gist (geom);

-- ---------------------------------------------------------------------------
-- schedules — standing weekly rules ("every Thursday 5-9 at Municipal Brew")
--
-- Times are LOCAL WALL-CLOCK (a `time`, no zone). The materializer in 0004
-- resolves them against America/New_York, so DST is handled once, in one place.
--
-- GROWTH: alternating-week rules ("first and third Thursday") were cut — they
-- are rare and cost a non-obvious modulo in the materializer. Adding them back
-- is one nullable column plus one AND clause.
-- ---------------------------------------------------------------------------

create table public.schedules (
  id          bigint generated always as identity primary key,
  truck_id    bigint not null references public.trucks(id) on delete cascade,
  venue_id    bigint not null references public.venues(id) on delete cascade,

  day_of_week smallint not null check (day_of_week between 0 and 6),  -- 0 = Sunday
  start_time  time not null,
  end_time    time not null,

  valid_from  date not null default current_date,
  valid_until date,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),

  constraint schedule_window check (end_time > start_time)
);

create index schedules_truck_ix  on public.schedules (truck_id);
create index schedules_active_ix on public.schedules (active, day_of_week) where active;

-- ---------------------------------------------------------------------------
-- appearances — THE core table. What the map actually queries.
-- ---------------------------------------------------------------------------

create table public.appearances (
  id          bigint generated always as identity primary key,
  truck_id    bigint not null references public.trucks(id) on delete cascade,
  venue_id    bigint references public.venues(id) on delete set null,

  -- Denormalized from the venue by a BEFORE trigger when venue_id is given, so
  -- there is exactly ONE spatial column to index and query. An ad-hoc stop
  -- (a street corner, no venue row) supplies its own geom.
  geom        extensions.geometry(Point, 4326) not null,

  starts_at   timestamptz not null,
  ends_at     timestamptz not null,

  source      public.appearance_source not null,

  -- WHEN THE CLAIM WAS MADE — distinct from when the truck will be there.
  -- This is what the plan-credibility half-life ages against: an operator post
  -- from an hour ago is worth more than the same post made nine days ago.
  asserted_at timestamptz not null default now(),

  schedule_id bigint references public.schedules(id) on delete set null,
  status      public.appearance_status not null default 'scheduled',
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint appearance_window      check (ends_at > starts_at),
  constraint appearance_sane_length check (ends_at - starts_at <= interval '16 hours')
);

-- One materialized appearance per (rule, slot) — makes the nightly materializer
-- idempotent and safely re-runnable.
create unique index appearances_schedule_slot_uq
  on public.appearances (schedule_id, starts_at) where schedule_id is not null;

create index appearances_window_ix on public.appearances (starts_at, ends_at)
  where status <> 'cancelled';
create index appearances_geom_gix  on public.appearances using gist (geom);
create index appearances_truck_ix  on public.appearances (truck_id, starts_at desc);

create or replace function public.appearance_fill_geom()
returns trigger language plpgsql as $$
begin
  if new.geom is null and new.venue_id is not null then
    select v.geom into new.geom from public.venues v where v.id = new.venue_id;
  end if;
  return new;
end;
$$;

create trigger appearances_fill_geom
  before insert or update of venue_id, geom on public.appearances
  for each row execute function public.appearance_fill_geom();

-- ---------------------------------------------------------------------------
-- private.sightings — crowd "it's here right now" reports
--
-- PRIVATE because every row carries an ip_hash. The browser never reads this
-- table; it reads aggregates through the security-definer RPC in 0002.
--
-- appearance_id is NULLABLE on purpose: that is the DISCOVERY path. A sighting
-- of a truck somewhere with no scheduled appearance is exactly how you learn
-- about unscheduled stops, and promoting clusters of them is a planned job.
-- ---------------------------------------------------------------------------

create table private.sightings (
  id             bigint generated always as identity primary key,
  truck_id       bigint not null references public.trucks(id) on delete cascade,
  appearance_id  bigint references public.appearances(id) on delete cascade,
  geom           extensions.geometry(Point, 4326) not null,
  kind           public.sighting_kind not null,
  seen_at        timestamptz not null default now(),

  ip_hash        text not null,     -- sha256(salt || client_ip); raw IP never stored
  turnstile_hash text,
  reporter_id    uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint sighting_not_future check (seen_at <= now() + interval '5 minutes')
);

-- One report per person per appearance per hour. date_trunc over a
-- `timestamp` (not timestamptz) is IMMUTABLE, so it is index-legal.
create unique index sightings_one_per_hour_uq on private.sightings (
  coalesce(appearance_id, -1),
  ip_hash,
  date_trunc('hour', seen_at at time zone 'UTC')
);

create index sightings_appearance_ix on private.sightings (appearance_id, seen_at desc);
create index sightings_truck_ix      on private.sightings (truck_id, seen_at desc);
create index sightings_geom_gix      on private.sightings using gist (geom);

-- ---------------------------------------------------------------------------
-- private.submission_audit — uniform per-IP rate-limit ledger for every
-- anonymous write path (sighting, appearance report, truck suggestion, photo).
-- One table so the Edge Function has one cooldown query, not four.
-- ---------------------------------------------------------------------------

create table private.submission_audit (
  id             bigint generated always as identity primary key,
  kind           text not null,          -- 'sighting' | 'appearance' | 'truck' | 'photo'
  entity_id      bigint,
  ip_hash        text not null,
  turnstile_hash text,
  created_at     timestamptz not null default now()
);

create index submission_audit_ip_ix on private.submission_audit (ip_hash, kind, created_at desc);
