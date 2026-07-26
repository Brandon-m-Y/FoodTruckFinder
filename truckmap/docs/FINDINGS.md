# Seed data sources — findings

Research pass, July 2026. Question: where does the initial truck list come from?

**Headline: there is no scrapable structured source.** This is the opposite of OpenDrop's
situation, which had five first-party org locators with JSON endpoints. Plan accordingly — the
seed is a records request and a phone list, not a scraper.

---

## Finding 1 — Ohio mobile food licenses are issued locally but valid STATEWIDE ⚠

This is the single most important constraint, and it breaks the obvious approach.

Ohio requires a Mobile Food Service Operation license for anyone preparing or selling food from a
vehicle that routinely changes location. Applications go to **the health district where the
*business headquarters* is located** — and a license issued by any approved Ohio health district
**is recognized by every other district in the state**.

So: *a list of Butler County-licensed trucks is not a list of trucks that operate in Butler County.*
A truck headquartered in Cincinnati (~25 minutes from Hamilton) works West Chester and Liberty
Township constantly and appears in **Hamilton County's** records, not Butler's. This is not an edge
case — given the metro geography it is likely the majority of trucks working the southern half of
the county.

**Consequence:** seed from **four** districts, not one.

| District | Covers | Why it matters here |
|---|---|---|
| Butler County General Health District | Hamilton, Fairfield, Oxford, unincorporated | The home county |
| Cincinnati Health Dept + Hamilton County Public Health | Cincinnati metro | Almost certainly the largest overlapping pool |
| Public Health – Dayton & Montgomery County | Dayton metro | Northern Butler / Middletown draw |
| Warren County | Mason, Lebanon | Eastern edge |

Licenses expire **March 1** annually, so the list has a natural yearly refresh and a built-in
staleness signal — which maps directly onto `trucks.license_expires_at` and the license component
of `recompute_truck_confidence()`.

## Finding 2 — Butler County's records live in two systems, mid-migration

Butler County General Health District split its inspection/licensing records in May 2025:

- **Before 2025-05-09** — HealthSpace (`healthspace.com/Clients/Ohio/Butler/Web.nsf`)
- **After** — Accela Citizen Access (`aca-prod.accela.com/BUTLERCGHD`)

Both are public-facing search UIs. Neither advertises an API.

**Both blocked automated access during this research** (HTTP 403 from an automated fetch).
Accela ACA is an ASP.NET postback form; scraping it means driving `__VIEWSTATE` round-trips, which
is brittle, and doing so against a small county health district after they explicitly 403 bots is
a bad look for a civic project that wants their cooperation later.

> ⚠ Not independently verified: I could not load either portal's search results. Whether the
> Accela deployment exposes a *Mobile Food* record type, and whether results are listable without
> an account, needs a human with a browser. Check before assuming.

**Recommendation: ask, don't scrape.** These are public records under the Ohio Public Records Act
(ORC 149.43), and ORC 3717.43 already requires licensors to computerize licensing "to the extent
practicable" — so a written request for the current mobile food license list as a spreadsheet is
routine, cheap, and likely to be answered in days.

    Butler County General Health District
    301 South Third Street, Hamilton, OH 45011
    (513) 863-1770 · boh@bcohio.gov

A records request also gets you *better* data than scraping would: license number, expiry, and
business name in one clean export.

## Finding 3 — commercial aggregators are off-limits (D1)

**Roaming Hunger** (~16,000 trucks nationally) and **Street Food Finder** both display live truck
locations built from vendor-entered schedules. Their listings *are* their product.

Both **403'd automated access** during this research, including their public ToS page. Neither
offers a documented public API.

**Decision D1: never ingest, never store.** Same posture OpenDrop took toward Goodwill. If they are
ever used at all, it is manual reference during onboarding — a human noticing a truck exists — and
never an automated copy of their listings.

## Finding 4 — event lineups are the highest-yield seed available

The **UCBMA Food Truck Rally** at The Square at Union Centre (West Chester, Butler County) draws
**40+ trucks** to one place. Next event: **Friday, June 5, 2026**. Vendor applications for 2026 are
already closed, and the lineup is "coming soon" — not yet published.

Forty real, currently-operating, locally-active trucks on a single page is very likely the densest
seed in the county, and it is a page a human can transcribe in an hour. Watch for the lineup.

Secondary: the Butler County Fair, and the festival calendar at `travelbutlercounty.com`.

## Finding 5 — Google Places is a research aid, not a data source ⚠

Places can absolutely find food-truck business profiles in the county, and it is tempting. But the
Google Maps Platform terms broadly prohibit pre-fetching, indexing, storing, or caching Places
content, and prohibit using it to build a database or dataset. `place_id` may be retained
indefinitely; the actual *content* (name, address, hours, phone) may only be cached briefly, and
may not be redistributed.

For a project whose entire premise is an **open, exportable civic dataset**, ingesting Places
content would poison the well — the dataset could never be published under an open licence, which
is the whole point.

The `place_id`-only escape hatch does not rescue it either: resolving a stored ID still means
calling Places on every render, which costs money per map view and sends user queries to Google.

**Decision D2 — Google Places is never stored.** Two uses remain legitimate and genuinely useful:

1. **Research aid.** A human searches Places, learns that "Taco Libre" exists in Fairfield, then
   contacts the truck or reads its own public Facebook page and enters the data from *that*. What
   ends up in the database came from the business, not from Google. This is ordinary research and
   is worth doing — it is probably the fastest way to build the initial truck list while the
   records requests are pending.
2. **Query-time enrichment**, displayed but never written to a table — the `enrich_only` pattern
   OpenDrop used for Goodwill. Out of scope for now; noted so the option stays open.

> Verify the current Maps Platform terms before relying on any of this — they change, and the
> summary above is a paraphrase, not legal advice.

## Finding 6 — venue calendars supply schedules, not trucks

Breweries are the dominant recurring host for food trucks in this region, and their event calendars
carry the *schedule* data no license list will ever have. These are per-venue, mostly hand-maintained
WordPress/Squarespace calendars — a handful of sites covering a large share of recurring appearances.

Not yet enumerated. Municipal Brew Works (Hamilton) is the obvious first check.

---

## What this means for the build

The research **validates the schema's central split** — and reassigns where each half comes from:

| Schema concept | Real-world source | Effort |
|---|---|---|
| `trucks` (identity) | Health district records requests × 4 | One-time, high yield |
| `venues` | Breweries, parks, event grounds | Manual, ~20 rows |
| `schedules` | Venue calendars + operator onboarding | Ongoing, the hard part |
| `appearances` | Materialized from schedules; operator posts | Automatic |
| `sightings` | The crowd | The product |

The license data tells you **who exists**. It tells you nothing about **where or when** — and that
gap is precisely what operators and the crowd fill. That is the product thesis, and it survives
contact with the data.

### Revised plan for the seed task

Build a **CSV importer**, not a scraper. The authoritative data arrives as a spreadsheet from a
records request, so the ingest is: normalize a records-request export → slugify → dedupe against
existing trucks → upsert with `license_number` / `license_expires_at` set. Re-runnable each March
when licenses renew.

Two things worth doing by hand before writing any code: file the four records requests, and
transcribe the UCBMA lineup when it posts.
