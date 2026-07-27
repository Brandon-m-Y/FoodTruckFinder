import { cuisines, submitTruck } from "./api.js";
import { BASEMAP, DEFAULT_VIEW } from "./config.js";
import { guard } from "./turnstile.js";

const sheet = document.getElementById("add-sheet");
const form = document.getElementById("add-form");
const chipBox = document.getElementById("af-cuisines");
const clearBtn = document.getElementById("af-clear-pin");
let loaded = false;
let lastFocus = null;

// --- location picker ---------------------------------------------------------
let pickMap = null;
let pin = null;

function setPin(lat, lon) {
  pin = { lat, lon };
  clearBtn.hidden = false;
  if (!pickMarker) {
    pickMarker = L.marker([lat, lon], { draggable: true }).addTo(pickMap);
    pickMarker.on("dragend", () => {
      const p = pickMarker.getLatLng();
      pin = { lat: p.lat, lon: p.lng };
    });
  } else {
    pickMarker.setLatLng([lat, lon]);
  }
}
let pickMarker = null;

function clearPin() {
  pin = null;
  clearBtn.hidden = true;
  if (pickMarker) { pickMap.removeLayer(pickMarker); pickMarker = null; }
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
}

document.getElementById("af-locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Your browser can't share a location.", true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      setPin(latitude, longitude);
      pickMap.setView([latitude, longitude], 16);
    },
    () => toast("Couldn't get your location — click the map instead.", true),
    { enableHighAccuracy: true, timeout: 8000 }
  );
});

clearBtn.addEventListener("click", clearPin);

function toast(msg, isError = false) {
  const t = document.getElementById("status");
  t.textContent = msg;
  t.classList.toggle("err", isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3800);
}

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
  } catch {
    chipBox.textContent = "(couldn't load cuisine list)";
  }
}

export async function openAddTruck() {
  lastFocus = document.activeElement;
  await loadChips();
  sheet.hidden = false;
  initPickMap();
  // Leaflet measures its container on creation; inside a just-unhidden panel
  // that measurement is stale, so force a re-measure once layout has settled.
  requestAnimationFrame(() => pickMap.invalidateSize());
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
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

sheet.querySelector(".sheet-close").addEventListener("click", close);
sheet.querySelector(".sheet-scrim").addEventListener("click", close);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !sheet.hidden) close();
});
