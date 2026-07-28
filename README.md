# Food Truck Finder

Open-data map of food trucks in Hamilton / Butler County, Ohio. Vanilla JS + Leaflet over
Supabase Postgres/PostGIS. No build step, no framework, no Docker.

Structurally inspired by **[OpenDrop](https://github.com/WanderingAstronomer/OpenDrop)** by Andrew
Brown (AGPL-3.0), used with the author's express permission as well as under the licence — but the
core model is inverted. OpenDrop tracks **fixed points whose existence decays over months**; this
tracks **moving vendors whose location is true for a few hours**. What that changes is the subject
of this document. See [`NOTICE`](NOTICE) for the full attribution.

---

## Status

Working end to end against a live Supabase project. **Not launched, and not launch-ready** — see
[Before this can go public](#before-this-can-go-public).

| | |
|---|---|
| Schema | 13 migrations applied |
| Map | trucks, list, time scrubber, detail sheet |
| Community writes | reviews, description edits, truck submissions, sightings |
| Data | demo rows + 1 real truck. **No real seed data yet** |

## Run it

```bash
cd truckmap
npm install
cp .env.example .env          # fill in SUPABASE_SECRET_KEY
npm run dev                   # -> http://127.0.0.1:5173
```

Reads work without `.env`; writes return `503 write_api_disabled` until the secret key is set.

## Apply the schema

```bash
cd truckmap
npx supabase login
npx supabase link --project-ref <ref>
npm run db:push               # supabase db push
npm run smoke                 # verify the live function chain AND the grants
```

Enable **pg_cron** in Database → Extensions before `0004` runs. PostGIS is created by `0001` into
the `extensions` schema (Supabase's convention) and is the only extension used.

**Docker is not required and not used.** `supabase/config.toml` is trimmed to one setting for that
reason. `db push` prints a Docker warning about caching a *local* catalog; it is cosmetic and the
push never touches Docker.

### Scripts

| Command | What |
|---|---|
| `npm run dev` | static frontend + write API on :5173 |
| `npm run db:push` | apply migrations to the linked project |
| `npm run db:status` | migration ledger, local vs remote |
| `npm run smoke` | assert the live confidence chain **and** the security posture |
| `npm run check-deploy` | probe the *deployed* site — chiefly that a garbage Turnstile token is refused |
| `npm run moderate` | takedowns, the review queue, and putting trucks on the map |
| `npm run import-licences` | load a county health district export; dry-run by default |
| `npm run purge-demo` | dry-run the removal of `[DEMO]` data; `-- --yes` to commit |

Through npm, options need a `--` separator so npm passes them through rather than eating them:
`npm run moderate add "Name" -- --at 39.3995,-84.5613`.

---

## Putting a truck on the map, and keeping it there

The map renders **appearances**, not trucks, so a truck is visible only while it has one. There are
three ways to get one, and only two of them last:

| Route | Lifespan |
|---|---|
| Someone submits a truck with a pin | **one window, 1–12 hours**, then gone for good |
| A crowd sighting | hours; decays with a 45-minute half-life |
| A standing weekly rule (`schedules`) | **indefinite** — re-materialized nightly over a rolling 14 days |

Only the third persists, and until migration 0018 nothing could create one, which is why the demo
trucks were the only durable pins on the site. `moderate add` / `moderate place` create one:

```bash
npm run moderate add "Taqueria La Bamba" -- \
  --at 39.3995,-84.5613 --place "Municipal Brew Works" \
  --days thu,fri --from 17:00 --to 21:00 --type brewery --cuisines tacos,mexican

npm run moderate place 30 -- --at 39.36,-84.31 --place "Union Centre"   # an existing truck
npm run moderate curated                                                # what you've vouched for
npm run moderate uncurate 30 "closed for the season"                    # retract, not a takedown
```

Both mark the truck **curated**: pinned `active`, exempt from the nightly sweep that demotes quiet
trucks to `dormant`. That exemption is load-bearing rather than cosmetic — `dormant` is what stops
the materializer, so without it a truck placed on Monday silently loses its pins by Tuesday.

Curation is a maintenance flag, not a display one. Nothing in the UI renders it and there is no
badge: a visitor cannot tell a curated truck from any other, which is the point — these are real
businesses, not demo rows. `curate_truck()` is EXECUTE-granted to `service_role` alone, so this CLI
is the only door to it.

---

## The model in one paragraph

`trucks` is identity. `venues` are recurring host spots. `schedules` are standing weekly rules
("every Thursday 5–9 at Municipal Brew Works"). Those materialize nightly into **`appearances`** —
truck × place × time window — which is the row the map actually queries. `private.sightings` are
anonymous "it's here right now" reports that corroborate or contradict an appearance.

## Two confidence scores, deliberately separate

| | Truck confidence | Appearance confidence |
|---|---|---|
| Question | Does this business exist? | Is it at this spot at time *T*? |
| Timescale | months | minutes |
| Storage | **materialized column**, trigger-maintained | **computed at query time** |

That second row is the load-bearing design decision. Appearance confidence changes with the passage
of time alone — no write happens when a lunch window ends — and a trigger cannot fire on "an hour
went by." Computing it on demand, parameterized by `as_of`, is also what makes the time-scrubber UI
free: *"where can I eat at 6pm Friday?"* is the same code path as *"what's open now."*

```
appearance_confidence = clamp(0, 100,
      plan_weight(source, asserted_at, as_of)   -- who claimed it, how long ago
    * truck.reliability                          -- do they actually show up?
    * window_gate(starts_at, ends_at, as_of)     -- where we are in the window
    + sighting_weight(appearance, as_of)         -- live eyewitness evidence
)
```

The gate multiplies the **plan only**. Sightings stand on their own — an eyewitness report shouldn't
be discounted because the posted window closed; that *is* the signal a truck stayed late. Its own
45-minute half-life retires it soon enough.

**Negative reports outweigh positive ones** (30 vs 20, floor −60 vs cap +40). Sending someone to an
empty lot costs far more than under-advertising a truck that's there.

### Worked examples

| Situation (queried 6pm Thursday, window 5–9pm) | Score | Bucket |
|---|---|---|
| Recurring schedule, no history, no sightings | 50 | likely |
| …plus two "here" reports 20 min ago | 79 | **live** |
| …instead, one "not here" report 10 min ago | 24 | scheduled |
| Operator posted this morning, no sightings | 76 | **live** |
| Same operator post, but queried at 11am | 43 | likely |
| Recurring, truck that never shows (reliability 0.7)¹ | 35 | scheduled |

¹ Hypothetical until the reliability learner ships — `reliability` is pinned at 1.000 for now, so
it is currently a no-op in the formula. The column and the multiplication are already in place.

---

## Trust model

**Operators** authenticate with Supabase Auth, claim a truck (`trucks.owner_id`), and write their
own appearances straight through PostgREST — RLS scopes them to their truck, and a trigger stamps
provenance so they can't forge a `source`. *(Schema is in place; the claim UI is not built.)*

**The crowd** is anonymous, forever. There is deliberately **no anon INSERT policy on any table**.
Every anonymous write goes through [`server/handlers.mjs`](truckmap/server/handlers.mjs), which holds the
`service_role` key, verifies a Cloudflare Turnstile token, applies per-IP daily caps, and calls a
`SECURITY DEFINER` RPC that does the cap check, the insert and the audit row in one transaction.

Every row carrying an `ip_hash` lives in the `private` schema, which PostgREST does not expose — so
it is unreachable from a browser by construction, not by a policy someone might later loosen. The
only route sighting data reaches a client is the aggregate columns of `trucks_at()`.

### Two doors, and the one that was left open

Read that trust model carefully and it describes **two** independent gates: no INSERT policy on the
tables, and no EXECUTE on the RPCs. Until migration `0013`, only the first was real.

Migrations 0003 and 0009–0012 each said `revoke execute ... from anon, authenticated`. That is a
no-op. Postgres grants `EXECUTE` on a new function to the pseudo-role `PUBLIC` by default, and
`anon` inherits it *there* — revoking from the role by name never touches the grant it is actually
using. Every statement reported success and changed nothing.

The consequence was not academic. Those RPCs take `p_ip_hash` and `p_daily_cap` as **arguments**, so
a caller chose their own identity and their own rate limit. With nothing but the publishable key
that ships in `frontend/js/config.js`, a browser console could call `submit_truck(...)` and put a
truck on the public map — bypassing Turnstile, the caps, the IP hashing and every validation rule in
`handlers.mjs` in one `fetch`.

`0013` revokes from `PUBLIC` by looping over `pg_proc` (a signature list is what failed the first
time — `submit_truck` has been redefined three times), grants back an explicit read-only allowlist,
and sets `alter default privileges` so functions added later start closed.

**The lesson is in the test, not the fix.** `smoke.mjs` asserted "no anon INSERT policy" and never
"no anon EXECUTE," so the hole was invisible to CI while three files asserted in prose that it
couldn't exist. It now probes every write RPC and asserts **SQLSTATE 42501 specifically** — merely
checking "it returned an error" false-passes on a signature typo while the real function stays wide
open. If you add a `SECURITY DEFINER` function, add it to `RPC_PROBES`.

---

## Migrations

| | What |
|---|---|
| `…100000_init` | tables, enums, indexes, the `private` schema |
| `…100100_confidence` | decay model + `trucks_at()` — the map's only read RPC |
| `…100200_rls` | RLS policies, operator/crowd trust split, grants |
| `…100300_jobs` | pg_cron: materialize schedules, nightly maintenance |
| `…105000_fix_materialize_onconflict` | forward-fix: `ON CONFLICT` cannot infer a *partial* unique index |
| `…110000_demo_seed` | throwaway `[DEMO]` data; remove with `npm run purge-demo` |
| `…120000_community` | reviews, edits, submissions; `trucks_at()` widened with ratings |
| `…130000_demo_reviews` | throwaway demo reviews |
| `…140000_write_rpcs` | the four `submit_*` RPCs; custom SQLSTATE `TM429` for rate limits |
| `…150000_promote_submissions` | slugify + promote a pinned submission onto the map |
| `…160000_submitter_is_a_witness` | a submitter saying "it's here" IS a sighting; record it |
| `…170000_review_multiple_for_exempt` | let exempt IPs stack reviews, for testing lists |
| `…0726_090000_revoke_execute_from_public` | **security**: actually revoke EXECUTE (see above) |
| `…0726_180000_close_unmoderated_reads` | **security**: stop serving un-reviewed submissions and rejected edits |
| `…0726_190000_moderation_log` | forward-fix: column revokes are no-ops under a table grant; append-only audit trail |
| `…0726_200000_takedown_cascades_to_content` | **security**: hiding a truck now hides its reviews too |
| `…0728_120000_licence_import` | provenance for county licence records; `import_truck()` |
| `…0728_160000_curated_trucks` | `curated`; `curate_truck()`; the materializer stops skipping demoted trucks |
| `…0728_163000_fix_materialize_regression` | forward-fix: 0018 rebuilt `materialize_schedules` from the wrong ancestor |

Migrations are forward-only. `105000` and `163000` both exist because the bug they fix was already
applied; editing an applied migration would desync the remote ledger.

Those two are worth reading together — they are the **same bug, made twice**. Redefining a function
with `create or replace` takes whatever body you hand it, so writing the new version against the
function's *original* migration silently reverts every fix made since. `163000` lost the partial-index
`ON CONFLICT` predicate from `105000` and the `p_days` clamp from `090000` that way. Before replacing
a function, `grep` the migrations directory for its name and start from the newest definition.

### Scope

Sized for **one county, tens-to-low-hundreds of trucks**. Extensions, indexes and jobs are chosen
for that, not for a national dataset. Places designed to grow are marked `GROWTH:` in the SQL — the
notable ones being the `reliability` learner, venue-calendar and scraped appearance feeds, and
alternating-week schedule rules. Each is additive: a migration, not a refactor.

---

## Before this can go public

Ordered by what would embarrass you fastest.

- [ ] **Real Turnstile keys.** `.env.example` ships Cloudflare's always-pass TEST keys, so the bot
      gate currently verifies nothing.
- [ ] **Moderation queue + operator takedown.** `reviews.status` defaults to `'visible'`, so anything
      reaching the table is public immediately. Turnstile alone does not cover a determined human.
- [ ] **Remove the demo data** — `npm run purge-demo -- --yes`. The demo reviews are prose written to
      look like customers; on a public map they are indistinguishable from real ones.
- [ ] **Set `TRUST_PROXY`** on the deploy. Without it the socket peer is the platform's own proxy —
      identical for every visitor — so all traffic hashes to one `ip_hash`: the per-IP caps collapse
      into a single global cap, and "one review per person" makes the entire internet one person.
      `handlers.mjs` warns at boot if it detects a platform with `TRUST_PROXY` unset.
- [ ] **Empty `RATE_LIMIT_EXEMPT_IPS`** in production. A home address left there is permanently
      exempt from every cap.
- [ ] **Real seed data.** Four public records requests (see [`docs/FINDINGS.md`](truckmap/docs/FINDINGS.md)).

## Deploying

[`netlify.toml`](netlify.toml) and
[`truckmap/netlify/functions/api.mjs`](truckmap/netlify/functions/api.mjs) are written and inert
until you connect a site. The function is a thin adapter over `server/handlers.mjs` — same
validation, same rate limiting, shared verbatim with the dev server.

**Leave every build setting in the Netlify UI blank.** `netlify.toml` sits at the repository root
and declares `base = "truckmap"`, so Netlify finds it before it needs to know anything, and
everything else resolves from there. UI settings only override the file and cause drift.

| Setting | Value | Where it comes from |
|---|---|---|
| Base directory | `truckmap` | `netlify.toml` |
| Build command | `npm install --omit=dev` | `netlify.toml` |
| Publish directory | `frontend` (→ `truckmap/frontend`) | `netlify.toml` |
| Functions directory | `netlify/functions` | `netlify.toml` |

Environment variables are the one thing the UI must supply — they are secrets and cannot live in a
committed file:

| Variable | Value | If you forget it |
|---|---|---|
| `SUPABASE_URL` | project URL | every write returns `503 write_api_disabled` |
| `SUPABASE_SECRET_KEY` | service_role key | same |
| `IP_HASH_SALT` | `openssl rand -hex 24` — a **new** one, not your local value | stored `ip_hash`es are brute-forceable across the IPv4 space |
| `TURNSTILE_SITEKEY` | real key, starts `0x` | widget is a no-op; **writes go unchallenged** |
| `TURNSTILE_SECRET` | real key, starts `0x` | verification is skipped entirely; **writes go unchallenged** |
| `TRUST_PROXY` | `netlify` | every visitor shares one `ip_hash`; the caps become one global cap |
| `RATE_LIMIT_EXEMPT_IPS` | leave **empty** | a home address here is permanently exempt from every cap |

Then verify from outside:

```bash
cd truckmap
npm run check-deploy https://your-site.netlify.app
```

That last step is not ceremony. Every other misconfiguration here announces itself — a missing key
gives a 503, a bad route gives a 404. But a site running Cloudflare's always-pass **TEST** secret
behaves exactly like a correctly protected one from a browser: the widget renders, tokens are
minted, submissions succeed. The only way to tell from outside is to send a token a real secret
must reject and confirm it *is* rejected, which is what the script does. It writes nothing — every
probe carries a deliberately invalid rating, so anything that survives the bot gate is stopped by
validation before a row exists.

## Not built yet

- CSV importer for health-district licence exports
- Operator flow: claim a truck via Supabase Auth, post today's location
- Promoting orphan sighting clusters (`appearance_id IS NULL`) into discovered appearances
- `reliability` learner (see `GROWTH:` in `0001`)

---

## Licence

**AGPL-3.0-or-later.** Copyright © 2026 Brandon Ytuarte. Full text in [`LICENSE`](LICENSE);
attribution and third-party notices in [`NOTICE`](NOTICE).

The AGPL is inherited from OpenDrop and it is the right licence for this anyway: section 13 means
that running a modified version on a public server obliges you to offer those users your source. A
community map built from public records and volunteered sightings should not be enclosable by
whoever forks it. `frontend/js/config.js` carries a `SOURCE_URL` that renders the source link in the
footer — set it when the repository exists.
