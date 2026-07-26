/**
 * Netlify Function wrapping the community write API.
 *
 * server/handlers.mjs is runtime-agnostic on purpose — `handle(path, body, ip)`
 * takes plain data and returns `{ status, json }` — so this file is only an
 * adapter. All the logic, validation and rate limiting lives there and is shared
 * verbatim with the local dev server. If you find yourself adding a rule here,
 * it belongs in handlers.mjs instead.
 *
 * Routing: netlify.toml redirects /api/* to this function, and the original
 * pathname survives in the request URL, so handle() sees the same "/api/reviews"
 * it sees locally.
 *
 * REQUIRED SITE ENVIRONMENT (Site settings > Environment variables):
 *   SUPABASE_URL             project URL
 *   SUPABASE_SECRET_KEY      service_role key — bypasses RLS, never ship to a browser
 *   IP_HASH_SALT             openssl rand -hex 24
 *   TURNSTILE_SECRET         real key, NOT the always-pass test one
 *   TURNSTILE_SITEKEY        public; served to the browser via /api/config
 *   TRUST_PROXY=netlify      REQUIRED. Without it every visitor hashes to the
 *                            platform's own address and the per-IP daily caps
 *                            become one global cap for the entire site.
 *   RATE_LIMIT_EXEMPT_IPS    leave EMPTY in production. A home address left here
 *                            is permanently exempt from every cap.
 */

// Imported lazily: handlers.mjs throws at module scope when the Supabase keys
// are missing, and a top-level import would take the whole function down with a
// stack trace instead of a diagnosable response.
let mod = null;
let loadError = null;

async function handlers() {
  if (mod || loadError) return mod;
  try {
    mod = await import("../../server/handlers.mjs");
  } catch (e) {
    loadError = e.message;
  }
  return mod;
}

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default async (request) => {
  const { pathname } = new URL(request.url);

  // Public runtime config. The sitekey is public by design; serving it rather
  // than hardcoding it means dev and production differ by env var alone.
  if (pathname === "/api/config" && request.method === "GET") {
    return json(200, { turnstile_sitekey: process.env.TURNSTILE_SITEKEY || null });
  }

  if (request.method !== "POST") {
    return json(405, { error: { code: "method_not_allowed" } });
  }

  const h = await handlers();
  if (!h) {
    // Mirrors dev.mjs: a bare 404 here reads as a frontend routing bug rather
    // than a missing key, and sends whoever debugs it to the wrong file.
    return json(503, {
      error: {
        code: "write_api_disabled",
        message: "Contributions are disabled: the server is missing its Supabase " +
                 "credentials. Set SUPABASE_URL and SUPABASE_SECRET_KEY in the " +
                 "site environment and redeploy.",
      },
    });
  }

  if (!h.isApiRoute(pathname)) {
    return json(404, { error: { code: "not_found", message: "Unknown route." } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: { code: "bad_body", message: "invalid JSON" } });
  }

  // Netlify sets x-nf-client-connection-ip and overwrites any client-supplied
  // copy, which is what makes it safe to trust. request.headers is a Headers
  // instance, not a plain object — hand resolveClientIp something it can index.
  const headers = Object.fromEntries(request.headers.entries());
  const ip = h.resolveClientIp(headers, "0.0.0.0");

  const { status, json: payload } = await h.handle(pathname, body, ip);
  return json(status, payload);
};

export const config = {
  // Claim every /api/* path so new routes in handlers.mjs need no config change.
  path: "/api/*",
};
