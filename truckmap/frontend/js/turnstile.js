/**
 * Cloudflare Turnstile — the anti-bot gate on every community write.
 *
 * Tokens are SINGLE USE and expire after ~5 minutes, so a widget cannot be
 * rendered once and reused. Each guarded action gets its own widget, and the
 * widget is reset after every successful submit to mint a fresh token.
 *
 * Degrades cleanly: if the server reports no sitekey (TURNSTILE_SITEKEY unset),
 * every guard becomes a no-op and getToken() returns null — which mirrors the
 * server skipping verification when TURNSTILE_SECRET is unset. The two must
 * agree, or every write fails with "Verification required".
 */

let sitekeyPromise = null;

async function sitekey() {
  sitekeyPromise ??= fetch("/api/config")
    .then((r) => r.json())
    .then((j) => j.turnstile_sitekey ?? null)
    .catch(() => null);
  return sitekeyPromise;
}

let scriptPromise = null;

function loadScript() {
  scriptPromise ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the verification widget."));
    document.head.append(s);
  });
  return scriptPromise;
}

/**
 * Mount a widget into `container`.
 * @returns {Promise<{getToken:()=>Promise<string|null>, reset:()=>void}>}
 */
export async function guard(container) {
  const key = await sitekey();

  // Not configured — no-op guard so local development works without keys.
  if (!key) return { getToken: async () => null, reset: () => {} };

  await loadScript();

  let resolveToken;
  let pending = new Promise((r) => (resolveToken = r));
  let token = null;

  const id = window.turnstile.render(container, {
    sitekey: key,
    appearance: "interaction-only", // invisible unless a challenge is needed
    callback: (t) => {
      token = t;
      resolveToken(t);
    },
    "expired-callback": () => {
      token = null;
      pending = new Promise((r) => (resolveToken = r));
      window.turnstile.reset(id);
    },
    "error-callback": () => {
      token = null;
      resolveToken(null);
    },
  });

  return {
    async getToken() {
      if (token) return token;
      // Give the challenge a bounded window rather than hanging a form forever.
      return Promise.race([
        pending,
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ]);
    },
    reset() {
      token = null;
      pending = new Promise((r) => (resolveToken = r));
      try { window.turnstile.reset(id); } catch { /* widget already gone */ }
    },
  };
}
