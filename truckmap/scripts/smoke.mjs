/**
 * End-to-end smoke test against the LIVE Supabase project, using only the
 * publishable key — i.e. exactly the access a browser has.
 *
 * This is the check `supabase db push` cannot give you. Push reports that the
 * SQL executed; it does not prove the objects resolve at call time. Calling
 * trucks_at() exercises the whole chain in one shot:
 *
 *   trucks_at -> appearance_confidence -> plan_weight  -> decay_weight
 *                                      -> window_gate
 *                                      -> sighting_weight (reads private.sightings)
 *                                      -> confidence_bucket
 *
 * A clean empty array means every function, cast, and cross-schema grant in
 * that chain resolved. An error names whichever link is broken.
 *
 * Usage:  node scripts/smoke.mjs
 */
import { createClient } from "@supabase/supabase-js";

// Defaults mirror frontend/js/config.js — the test must use the SAME key the
// browser ships, or it is testing a posture nobody is actually exposed to.
const URL = process.env.SUPABASE_URL ?? "https://detmkrivpmfljqfazdzx.supabase.co";
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY
  ?? "sb_publishable_ncPLfpqY2ggErrBM9h0VjA_I4-kI75P";

const db = createClient(URL, KEY);

let failed = 0;
const ok   = (m, extra = "") => console.log(`  PASS  ${m}${extra && "  " + extra}`);
const bad  = (m, e) => { failed++; console.log(`  FAIL  ${m}\n        ${e?.message ?? e}`); };

async function check(label, fn) {
  try {
    const { data, error } = await fn();
    if (error) return bad(label, error);
    return ok(label, Array.isArray(data) ? `(${data.length} rows)` : ""), data;
  } catch (e) {
    bad(label, e);
  }
}

console.log(`\nSmoke test -> ${URL}\n`);

// Fail fast on a bad key. Without this the NEGATIVE checks below (private schema
// unreachable, anonymous write refused) FALSE-PASS: an auth rejection is an
// error, and "got an error" is exactly what they are asserting. A test that
// passes because nothing worked is worse than no test.
{
  const { error } = await db.from("cuisines").select("key").limit(1);
  if (error && /api key|jwt|unauthor/i.test(error.message)) {
    console.log(`  ABORT  credentials rejected: ${error.message}`);
    console.log("\n  The publishable key is stale. Get the current one from");
    console.log("  Dashboard > Project Settings > API Keys > publishable, then:");
    console.log("    SUPABASE_PUBLISHABLE_KEY=sb_publishable_... node scripts/smoke.mjs\n");
    process.exit(2);
  }
}

// 1. Seed data + a public RLS read policy.
const cuisines = await check("read public.cuisines (seed data + RLS select policy)",
  () => db.from("cuisines").select("key,label").order("sort"));

// 2. Empty public tables read cleanly (policy exists, no recursion).
await check("read public.trucks",      () => db.from("trucks").select("id").limit(1));
await check("read public.venues",      () => db.from("venues").select("id").limit(1));
await check("read public.appearances", () => db.from("appearances").select("id").limit(1));

// 3. THE BIG ONE — the whole confidence chain, at "now" and at an arbitrary
//    future instant (the time-scrubber code path).
await check("rpc trucks_at() @ now",
  () => db.rpc("trucks_at"));

await check("rpc trucks_at() @ Friday 6pm + bbox + cuisine filter",
  () => db.rpc("trucks_at", {
    p_as_of: "2026-07-31T22:00:00Z",
    p_west: -84.9, p_south: 39.2, p_east: -84.2, p_north: 39.6,
    p_min_confidence: 20,
    p_cuisines: ["tacos"],
  }));

// 4. Pure helpers, callable and correct. decay_weight at exactly one half-life
//    must be 0.5 — proves the numeric math, not just that it parses.
const decay = await check("rpc decay_weight() at exactly 1 half-life",
  () => db.rpc("decay_weight", {
    p_observed_at: "2026-07-25T12:00:00Z",
    p_as_of:       "2026-07-25T12:45:00Z",
    p_half_life_min: 45,
  }));
if (decay !== undefined && decay !== null) {
  const v = Number(decay);
  Math.abs(v - 0.5) < 1e-6
    ? ok("decay_weight math", `= ${v}`)
    : bad("decay_weight math", `expected 0.5, got ${v}`);
}

await check("rpc confidence_bucket(75) -> 'live'",
  () => db.rpc("confidence_bucket", { p_confidence: 75 }));

// 5. private.sightings MUST NOT be reachable from a browser.
const { error: privErr } = await db.from("sightings").select("id").limit(1);
privErr
  ? ok("private.sightings unreachable via PostgREST", `(${privErr.code ?? "blocked"})`)
  : bad("private.sightings unreachable via PostgREST", "IT IS READABLE — schema exposure bug");

// 6. Anonymous writes must be refused (no anon INSERT policy anywhere).
for (const t of ["trucks", "reviews", "truck_edits", "truck_submissions", "appearances"]) {
  const { error } = await db.from(t).insert({});
  error
    ? ok(`anonymous INSERT on ${t} refused`, `(${error.code})`)
    : bad(`anonymous INSERT on ${t} refused`, "IT WROTE — RLS is not protecting writes");
}

// 7. The write RPCs must be UNREACHABLE from a browser.
//
// This is the check whose absence let a real hole ship. Migrations 0009-0012 each
// said `revoke execute ... from anon, authenticated`, which is a no-op: Postgres
// grants EXECUTE to PUBLIC by default and those roles inherit it there. Every
// submit_* function was callable with nothing but the publishable key, and since
// they take p_ip_hash and p_daily_cap as ARGUMENTS, a caller picked their own
// identity and their own rate limit — bypassing Turnstile, the per-IP caps, and
// all of server/handlers.mjs in one fetch. Fixed in migration 0013.
//
// Asserting the SQLSTATE is the whole point. "It returned an error" false-passes
// on a signature typo (PGRST202, function not found), which would look identical
// while the real function stayed wide open. 42501 is insufficient_privilege and
// nothing else.
const RPC_PROBES = {
  submit_review: {
    p_truck_id: 1, p_rating: 5, p_body: null, p_author_name: null,
    p_ip_hash: "smoke", p_turnstile_hash: null, p_daily_cap: 999999, p_allow_multiple: false,
  },
  submit_edit: {
    p_truck_id: 1, p_field: "description", p_value: "smoke", p_note: null,
    p_ip_hash: "smoke", p_turnstile_hash: null, p_daily_cap: 999999,
  },
  submit_truck: {
    p_name: "smoke", p_cuisines: [], p_description: null, p_where_note: null,
    p_website: null, p_facebook: null, p_instagram: null, p_phone: null,
    p_lat: null, p_lon: null, p_ip_hash: "smoke", p_turnstile_hash: null,
    p_daily_cap: 999999, p_hours: 3,
  },
  submit_sighting: {
    p_truck_id: 1, p_appearance_id: null, p_kind: "here", p_lat: 39.4, p_lon: -84.5,
    p_ip_hash: "smoke", p_turnstile_hash: null, p_daily_cap: 999999,
  },
  // Mutating helpers. Harmless output, but nothing anonymous should drive them.
  recompute_truck_confidence: { p_truck_id: 1 },
  materialize_schedules: { p_days: 0 },
  nightly_maintenance: {},
};

for (const [fn, args] of Object.entries(RPC_PROBES)) {
  const { error } = await db.rpc(fn, args);
  if (error?.code === "42501") ok(`anonymous EXECUTE ${fn}() refused`, "(42501)");
  else if (error) bad(`anonymous EXECUTE ${fn}() refused`,
    `expected 42501 insufficient_privilege, got ${error.code}: ${error.message}` +
    `\n        (a non-42501 error means this probe never reached the function — ` +
    `fix the probe, it is not proving anything)`);
  else bad(`anonymous EXECUTE ${fn}() refused`,
    "IT RAN — EXECUTE is granted to PUBLIC; the server-side gate is bypassable");
}

console.log(
  cuisines?.length ? `\n  cuisines seeded: ${cuisines.map((c) => c.key).join(", ")}` : ""
);
console.log(failed ? `\n${failed} FAILURE(S)\n` : "\nAll checks passed.\n");
process.exit(failed ? 1 : 0);
