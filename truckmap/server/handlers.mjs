/**
 * Community write handlers.
 *
 * Every anonymous write funnels through here because the database grants no
 * anonymous INSERT policy on ANY table — the browser physically cannot write.
 * This module holds the secret key and is the only thing that can.
 *
 * Runtime-agnostic on purpose: `handle(route, body, ip)` takes plain data and
 * returns `{ status, json }`, so the same logic backs both the local dev server
 * (server/dev.mjs) and a Netlify Function later. No req/res coupling.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const IP_HASH_SALT = process.env.IP_HASH_SALT ?? "";
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET ?? "";

if (!SUPABASE_URL || !SECRET_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SECRET_KEY must be set (copy .env.example to .env)"
  );
}
if (!IP_HASH_SALT || IP_HASH_SALT === "change-me") {
  console.warn(
    "  WARNING: IP_HASH_SALT is unset or default — stored ip_hashes are\n" +
    "           brute-forceable across the IPv4 space. Set a real one:\n" +
    "             openssl rand -hex 24\n"
  );
}

// Running on a known platform without TRUST_PROXY means every visitor hashes to
// the proxy's address. Say so loudly at boot — the symptom (one shared rate
// limit for the whole site) is otherwise indistinguishable from a bug here.
if (!process.env.TRUST_PROXY && (process.env.NETLIFY || process.env.VERCEL)) {
  console.warn(
    "  WARNING: running behind a platform proxy with TRUST_PROXY unset.\n" +
    "           Every visitor will share ONE ip_hash, collapsing the per-IP\n" +
    "           daily caps into a single global cap. Set TRUST_PROXY=netlify\n" +
    "           (or vercel / cloudflare) in the site environment.\n"
  );
}

/**
 * The Turnstile sitekey and secret are a PAIR and must be configured together.
 *
 * Neither half fails loudly on its own, and one of the two ways to get it wrong
 * is genuinely dangerous:
 *
 *   SITEKEY set, SECRET missing   The widget renders, the browser mints real
 *                                 tokens, and verifyTurnstile() returns early
 *                                 because TURNSTILE_SECRET is falsy. Every
 *                                 write is accepted unverified — a public,
 *                                 unprotected write endpoint that looks
 *                                 protected from the outside, including to you.
 *
 *   SECRET set, SITEKEY missing   turnstile.js gets a null sitekey from
 *                                 /api/config and becomes a no-op, so no token
 *                                 is ever sent, so every write is rejected with
 *                                 "Verification required." Loud, but it points
 *                                 at the wrong half.
 *
 * Cloudflare's always-pass TEST keys start 1x/2x/3x; real ones start 0x. Mixing
 * a real sitekey with a test secret is the same hazard as the first case above
 * wearing a disguise: real tokens arrive and are rubber-stamped.
 */
{
  const sitekey = process.env.TURNSTILE_SITEKEY ?? "";
  const isTest = (k) => /^[123]x0{6}/.test(k);

  if (sitekey && !TURNSTILE_SECRET) {
    console.warn(
      "  WARNING: TURNSTILE_SITEKEY is set but TURNSTILE_SECRET is NOT.\n" +
      "           The widget will render and mint tokens, and this server will\n" +
      "           SKIP verification entirely. Writes are unprotected. Set the\n" +
      "           secret or unset the sitekey — do not ship this pairing.\n"
    );
  } else if (TURNSTILE_SECRET && !sitekey) {
    console.warn(
      "  WARNING: TURNSTILE_SECRET is set but TURNSTILE_SITEKEY is NOT.\n" +
      "           The browser will send no token and every write will fail with\n" +
      "           'Verification required'. Set the sitekey too.\n"
    );
  } else if (sitekey && TURNSTILE_SECRET && isTest(sitekey) !== isTest(TURNSTILE_SECRET)) {
    console.warn(
      "  WARNING: Turnstile keys are mismatched — one is a Cloudflare TEST key\n" +
      "           and the other is real. A test SECRET accepts any token, so a\n" +
      "           real sitekey paired with it verifies nothing. Use both from\n" +
      "           the same widget.\n"
    );
  } else if (sitekey && isTest(sitekey)) {
    console.warn(
      "  NOTE: using Cloudflare's always-pass TEST Turnstile keys. Fine for\n" +
      "        local development; the bot gate verifies nothing.\n"
    );
  }
}

// service_role client: bypasses RLS entirely. Never expose this to a browser.
const db = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Raw IPs are never stored — only a salted hash, matching the schema's contract. */
const ipHash = (ip) => createHash("sha256").update(IP_HASH_SALT + ip).digest("hex");
const tokenHash = (t) => (t ? createHash("sha256").update(t).digest("hex") : null);

// Per-IP daily caps. Crude, and deliberately so — see the SPAM note in
// migration 0007. These are a speed bump, not an abuse defence.
const DAILY_CAP = { review: 5, edit: 10, submission: 3, sighting: 20 };

/**
 * Addresses exempt from the caps above — your own machine, so testing does not
 * consume a real user's quota. Everyone else stays on the production limits.
 *
 * RATE_LIMIT_EXEMPT_IPS is a comma-separated list of RAW addresses. Nothing is
 * exempt unless it is listed: no automatic loopback pass, because behind a
 * reverse proxy the peer address IS loopback for every visitor, which would
 * silently exempt the entire internet.
 */
const EXEMPT_IPS = new Set(
  (process.env.RATE_LIMIT_EXEMPT_IPS ?? "")
    .split(",")
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean)
);

/** `::ffff:127.0.0.1` and `127.0.0.1` are the same host; compare them as such. */
function normalizeIp(ip) {
  if (!ip) return "";
  const s = String(ip).trim().toLowerCase();
  if (s.startsWith("::ffff:")) return s.slice(7);
  if (s === "::1") return "127.0.0.1";
  return s;
}

/**
 * Resolve the real client address from request headers.
 *
 * THE FAILURE THIS PREVENTS
 * Behind any reverse proxy — Netlify, Cloudflare, a load balancer — the socket
 * peer address is the PROXY, identical for every visitor on earth. Hash that and
 * every request shares one ip_hash: the per-IP daily caps become a single global
 * cap that the first few visitors of the day exhaust for everyone, and the
 * one-review-per-person rule makes the entire internet one person whose second
 * review overwrites their first. It fails quietly and looks like a bug in the
 * app, not in the deployment.
 *
 * WHY THE HEADER LIST IS CLOSED
 * Trusting `x-forwarded-for` from an arbitrary client is worse than the problem:
 * it is caller-supplied text, so anyone could rotate their apparent address per
 * request and defeat every cap deliberately. Only headers a known platform sets
 * (and overwrites) are honoured, and only when TRUST_PROXY names that platform.
 * Unset means "direct connection" and the socket address wins.
 *
 * x-forwarded-for may be a chain "client, proxy1, proxy2". The LEFTMOST entry is
 * the original client — and the part an attacker controls, which is exactly why
 * it is only read when the platform is known to overwrite the header.
 *
 * @param {Record<string,string|string[]|undefined>} headers
 * @param {string} socketIp  peer address, the fallback
 */
export function resolveClientIp(headers = {}, socketIp = "") {
  const platform = (process.env.TRUST_PROXY ?? "").trim().toLowerCase();
  const get = (name) => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const header = {
    netlify: "x-nf-client-connection-ip",
    cloudflare: "cf-connecting-ip",
    vercel: "x-vercel-forwarded-for",
    // Generic reverse proxy you control (nginx, Caddy). Only meaningful if that
    // proxy SETS x-forwarded-for rather than appending to a client-supplied one.
    xff: "x-forwarded-for",
  }[platform];

  if (header) {
    const raw = get(header);
    if (raw) {
      const first = String(raw).split(",")[0].trim();
      if (first) return first;
    }
  }
  return socketIp;
}

/** Exempt callers get an effectively unlimited cap; everyone else the real one. */
const capFor = (kind, exempt) => (exempt ? 1_000_000 : DAILY_CAP[kind]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, "bad_request", msg);

/**
 * Cloudflare Turnstile. Skipped when unset so local development works out of
 * the box; the .env.example ships Cloudflare's always-pass TEST keys, and
 * production must set real ones.
 */
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return; // not configured — dev only
  if (!token) throw new HttpError(403, "turnstile_required", "Verification required.");

  const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip });
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const out = await res.json();
  if (!out.success) {
    throw new HttpError(403, "turnstile_failed", "Verification failed. Please try again.");
  }
}

/**
 * Every write goes through a SECURITY DEFINER RPC (migration 0009).
 *
 * We cannot touch `private` from here directly: service_role bypasses RLS but
 * NOT PostgREST schema exposure, and `private` is deliberately unexposed. The
 * RPCs are the only door, and they are EXECUTE-revoked from anon/authenticated.
 *
 * Each RPC also does the cap check, the insert, and the audit row in ONE
 * transaction — so a partial write is impossible.
 */
async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (!error) return data;

  if (error.code === "TM429") {
    throw new HttpError(429, "rate_limited", "Daily limit reached. Try again tomorrow.");
  }
  if (error.code === "23505") {
    throw new HttpError(429, "already_reported", "You already reported this in the last hour.");
  }
  if (error.code === "23514" || error.code === "22001") {
    throw new HttpError(400, "bad_request", "That value isn't valid.");
  }
  if (error.code === "23503") {
    // FK violation — the truck or the appearance is gone. Don't name which;
    // guessing wrong sends people looking in the wrong place.
    throw new HttpError(404, "not_found",
      "That truck or stop no longer exists. Try reloading the map.");
  }
  throw new HttpError(500, "write_failed", error.message || "Write failed.");
}

// --- validation helpers ------------------------------------------------------

const str = (v, { max, min = 1, name, required = true }) => {
  if (v == null || v === "") {
    if (required) throw bad(`${name} is required.`);
    return null;
  }
  if (typeof v !== "string") throw bad(`${name} must be text.`);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} is too short.`);
  if (s.length > max) throw bad(`${name} must be ${max} characters or fewer.`);
  return s;
};

const int = (v, { min, max, name }) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return n;
};

// --- routes ------------------------------------------------------------------

/**
 * Star rating + optional prose. One review per (truck, ip_hash): a second
 * submission UPDATES the first rather than stacking, matching the schema's
 * uq_review_per_truck.
 */
async function postReview(body, hash, tHash, exempt) {
  const out = await rpc("submit_review", {
    p_truck_id: int(body.truck_id, { min: 1, max: 2 ** 40, name: "truck_id" }),
    p_rating: int(body.rating, { min: 1, max: 5, name: "rating" }),
    p_body: str(body.body, { max: 2000, min: 2, name: "Review", required: false }),
    p_author_name: str(body.author_name, { max: 40, name: "Name", required: false }),
    p_ip_hash: hash,
    p_turnstile_hash: tHash,
    p_daily_cap: capFor("review", exempt),
    // Exempt addresses may stack reviews on one truck. Everyone else keeps the
    // one-per-person rule, where a resubmission edits the existing review.
    p_allow_multiple: exempt,
  });
  return { status: out.updated ? 200 : 201, json: out };
}

/** Proposed change to a descriptive field. Always lands 'pending'. */
async function postEdit(body, hash, tHash, exempt) {
  const allowed = ["description", "website", "facebook", "instagram", "phone", "cuisines"];
  const field = str(body.field, { max: 20, name: "field" });
  if (!allowed.includes(field)) throw bad("Unknown field.");

  const out = await rpc("submit_edit", {
    p_truck_id: int(body.truck_id, { min: 1, max: 2 ** 40, name: "truck_id" }),
    p_field: field,
    p_value: str(body.value, { max: 2000, name: "Value" }),
    p_note: str(body.note, { max: 500, name: "Note", required: false }),
    p_ip_hash: hash,
    p_turnstile_hash: tHash,
    p_daily_cap: capFor("edit", exempt),
  });
  return { status: 201, json: out };
}

/** "You're missing a truck." Intake queue; never writes public.trucks. */
async function postSubmission(body, hash, tHash, exempt) {
  const name = str(body.name, { max: 120, min: 2, name: "Truck name" });
  const description = str(body.description, { max: 2000, name: "Description", required: false });
  const whereNote = str(body.where_note, { max: 300, name: "Location note", required: false });
  const cuisines = Array.isArray(body.cuisines)
    ? body.cuisines.filter((c) => typeof c === "string").slice(0, 6)
    : [];

  let lat = null, lon = null;
  if (body.lat != null && body.lon != null) {
    lat = Number(body.lat);
    lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw bad("Invalid coordinates.");
    }
  }

  // How long the stop is assumed to last. Clamped again in SQL — never trust
  // a client-supplied duration to size a window on the map.
  const hours = body.hours == null
    ? 3
    : int(body.hours, { min: 1, max: 12, name: "Duration" });

  const out = await rpc("submit_truck", {
    p_name: name,
    p_cuisines: cuisines,
    p_description: description,
    p_where_note: whereNote,
    p_website: str(body.website, { max: 300, name: "Website", required: false }),
    p_facebook: str(body.facebook, { max: 300, name: "Facebook", required: false }),
    p_instagram: str(body.instagram, { max: 300, name: "Instagram", required: false }),
    p_phone: str(body.phone, { max: 40, name: "Phone", required: false }),
    p_lat: lat,
    p_lon: lon,
    p_ip_hash: hash,
    p_turnstile_hash: tHash,
    p_daily_cap: capFor("submission", exempt),
    p_hours: hours,
  });
  return { status: 201, json: out };
}

/**
 * "It's here right now" / "it isn't". Feeds appearance confidence with a
 * 45-minute half-life. appearance_id may be null — that is the discovery path
 * for unscheduled stops.
 */
async function postSighting(body, hash, tHash, exempt) {
  const truckId = int(body.truck_id, { min: 1, max: 2 ** 40, name: "truck_id" });
  const kind = str(body.kind, { max: 10, name: "kind" });
  if (!["here", "not_here", "gone"].includes(kind)) throw bad("Unknown sighting kind.");

  const appearanceId = body.appearance_id == null
    ? null
    : int(body.appearance_id, { min: 1, max: 2 ** 40, name: "appearance_id" });

  const lat = Number(body.lat), lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw bad("Coordinates are required.");

  const out = await rpc("submit_sighting", {
    p_truck_id: truckId,
    p_appearance_id: appearanceId,
    p_kind: kind,
    p_lat: lat,
    p_lon: lon,
    p_ip_hash: hash,
    p_turnstile_hash: tHash,
    p_daily_cap: capFor("sighting", exempt),
  });
  return { status: 201, json: out };
}

const ROUTES = {
  "/api/reviews": postReview,
  "/api/edits": postEdit,
  "/api/submissions": postSubmission,
  "/api/sightings": postSighting,
};

export function isApiRoute(path) {
  return Object.hasOwn(ROUTES, path);
}

/** @returns {Promise<{status:number, json:object}>} */
export async function handle(path, body, ip) {
  const fn = ROUTES[path];
  if (!fn) return { status: 404, json: { error: { code: "not_found", message: "Unknown route." } } };

  try {
    const hash = ipHash(ip);
    const exempt = EXEMPT_IPS.has(normalizeIp(ip));
    const token = typeof body?.turnstile_token === "string" ? body.turnstile_token : null;
    await verifyTurnstile(token, ip);
    return await fn(body ?? {}, hash, tokenHash(token), exempt);
  } catch (e) {
    if (e instanceof HttpError) {
      return { status: e.status, json: { error: { code: e.code, message: e.message } } };
    }
    console.error("unhandled:", e);
    return { status: 500, json: { error: { code: "internal", message: "Something went wrong." } } };
  }
}
