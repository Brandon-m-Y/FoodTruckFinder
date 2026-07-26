/**
 * Local development server: static frontend + the community write API.
 *
 * Replaces `python -m http.server`, which could serve files but had nowhere to
 * put the write path. Zero dependencies beyond @supabase/supabase-js.
 *
 *   npm run dev        ->  http://127.0.0.1:5173
 *
 * In production the same handlers run as a Netlify Function; this file is the
 * only piece that is dev-only.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = join(ROOT, "frontend");
const PORT = Number(process.env.PORT ?? 5173);

// --- .env ---------------------------------------------------------------------
// Parsed by hand rather than via --env-file so a missing file is a helpful
// message instead of a stack trace.
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value && !(m[1] in process.env)) process.env[m[1]] = value;
  }
} else {
  console.error(`
  No .env found at ${envPath}

  The write API needs the Supabase SECRET key (it bypasses RLS; the browser
  cannot and must not have it). Create it:

      cp .env.example .env

  then fill in SUPABASE_SECRET_KEY from
  Dashboard > Project Settings > API Keys > secret.

  .env is gitignored. Reads work without it; writes will 500.
`);
}

// Import AFTER .env is loaded — handlers.mjs reads process.env at module scope.
let handle, isApiRoute, resolveClientIp;
let writeApiError = null;
try {
  ({ handle, isApiRoute, resolveClientIp } = await import("./handlers.mjs"));
} catch (e) {
  // Keep the reason. Returning a bare 404 here (the original behaviour) was
  // actively misleading: the browser reported "Request failed (404)", which
  // reads as a frontend routing bug rather than "the server has no key".
  writeApiError = e.message;
  console.error(`  Write API disabled: ${e.message}\n`);
  isApiRoute = () => false;
  resolveClientIp = (_h, socketIp) => socketIp; // never reached; keeps clientIp total
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function clientIp(req) {
  // Delegates to handlers.mjs so dev and production resolve addresses the same
  // way. With TRUST_PROXY unset — the normal local case — this is just the
  // socket address; the header path only opens when a platform is named.
  return resolveClientIp(req.headers, req.socket.remoteAddress ?? "0.0.0.0");
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
  });
  res.end(buf);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { fail(new Error("invalid JSON")); }
    });
    req.on("error", fail);
  });
}

function serveStatic(req, res, pathname) {
  // normalize() collapses ../ before the prefix check, so a crafted path
  // cannot escape the frontend directory.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: "forbidden" });

  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store", // dev: always reflect the file on disk
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  // Public runtime config. The Turnstile SITEKEY is public by design (it goes
  // in the page); serving it rather than hardcoding it in config.js means dev
  // and production differ by env var alone, with no duplicated constant to
  // drift. Null when unconfigured, which tells the client to skip the widget —
  // matching the server, which skips verification when the SECRET is unset.
  if (pathname === "/api/config" && req.method === "GET") {
    return sendJson(res, 200, {
      turnstile_sitekey: process.env.TURNSTILE_SITEKEY || null,
    });
  }

  if (pathname.startsWith("/api/")) {
    if (req.method !== "POST") return sendJson(res, 405, { error: { code: "method_not_allowed" } });

    if (writeApiError) {
      return sendJson(res, 503, {
        error: {
          code: "write_api_disabled",
          message:
            "Contributions are disabled: the server has no Supabase secret key. " +
            "Copy .env.example to .env, set SUPABASE_SECRET_KEY, and restart `npm run dev`.",
        },
      });
    }

    if (!isApiRoute(pathname)) return sendJson(res, 404, { error: { code: "not_found" } });

    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJson(res, 400, { error: { code: "bad_body", message: e.message } }); }

    const { status, json } = await handle(pathname, body, clientIp(req));
    return sendJson(res, status, json);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: { code: "method_not_allowed" } });
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  TruckMap dev  ->  http://127.0.0.1:${PORT}`);
  console.log(`  static: ${PUBLIC}`);
  console.log(`  api:    POST /api/reviews  /api/edits  /api/submissions  /api/sightings\n`);
});
