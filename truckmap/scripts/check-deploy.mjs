/**
 * Verify a DEPLOYED site from the outside, as a stranger would see it.
 *
 * scripts/smoke.mjs checks the database. This checks the thing in front of it:
 * that the function is running, that the environment is configured, and above
 * all that the bot gate is genuinely armed rather than merely present.
 *
 * That last one is the point. Every other misconfiguration here announces
 * itself — a missing key gives a 503, a broken route gives a 404. But a site
 * running Cloudflare's always-pass TEST secret behaves EXACTLY like a correctly
 * protected one from the browser: the widget renders, tokens are minted,
 * submissions succeed. The only way to tell from outside is to send a token
 * that a real secret must reject, and see whether it is rejected.
 *
 * NOTHING IS WRITTEN. Every probe carries a deliberately invalid rating (99),
 * so on any path where Turnstile lets the request through, validation refuses
 * it before a row is created. The status code says which happened.
 *
 * Usage:
 *   node scripts/check-deploy.mjs https://tacotrucks.netlify.app
 */
const site = (process.argv[2] ?? process.env.SITE_URL ?? "").replace(/\/+$/, "");
if (!site) {
  console.error("\n  Usage: node scripts/check-deploy.mjs https://your-site.netlify.app\n");
  process.exit(2);
}

let failed = 0;
const pass = (m, extra = "") => console.log(`  PASS  ${m}${extra && "  " + extra}`);
const fail = (m, why) => { failed++; console.log(`  FAIL  ${m}\n        ${why}`); };
const warn = (m, why) => console.log(`  WARN  ${m}\n        ${why}`);

const post = async (path, body) => {
  const res = await fetch(`${site}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

console.log(`\nDeploy check -> ${site}\n`);

// 1. The site is up and is this project.
{
  const res = await fetch(site);
  const html = await res.text();
  res.ok && /Food Truck Finder/.test(html)
    ? pass("site responds and serves this build", `(${res.status})`)
    : fail("site responds and serves this build", `HTTP ${res.status}`);

  // Headers come from netlify.toml. Their absence means the file was not read —
  // usually a base-directory problem, which would also mean no CSP at all.
  const csp = res.headers.get("content-security-policy");
  csp ? pass("Content-Security-Policy header present")
      : fail("Content-Security-Policy header present",
             "netlify.toml headers are not being applied");
}

// 2. The function is deployed and serving public config.
let sitekey = null;
{
  const res = await fetch(`${site}/api/config`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail("GET /api/config", `HTTP ${res.status} — function not deployed?`);
  else {
    sitekey = body.turnstile_sitekey;
    pass("GET /api/config — function is live", `sitekey ${sitekey ? "present" : "NULL"}`);
  }
}

// 3. Turnstile sitekey is real, not one of Cloudflare's test values.
if (!sitekey) {
  fail("TURNSTILE_SITEKEY configured",
    "null — the widget will be a no-op and every write will go unchallenged");
} else if (/^[123]x0{6}/.test(sitekey)) {
  fail("TURNSTILE_SITEKEY is a real key",
    `${sitekey} is a Cloudflare TEST key — the bot gate verifies nothing`);
} else {
  pass("TURNSTILE_SITEKEY is a real key", sitekey);
}

// 4. A write with NO token must be refused. This proves TURNSTILE_SECRET is set:
//    with it unset, verifyTurnstile() returns early and the request proceeds.
{
  const { status, json } = await post("/api/reviews", { truck_id: 1, rating: 99 });
  if (status === 503) {
    fail("write API is configured",
      "503 write_api_disabled — SUPABASE_URL / SUPABASE_SECRET_KEY are not set");
  } else if (status === 403 && json?.error?.code === "turnstile_required") {
    pass("write with no token refused", "(403 turnstile_required)");
  } else if (status === 400) {
    fail("write with no token refused",
      "got 400 — the request passed the bot gate, so TURNSTILE_SECRET is UNSET. " +
      "Writes are currently unprotected.");
  } else {
    fail("write with no token refused", `unexpected ${status} ${JSON.stringify(json)}`);
  }
}

// 5. THE ONE THAT MATTERS. A garbage token must be REJECTED.
//    Real secret  -> Cloudflare says invalid-input-response -> 403 turnstile_failed.
//    TEST secret  -> Cloudflare says success for anything    -> request proceeds,
//                    and only the invalid rating stops it     -> 400.
{
  const { status, json } = await post("/api/reviews", {
    truck_id: 1, rating: 99, turnstile_token: "not-a-real-token",
  });
  if (status === 403 && json?.error?.code === "turnstile_failed") {
    pass("garbage token REJECTED — the bot gate is genuinely armed");
  } else if (status === 400) {
    fail("garbage token REJECTED",
      "got 400 bad_request, meaning Cloudflare ACCEPTED a fabricated token. " +
      "TURNSTILE_SECRET is an always-pass TEST key. Anyone can write.");
  } else if (status === 503) {
    fail("garbage token REJECTED", "503 — write API not configured");
  } else {
    fail("garbage token REJECTED", `unexpected ${status} ${JSON.stringify(json)}`);
  }
}

// 6. TRUST_PROXY cannot be read from outside, so flag it as unverifiable rather
//    than implying it passed. Its failure is silent by nature: the caps simply
//    apply to everyone at once, which looks like nothing at all until a real
//    visitor is turned away by someone else's quota.
warn("TRUST_PROXY=netlify cannot be checked remotely",
  "confirm it in the Netlify environment. Without it every visitor shares one " +
  "ip_hash and the per-IP daily caps become a single global cap.");

console.log(failed ? `\n  ${failed} FAILURE(S) — not ready for public traffic.\n`
                   : "\n  Deploy looks correctly configured.\n");
process.exit(failed ? 1 : 0);
