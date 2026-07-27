import { BASEMAP, DEFAULT_VIEW, MIN_ZOOM } from "./config.js";
import { fmtRange } from "./time.js";

let map = null;
let tiles = null;
const layer = L.layerGroup();

/**
 * appearance_id -> { marker, row, exitTimer }
 *
 * Keyed state, not a throwaway list, because render() diffs against it. See the
 * note on render() for why that matters.
 */
const markers = new Map();

/** Positron by day, Dark Matter by night — the palette already flips, the map should too. */
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const tileUrl = () => (darkQuery.matches ? BASEMAP.dark : BASEMAP.light);

export function initMap() {
  map = L.map("map", {
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    minZoom: MIN_ZOOM,
    zoomControl: true,
  });

  tiles = L.tileLayer(tileUrl(), {
    maxZoom: BASEMAP.maxZoom,
    attribution: BASEMAP.attribution,
    detectRetina: true, // fills the {r} slot with @2x where it helps
  }).addTo(map);

  // Follow the system theme live rather than only at load: someone flipping to
  // dark mode at dusk should not be left with a white map under a dark UI.
  darkQuery.addEventListener("change", () => tiles?.setUrl(tileUrl()));

  layer.addTo(map);
  return map;
}

function icon(bucket) {
  return L.divIcon({
    className: "",
    html: `<div class="pin ${bucket}">🌮</div>`,
    iconSize: [25, 25],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

function popupHtml(row) {
  const where = row.venue_name ?? "Ad-hoc stop";
  return `
    <div class="pop-name">${esc(row.truck_name)}</div>
    <div class="pop-line">${esc(where)}</div>
    <div class="pop-line">${esc(fmtRange(row.starts_at, row.ends_at))}</div>
    <div class="pop-conf">
      <span class="badge ${row.bucket}">${row.bucket}</span>
      &nbsp;${Number(row.confidence).toFixed(0)}/100
      ${row.recent_here ? `&middot; ${row.recent_here} recent sighting${row.recent_here > 1 ? "s" : ""}` : ""}
    </div>
    <button class="btn pop-btn" type="button" data-open-appearance="${row.appearance_id}">
      Reviews &amp; report
    </button>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** How long .pin-leaving runs before the marker is actually removed. Match the CSS. */
const EXIT_MS = 180;

/**
 * Reconcile the map with `rows`.
 *
 * This DIFFS rather than rebuilding. The previous version called
 * layer.clearLayers() and recreated every marker on each call, which the time
 * scrubber invokes on a 140ms debounce — so dragging it destroyed and rebuilt
 * the entire marker set several times a second. Three consequences, all fixed
 * by keeping identity:
 *
 *   - Nothing could animate. A marker that is deleted and replaced has no
 *     continuity to transition along, so entries and exits could only ever pop.
 *   - An open popup closed on every scrub. Read a truck's details, nudge the
 *     slider, and the popup you were reading vanished.
 *   - Every marker's DOM node was rebuilt to redraw a set that had usually
 *     barely changed.
 *
 * Now: markers that persist are updated in place, new ones fade in, departed
 * ones fade out and are removed after the animation. `appearance_id` is the
 * identity — it is one truck at one place in one time window, which is exactly
 * the thing a pin represents.
 */
export function render(rows) {
  const seen = new Set();

  for (const row of rows) {
    if (row.lat == null || row.lon == null) continue;
    seen.add(row.appearance_id);

    const existing = markers.get(row.appearance_id);

    if (existing) {
      // Reappeared while mid-exit — cancel the removal and un-fade it.
      if (existing.exitTimer) {
        clearTimeout(existing.exitTimer);
        existing.exitTimer = null;
        existing.marker.getElement()?.firstElementChild?.classList.remove("pin-leaving");
      }

      const { marker, row: prev } = existing;
      if (prev.lat !== row.lat || prev.lon !== row.lon) marker.setLatLng([row.lat, row.lon]);
      // Only touch the icon when the bucket actually changed: setIcon replaces
      // the DOM node, which would restart the entry animation on every scrub.
      if (prev.bucket !== row.bucket) marker.setIcon(icon(row.bucket));
      // setPopupContent rather than bindPopup — it updates an OPEN popup in
      // place instead of tearing it down.
      marker.setPopupContent(popupHtml(row));
      marker.options.title = row.truck_name;
      existing.row = row;
      continue;
    }

    const marker = L.marker([row.lat, row.lon], {
      icon: icon(row.bucket),
      title: row.truck_name,
      riseOnHover: true,
    }).bindPopup(popupHtml(row));
    marker.addTo(layer);
    marker.getElement()?.firstElementChild?.classList.add("pin-entering");
    markers.set(row.appearance_id, { marker, row, exitTimer: null });
  }

  for (const [id, entry] of markers) {
    if (seen.has(id) || entry.exitTimer) continue;
    const pin = entry.marker.getElement()?.firstElementChild;
    if (!pin) { layer.removeLayer(entry.marker); markers.delete(id); continue; }
    pin.classList.add("pin-leaving");
    entry.exitTimer = setTimeout(() => {
      layer.removeLayer(entry.marker);
      markers.delete(id);
    }, EXIT_MS);
  }
}

/** Pan to an appearance and open its popup (list row -> map). */
export function focus(appearanceId) {
  const entry = markers.get(appearanceId);
  if (!entry) return;
  map.setView(entry.marker.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
  entry.marker.openPopup();
}
