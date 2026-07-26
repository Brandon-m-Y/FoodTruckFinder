# TruckMap *(working name)*

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
npm install
cp .env.example .env          # fill in SUPABASE_SECRET_KEY
npm run dev                   # -> http://127.0.0.1:5173
```

Reads work without `.env`; writes return `503 write_api_disabled` until the secret key is set.

## Apply the schema

```bash
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
| `npm run purge-demo` | dry-run the removal of `[DEMO]` data; `-- --yes` to commit |

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
Every anonymous write goes through [`server/handlers.mjs`](server/handlers.mjs), which holds the
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

Migrations are forward-only. `105000` exists because the bug it fixes was already applied; editing
an applied migration would desync the remote ledger.

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
- [ ] **Client IP behind a proxy.** `server/dev.mjs` reads `socket.remoteAddress`, correct for local
      dev. On a hosted deploy that is the *proxy* for every visitor — one shared `ip_hash`, so the
      per-IP caps collapse into a single global cap and "one review per person" makes the entire
      internet one person. Read the platform's client-IP header instead.
- [ ] **Real seed data.** Four public records requests (see [`docs/FINDINGS.md`](docs/FINDINGS.md)).

## Not built yet

- CSV importer for health-district licence exports
- Operator flow: claim a truck via Supabase Auth, post today's location
- Promoting orphan sighting clusters (`appearance_id IS NULL`) into discovered appearances
- `reliability` learner (see `GROWTH:` in `0001`)
- Netlify Function wrapping `server/handlers.mjs` + deploy wiring

---

## Licence

**AGPL-3.0-or-later.** Full text in [`LICENSE`](LICENSE); attribution and third-party notices in
[`NOTICE`](NOTICE).

The AGPL is inherited from OpenDrop and it is the right licence for this anyway: section 13 means
that running a modified version on a public server obliges you to offer those users your source. A
community map built from public records and volunteered sightings should not be enclosable by
whoever forks it. `frontend/js/config.js` carries a `SOURCE_URL` that renders the source link in the
footer — set it when the repository exists.
