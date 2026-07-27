import { cuisines, submitTruck } from "./api.js";
import { BASEMAP, DEFAULT_VIEW } from "./config.js";
import { toast } from "./toast.js";
import { guard } from "./turnstile.js";

const sheet = document.getElementById("add-sheet");
const form = document.getElementById("add-form");
const chipBox = document.getElementById("af-cuisines");
const clearBtn = document.getElementById("af-clear-pin");
const pinStatus = document.getElementById("af-pin-status");
let loaded = false;
let lastFocus = null;

// --- location picker ---------------------------------------------------------
let pickMap = null;
let pin = null;

/**
 * Reflect pin state in the UI.
 *
 * The button is enabled/disabled rather than shown/hidden, and the status line
 * is always present. Toggling `hidden` on either meant the pin controls only
 * existed once a pin did — which is backwards, since their job is to tell you
 * that placing one is an option in the first place — and it reflowed the form
 * under the cursor at the exact moment of the click.
 */
function renderPinState() {
  clearBtn.disabled = !pin;
  pinStatus.textContent = pin
    ? `Pin set at ${pin.lat.toFixed(4)}, ${pin.lon.toFixed(4)} — drag it to adjust.`
    : "No pin set — click the map to place one.";
  pinStatus.classList.toggle("is-set", Boolean(pin));
}

function setPin(lat, lon) {
  pin = { lat, lon };
  if (!pickMarker) {
    pickMarker = L.marker([lat, lon], { draggable: true }).addTo(pickMap);
    pickMarker.on("dragend", () => {
      const p = pickMarker.getLatLng();
      pin = { lat: p.lat, lon: p.lng };
      renderPinState(); // keep the readout honest after a drag, not just a click
    });
  } else {
    pickMarker.setLatLng([lat, lon]);
  }
  renderPinState();
}
let pickMarker = null;

function clearPin() {
  pin = null;
  if (pickMarker) { pickMap.removeLayer(pickMarker); pickMarker = null; }
  renderPinState();
}

/** Built lazily — a Leaflet map inside a hidden container renders at zero size. */
function initPickMap() {
  if (pickMap) return;
  pickMap = L.map("af-map", {
    center: DEFAULT_VIEW.center,
    zoom: 11,
    zoomControl: true,
    // Attribution was suppressed here to save space on a 13rem map. It is not
    // ours to suppress: OSM's ODbL and CARTO's terms both require it wherever
    // their tiles are shown, small map or not.
    attributionControl: true,
  });
  L.tileLayer(
    window.matchMedia("(prefers-color-scheme: dark)").matches ? BASEMAP.dark : BASEMAP.light,
    { maxZoom: BASEMAP.maxZoom, attribution: BASEMAP.attribution, detectRetina: true }
  ).addTo(pickMap);
  pickMap.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng));

  // Leaflet measures its container once, at construction. This one is built
  // inside a panel that was `hidden` a moment ago and is mid slide-in
  // animation, so that measurement can be zero — and a zero-sized map loads no
  // tiles, leaving a blank rectangle until some interaction forces a redraw.
  //
  // A single rAF invalidateSize() usually wins that race. "Usually" is the
  // problem: it depends on when layout flushes, which varies with the
  // animation, the viewport, and whether the sheet is the mobile bottom sheet.
  // Observing the element removes the race instead of betting on it — every
  // size change re-measures, including orientation changes and the bottom sheet
  // resizing as the on-screen keyboard opens.
  new ResizeObserver(() => pickMap.invalidateSize()).observe(
    document.getElementById("af-map")
  );
}

document.getElementById("af-locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Your browser can't share a location.", { error: true });
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      setPin(latitude, longitude);
      pickMap.setView([latitude, longitude], 16);
    },
    () => toast("Couldn't get your location — click the map instead.", { error: true }),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

clearBtn.addEventListener("click", clearPin);

/** Cuisine vocabulary comes from the database, not a hardcoded list — adding
 *  "birria" is an INSERT into public.cuisines, not a frontend change. */
async function loadChips() {
  if (loaded) return;
  try {
    for (const c of await cuisines()) {
      const id = `cz-${c.key}`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.value = c.key;
      input.className = "chip-input";
      const label = document.createElement("label");
      label.htmlFor = id;
      label.className = "chip";
      label.textContent = c.label;
      chipBox.append(input, label);
    }
    loaded = true;
  } catch (e) {
    // Swallowing this left "(couldn't load cuisine list)" on screen with nothing
    // in the console to say why, and no way to retry short of reloading.
    console.error("cuisines:", e.detail ?? e);
    chipBox.textContent = e.message;
  }
}

export async function openAddTruck() {
  lastFocus = document.activeElement;
  await loadChips();
  sheet.hidden = false;
  initPickMap(); // its ResizeObserver handles the measure-after-layout race
  document.getElementById("af-name").focus();
}

function close() {
  sheet.hidden = true;
  lastFocus?.focus();
}

// Mounted once — this form lives for the page's lifetime, unlike the detail
// sheet's forms which are rebuilt on every open.
const captchaBox = document.createElement("div");
captchaBox.className = "captcha";
form.querySelector("button[type=submit]").before(captchaBox);
const gate = guard(captchaBox);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = form.querySelector("button[type=submit]");
  const fd = new FormData(form);
  const picked = [...chipBox.querySelectorAll("input:checked")].map((i) => i.value);

  btn.disabled = true;
  try {
    const g = await gate;
    const out = await submitTruck({
      name: fd.get("name"),
      cuisines: picked,
      description: fd.get("description") || null,
      where_note: fd.get("where_note") || null,
      facebook: fd.get("facebook") || null,
      lat: pin?.lat ?? null,
      lon: pin?.lon ?? null,
      hours: Number(fd.get("hours")) || 3,
      turnstile_token: await g.getToken(),
    });
    g.reset();

    toast(out.promoted
      ? "Added — it's on the map now, marked unconfirmed."
      : "Thanks! Queued for review (add a pin next time to map it instantly).");

    form.reset();
    chipBox.querySelectorAll("input:checked").forEach((i) => (i.checked = false));
    clearPin();
    close();

    // A promoted truck creates a live appearance, so the map is now stale.
    if (out.promoted) document.dispatchEvent(new CustomEvent("truckmap:refresh"));
  } catch (err) {
    (await gate).reset();
    console.error(err.detail ?? err);
    toast(err.message, { error: true });
  } finally {
    btn.disabled = false;
  }
});

sheet.querySelector(".sheet-close").addEventListener("click", close);
sheet.querySelector(".sheet-scrim").addEventListener("click", close);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sheet.hidden) close();
});
