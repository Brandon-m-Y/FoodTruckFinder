/**
 * Google Analytics 4 (gtag.js) initialisation.
 *
 * WHY THIS IS A FILE AND NOT AN INLINE <script>
 * Google ships this snippet as inline script. Inlining it here would require
 * adding 'unsafe-inline' to script-src, which switches off the single most
 * valuable clause in the Content-Security-Policy: the one that stops injected
 * markup from executing. Trading XSS protection for an analytics tag is a bad
 * deal, and it would apply to the whole site, not just this snippet.
 *
 * The alternative is a CSP hash of the inline block, which works but silently
 * breaks the moment anyone edits a character of it. An external file needs
 * neither: it is covered by the 'self' that is already there.
 *
 * A classic script, not an ES module, on purpose. `dataLayer` and `gtag` must be
 * globals — module scope would hide them, and anything that later wants to send
 * an event would find `gtag is not defined`.
 */

// Measurement ID. Public by design: it is visible in the page and in every
// request the tag makes. Hardcoded for the same reason config.js hardcodes the
// Supabase URL — there is no build step to inject it, and it is not a secret.
var GA_MEASUREMENT_ID = "G-QVWQ4JB12G";

window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag("js", new Date());
gtag("config", GA_MEASUREMENT_ID);
