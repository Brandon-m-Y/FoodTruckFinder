import { openAddTruck } from "./addtruck.js";
import { trucksAt } from "./api.js";
import { BUCKET_LABEL, SOURCE_URL } from "./config.js";
import { openTruck } from "./detail.js";
import { focus, initMap, render } from "./map.js";
import { fmtAsOf, fmtRange, hoursFromNow } from "./time.js";

const $ = (id) => document.getElementById(id);

const els = {
  scrubber: $("scrubber"),
  whenValue: $("when-value"),
  btnNow: $("btn-now"),
  list: $("list"),
  count: $("list-count"),
  status: $("status"),
};

let offset = 0;      // hours from now, driven by the scrubber
let seq = 0;         // monotonic: a slow response must not overwrite a newer one
let debounce = null;
let lastRows = [];   // most recent result set, for popup -> detail lookup

function setStatus(text) {
  if (!text) return void (els.status.hidden = true);
  els.status.textContent = text;
  els.status.hidden = false;
}

function renderList(rows) {
  els.list.replaceChildren();

  if (!rows.length) {
    els.count.textContent = "No trucks at this time";
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent =
      offset === 0
        ? "Nothing is out right now. Try scrubbing forward to see what's scheduled."
        : "Nothing scheduled for this time. Try another day.";
    els.list.append(li);
    return;
  }

  els.count.textContent = `${rows.length} truck${rows.length > 1 ? "s" : ""}`;

  for (const row of rows) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `row ${row.bucket}`;

    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = row.truck_name;

    const badge = document.createElement("span");
    badge.className = `badge ${row.bucket}`;
    badge.textContent = BUCKET_LABEL[row.bucket] ?? row.bucket;

    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = `${row.venue_name ?? "Ad-hoc stop"} · ${fmtRange(row.starts_at, row.ends_at)}`;

    const conf = document.createElement("div");
    conf.className = "row-meta";
    conf.append(badge, ` ${Number(row.confidence).toFixed(0)}/100`);
    if (row.rating_count > 0) {
      const n = Math.round(Number(row.rating_avg));
      conf.append(` · ${"★★★★★".slice(0, n)}${"☆☆☆☆☆".slice(0, 5 - n)} (${row.rating_count})`);
    }

    btn.append(name, meta, conf);
    btn.addEventListener("click", () => {
      focus(row.appearance_id);
      openTruck(row);
    });
    li.append(btn);
    els.list.append(li);
  }
}

async function load() {
  const mine = ++seq;
  const asOf = hoursFromNow(offset);

  els.whenValue.textContent = fmtAsOf(asOf, offset);
  els.btnNow.hidden = offset === 0;

  try {
    // Deliberately NOT bbox-filtered. At county scale the whole active set is a
    // few hundred rows, so fetching once and letting the user pan freely beats a
    // request per map move. Revisit if the dataset grows past a few thousand.
    const rows = await trucksAt(asOf, { minConfidence: 0 });
    if (mine !== seq) return; // superseded by a newer scrub
    lastRows = rows;
    render(rows);
    renderList(rows);
    setStatus(null);
  } catch (err) {
    if (mine !== seq) return;
    console.error(err);
    setStatus(`Couldn't load trucks — ${err.message}`);
    els.count.textContent = "Error";
  }
}

function onScrub() {
  offset = Number(els.scrubber.value);
  els.whenValue.textContent = fmtAsOf(hoursFromNow(offset), offset);
  els.btnNow.hidden = offset === 0;
  clearTimeout(debounce);
  debounce = setTimeout(load, 140);
}

/**
 * AGPL section 13 source offer.
 *
 * Built rather than hardcoded so the link cannot outlive the URL: with
 * SOURCE_URL null the paragraph stays hidden, because a source link that 404s
 * is worse than none — it reads as compliance while failing the obligation.
 */
function renderColophon() {
  const box = document.getElementById("colophon");
  if (!box || !SOURCE_URL) return;
  box.replaceChildren("Open source (AGPL-3.0) · ");
  const a = document.createElement("a");
  a.href = SOURCE_URL;
  a.textContent = "source code";
  a.rel = "noopener";
  a.target = "_blank";
  box.append(a);
  box.hidden = false;
}

function boot() {
  initMap();
  renderColophon();
  els.scrubber.addEventListener("input", onScrub);
  els.btnNow.addEventListener("click", () => {
    els.scrubber.value = "0";
    onScrub();
  });
  document.getElementById("btn-add-truck").addEventListener("click", openAddTruck);

  // A sighting changes confidence server-side, so re-fetch rather than trying
  // to reproduce the decay math in the client.
  document.addEventListener("truckmap:refresh", load);

  // Map popup -> full detail sheet. Delegated because popups are created and
  // destroyed on every render.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open-appearance]");
    if (!btn) return;
    const id = Number(btn.dataset.openAppearance);
    const row = lastRows.find((r) => r.appearance_id === id);
    if (row) openTruck(row);
  });

  load();
}

boot();
