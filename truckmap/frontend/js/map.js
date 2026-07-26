import { DEFAULT_VIEW, MIN_ZOOM } from "./config.js";
import { fmtRange } from "./time.js";

let map = null;
const layer = L.layerGroup();
const markers = new Map(); // appearance_id -> L.Marker

export function initMap() {
  map = L.map("map", {
    center: DEFAULT_VIEW.center,
    zoom: DEFAULT_VIEW.zoom,
    minZoom: MIN_ZOOM,
    zoomControl: true,
  });

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

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

/** Replace everything on the map with `rows`. */
export function render(rows) {
  layer.clearLayers();
  markers.clear();

  for (const row of rows) {
    if (row.lat == null || row.lon == null) continue;
    const m = L.marker([row.lat, row.lon], {
      icon: icon(row.bucket),
      title: row.truck_name,
      riseOnHover: true,
    }).bindPopup(popupHtml(row));
    m.addTo(layer);
    markers.set(row.appearance_id, m);
  }
}

/** Pan to an appearance and open its popup (list row -> map). */
export function focus(appearanceId) {
  const m = markers.get(appearanceId);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 14), { animate: true });
  m.openPopup();
}

