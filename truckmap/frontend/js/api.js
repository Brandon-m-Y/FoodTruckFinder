import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";

const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});

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

  const { data, error } = await db.rpc("trucks_at", params);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function cuisines() {
  const { data, error } = await db.from("cuisines").select("key,label").order("sort");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function truck(id) {
  const { data, error } = await db
    .from("trucks")
    .select("id,slug,name,cuisines,description,website,facebook,instagram,phone,rating_avg,rating_count")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Visible reviews only — RLS enforces that; this is not a client-side filter.
 *
 * Paged server-side via .range(). Fetching everything and slicing in the browser
 * would mean a payload that grows without bound on a section most people never
 * scroll; `count: "exact"` returns the total in the same round trip.
 */
export async function reviews(truckId, { limit = 10, offset = 0 } = {}) {
  const { data, error, count } = await db
    .from("reviews")
    .select("id,rating,body,author_name,created_at", { count: "exact" })
    .eq("truck_id", truckId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return { rows: data ?? [], total: count ?? 0 };
}

export async function pendingEdits(truckId) {
  const { data, error } = await db
    .from("truck_edits")
    .select("id,field,value,note,created_at")
    .eq("truck_id", truckId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Community writes. These POST to our own server, NOT to Supabase — the
 * database grants no anonymous INSERT policy on any table, so the browser
 * genuinely cannot write. server/handlers.mjs holds the secret key, verifies
 * Turnstile, and applies per-IP caps.
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
