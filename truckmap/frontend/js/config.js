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
