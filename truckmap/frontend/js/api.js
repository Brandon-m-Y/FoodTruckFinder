/**
 * Data access. Plain fetch against PostgREST — no client library.
 *
 * WHY NOT @supabase/supabase-js
 * -----------------------------
 * It used to be imported from esm.sh at runtime. Three problems with that, in
 * order of how much they matter:
 *
 *   1. UNVERIFIED THIRD-PARTY CODE IN THE CRITICAL PATH. Leaflet is pinned with
 *      a subresource-integrity hash, so a compromised CDN cannot alter it.
 *      A bare `import` cannot carry an integrity attribute, so the client
 *      library had no such protection — and it executed with full DOM access on
 *      pages containing the review and add-truck forms. It could have read every
 *      submission before it was sent. That is a wider hole than anything in the
 *      database, and it sat outside our control.
 *
 *   2. VERSION DRIFT. The browser pinned 2.58.0 while package.json pinned
 *      ^2.110.8 for the server. One project, one library, 52 minor versions
 *      apart, and nothing in place to notice the gap.
 *
 *   3. WEIGHT. ~120KB to perform five GETs and one POST. Most of that library is
 *      auth, realtime and storage — none of which the browser uses here, because
 *      every write goes through our own server instead.
 *
 * Supabase's data API *is* PostgREST, which is ordinary HTTP. What follows is
 * the whole of what the library was doing for us, minus the supply chain.
 *
 * The server still uses the real library (scripts/, server/) — there it is an
 * npm dependency with a lockfile, which is a completely different risk profile
 * from a CDN fetch at page load.
 */
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const REST = `${SUPABASE_URL}/rest/v1`;

/**
 * PostgREST wants the key in `apikey`; Supabase's gateway also reads
 * `Authorization` to decide which role the request runs as. The library sent
 * both and both are still needed — with only `apikey`, the request carries no
 * role and every RLS policy evaluates against nobody.
 */
const authHeaders = () => ({
  apikey: SUPABASE_PUBLISHABLE_KEY,
  authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
});

/**
 * PostgREST reports failures as JSON `{ message, details, hint, code }` with a
 * non-2xx status. Surface `message`, since that is what callers already render,
 * and fall back to the status when the body is not JSON — a gateway error, say,
 * which never reached PostgREST at all.
 */
async function fail(res) {
  let msg = `Request failed (${res.status})`;
  try {
    const body = await res.json();
    if (body?.message) msg = body.message;
  } catch { /* not JSON — keep the status */ }
  throw new Error(msg);
}

async function get(path, { headers = {}, raw = false } = {}) {
  const res = await fetch(`${REST}/${path}`, {
    headers: { ...authHeaders(), ...headers },
  });
  if (!res.ok) return fail(res);
  return raw ? res : res.json();
}

async function rpc(fn, params) {
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  if (!res.ok) return fail(res);
  return res.json();
}

/**
 * `Content-Range: 0-9/17` — the figure after the slash is the total matching
 * rows, which is what `count: "exact"` was for. An empty result reports `* /0`,
 * so parse the tail defensively rather than assuming a numeric prefix.
 */
function totalFromContentRange(res) {
  const total = res.headers.get("content-range")?.split("/")?.[1];
  const n = Number.parseInt(total ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

/** PostgREST filter syntax: column=op.value */
const eq = (col, val) => `${col}=eq.${encodeURIComponent(val)}`;

// --- reads -------------------------------------------------------------------

/**
 * The map's only read call.
 *
 * `trucks_at` is a SECURITY DEFINER function that computes appearance
 * confidence at an ARBITRARY instant rather than reading a stored column —
 * which is exactly what makes the time scrubber possible. Passing a different
 * `p_as_of` re-scores everything server-side; there is nothing to recompute here.
 *
 * @param {Date}   asOf
 * @param {object} [opts]
 * @param {L.LatLngBounds} [opts.bounds] restrict to the current viewport
 * @param {number} [opts.minConfidence]
 * @param {string[]} [opts.cuisines]
 */
export async function trucksAt(asOf, opts = {}) {
  const params = {
    p_as_of: asOf.toISOString(),
    p_min_confidence: opts.minConfidence ?? 0,
  };

  if (opts.bounds) {
    params.p_west = opts.bounds.getWest();
    params.p_south = opts.bounds.getSouth();
    params.p_east = opts.bounds.getEast();
    params.p_north = opts.bounds.getNorth();
  }
  if (opts.cuisines?.length) params.p_cuisines = opts.cuisines;

  return (await rpc("trucks_at", params)) ?? [];
}

export async function cuisines() {
  return (await get("cuisines?select=key,label&order=sort")) ?? [];
}

export async function truck(id) {
  const cols = "id,slug,name,cuisines,description,website,facebook,instagram,"
    + "phone,rating_avg,rating_count";
  // `vnd.pgrst.object+json` is the wire form of .single(): PostgREST returns a
  // bare object, and fails the request if the filter did not match exactly one
  // row rather than handing back an array for the caller to unwrap.
  return get(`trucks?select=${cols}&${eq("id", id)}`, {
    headers: { accept: "application/vnd.pgrst.object+json" },
  });
}

/**
 * Visible reviews only — RLS enforces that; this is not a client-side filter.
 *
 * Paged server-side. Fetching everything and slicing in the browser would mean a
 * payload that grows without bound on a section most people never scroll;
 * `Prefer: count=exact` returns the total in the same round trip, as a header.
 */
export async function reviews(truckId, { limit = 10, offset = 0 } = {}) {
  const q = "reviews?select=id,rating,body,author_name,created_at"
    + `&${eq("truck_id", truckId)}`
    + `&order=created_at.desc&limit=${limit}&offset=${offset}`;

  const res = await fetch(`${REST}/${q}`, {
    headers: { ...authHeaders(), prefer: "count=exact" },
  });

  // 416 Range Not Satisfiable: `offset` is past the end of the result set.
  // That is not an error here — it is what an open detail sheet sees when
  // reviews are removed while the reader is on a later page. detail.js recovers
  // by stepping back a page, and to do that it needs the TOTAL, which PostgREST
  // still reports as `Content-Range: * /<total>` alongside the 416. Throwing
  // instead would replace a self-healing pager with an error banner.
  //
  // This DELIBERATELY diverges from supabase-js, which reported `count: null`
  // on a 416 and so effectively lost the total. detail.js computes its fallback
  // page as `ceil(total / PAGE_SIZE) - 1`; with a lost total that is `-1`,
  // clamped to 0, and the reader is thrown back to the first page. With the real
  // total they land on the last page that still exists, which is where they were
  // trying to be. Keeping the number is the whole point of reading it here.
  if (res.status === 416) return { rows: [], total: totalFromContentRange(res) };
  if (!res.ok) return fail(res);

  return { rows: (await res.json()) ?? [], total: totalFromContentRange(res) };
}

export async function pendingEdits(truckId) {
  const q = "truck_edits?select=id,field,value,note,created_at"
    + `&${eq("truck_id", truckId)}&${eq("status", "pending")}`
    + "&order=created_at.desc&limit=20";
  return (await get(q)) ?? [];
}

// --- writes ------------------------------------------------------------------

/**
 * Community writes. These POST to our own server, NOT to Supabase — the
 * database grants no anonymous INSERT policy on any table and no anonymous
 * EXECUTE on any write RPC (migration 0013), so the browser genuinely cannot
 * write. server/handlers.mjs holds the secret key, verifies Turnstile, and
 * applies per-IP caps.
 */
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json;
}

export const submitReview = (b) => post("/api/reviews", b);
export const submitEdit = (b) => post("/api/edits", b);
export const submitTruck = (b) => post("/api/submissions", b);
export const submitSighting = (b) => post("/api/sightings", b);
