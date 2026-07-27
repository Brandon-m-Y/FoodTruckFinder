// Static config. No build step, so there is no way to inject env vars — these
// values are inlined deliberately.
//
// The PUBLISHABLE key is designed to sit in browser bundles. It is not a secret:
// every table is protected by Row Level Security, there is no anonymous INSERT
// policy anywhere, and private.sightings is not exposed to PostgREST at all.
// (scripts/smoke.mjs asserts all three against the live database.)
export const SUPABASE_URL = "https://detmkrivpmfljqfazdzx.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ncPLfpqY2ggErrBM9h0VjA_I4-kI75P";

// AGPL section 13: running this on a server where the public interacts with it
// counts as conveying it, which obliges us to offer those users the source of
// the exact version they are using. A visible link is how that obligation is
// discharged in practice.
//
// The footer renders no link when this is null, rather than a dead one — a
// broken source link is worse than an honest absence, because it looks like
// compliance without being it. Same reasoning applies if the repo is PRIVATE:
// a link visitors cannot open does not discharge section 13.
export const SOURCE_URL = "https://github.com/Brandon-m-Y/FoodTruckFinder";

// Butler County, Ohio.
export const DEFAULT_VIEW = { center: [39.44, -84.55], zoom: 11 };
export const MIN_ZOOM = 8;

/**
 * Basemap: CARTO Positron (light) / Dark Matter (dark).
 *
 * WHY NOT tile.openstreetmap.org
 * The OSMF tile servers are donation-funded and their usage policy explicitly
 * asks production applications not to use them. That is the reason for this
 * change; the fact that Positron is a calmer basemap — grey roads, muted labels,
 * so four coloured confidence pins are the only saturated thing on screen — is
 * a bonus rather than the point.
 *
 * The DATA is still OpenStreetMap and its ODbL attribution requirement travels
 * with it, which is why both entries below are non-negotiable and why the
 * picker map in addtruck.js now shows an attribution control it previously
 * suppressed.
 *
 * `{r}` expands to "@2x" on retina displays; Leaflet fills it in via
 * `detectRetina`. `{s}` is the a/b/c/d subdomain rotation.
 */
export const BASEMAP = {
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors '
    + '&copy; <a href="https://carto.com/attributions">CARTO</a>',
};

// Mirrors public.confidence_bucket() in the database. Kept in sync by hand;
// the server value is authoritative and is what we actually render.
export const BUCKETS = ["live", "likely", "scheduled", "unlikely"];

export const BUCKET_LABEL = {
  live: "Here now",
  likely: "Likely",
  scheduled: "Scheduled",
  unlikely: "Unconfirmed",
};

// How far ahead the time scrubber can reach, in hours.
export const SCRUB_HOURS = 336; // 14 days — matches materialize_schedules(14)
