/**
 * Moderation CLI. The takedown path.
 *
 * Anonymous contributions have been live since the write API shipped, and until
 * now removing abuse meant hand-writing SQL against production — which is the
 * kind of thing nobody does calmly at 11pm, and exactly when it would be needed.
 *
 * WHY A SCRIPT AND NOT A WEB UI
 * A moderation UI needs authentication, a moderator role, session handling and
 * its own attack surface — a lot of new code whose failure mode is "the
 * moderation tool is the way in". This holds the service_role key on your
 * machine, is reachable only by someone who already has that key, and can be
 * written in an afternoon. When there is more than one moderator, replace it.
 *
 * WHAT MAKES TAKEDOWN CHEAP HERE
 * trucks.status = 'hidden' is already honoured by every read path — the
 * trucks_public_read policy, the appearances policy (which joins to trucks), and
 * trucks_at() itself. So one flip removes the truck, its pins and its schedule
 * from the map at once. Reviews work the same way via reviews.status.
 *
 * Nothing is deleted. Hidden rows stay for appeal and for evidence; a deletion
 * cascade would also take the sightings that corroborate a real truck someone
 * hid by mistake.
 *
 * It also puts trucks ON the map, which is the other half of the same job — see
 * the `add` / `place` commands and migration 0018.
 *
 * Usage:
 *   node scripts/moderate.mjs queue                       what needs a decision
 *   node scripts/moderate.mjs truck <id>                  everything about one truck
 *   node scripts/moderate.mjs add "<name>" [--at lat,lon] [...]
 *   node scripts/moderate.mjs place <id> --at lat,lon [...]
 *   node scripts/moderate.mjs uncurate <id> ["<why>"]
 *   node scripts/moderate.mjs curated
 *   node scripts/moderate.mjs hide-truck <id> "<why>"
 *   node scripts/moderate.mjs show-truck <id>
 *   node scripts/moderate.mjs hide-review <id> "<why>"
 *   node scripts/moderate.mjs show-review <id>
 *   node scripts/moderate.mjs reject-edit <id>
 *   node scripts/moderate.mjs reject-submission <id>
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* fall through to the check below */ }

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("\n  Needs SUPABASE_URL and SUPABASE_SECRET_KEY (from .env).\n");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

/**
 * Split `--flags` out of the positional arguments before anything reads them,
 * so the existing commands keep their `<id> "<reason>"` shape untouched and the
 * placement commands can take options in any order.
 *
 * Accepts `--flag value`, `--flag=value` and bare `--flag`. A value is only
 * consumed when it does not itself start with `--`, so a missing value reads as
 * "flag present, no value" rather than swallowing the next flag.
 */
const flags = Object.create(null);
const positional = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
}

const [cmd, arg, ...rest] = positional;
const reason = rest.join(" ").trim();
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };
const ok = (m) => console.log(`\n  ${m}\n`);

/** A flag's value as trimmed text, or null. `true` means it was passed bare. */
const flag = (name) => {
  const v = flags[name];
  if (v == null || v === true) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/** Reasons are required on hide actions. "Why is this gone?" has to be answerable. */
function requireReason() {
  if (!reason) {
    die('A reason is required.  e.g. moderate.mjs hide-truck 14 "fake listing, phone number spam"');
  }
  return reason;
}
const id = () => {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) die(`Expected a numeric id, got "${arg ?? ""}"`);
  return n;
};

async function queue() {
  console.log(`\n  Moderation queue -> ${SUPABASE_URL}\n`);

  const { data: subs } = await db.from("truck_submissions")
    .select("id,name,description,where_note,phone,website,lat,lon,status,created_at")
    .eq("status", "pending").order("created_at", { ascending: false }).limit(50);
  console.log(`  PENDING SUBMISSIONS (${subs?.length ?? 0})`);
  for (const s of subs ?? []) {
    console.log(`    #${s.id}  ${s.name}${s.lat ? "  [pinned -> already on the map]" : ""}`);
    if (s.description) console.log(`         ${s.description.slice(0, 100)}`);
    if (s.where_note) console.log(`         seen: ${s.where_note.slice(0, 100)}`);
    if (s.phone || s.website) console.log(`         ${s.phone ?? ""} ${s.website ?? ""}`.trim());
  }

  // A submission with a pin was promoted to a real truck and put on the map —
  // but with ONE appearance lasting a few hours. When that window closes the
  // truck stays in the database and vanishes from the map for good, because
  // nothing gave it a standing rule. That is the moment to decide whether it
  // deserves one, and it is invisible unless something says so here.
  const { data: promoted } = await db.from("truck_submissions")
    .select("id,name,promoted_truck_id")
    .eq("status", "applied").not("promoted_truck_id", "is", null)
    .order("created_at", { ascending: false }).limit(20);

  const fleeting = [];
  for (const p of promoted ?? []) {
    const { data: t } = await db.from("trucks")
      .select("id,name,curated,status").eq("id", p.promoted_truck_id).single();
    if (!t || t.curated || t.status === "hidden") continue;
    const { count } = await db.from("schedules")
      .select("id", { count: "exact", head: true }).eq("truck_id", t.id).eq("active", true);
    if (!count) fleeting.push(t);
  }
  if (fleeting.length) {
    console.log(`\n  SUBMITTED TRUCKS WITH NO STANDING RULE (${fleeting.length})`);
    console.log(`  Their pin expires and does not come back. Give one a rule to keep it:`);
    for (const t of fleeting) {
      console.log(`    #${t.id}  ${t.name}  (${t.status})`);
    }
    console.log(`    npm run moderate place ${fleeting[0].id} -- --at <lat>,<lon> --place "Where" --days fri`);
  }

  const { data: edits } = await db.from("truck_edits")
    .select("id,truck_id,field,value,note,created_at")
    .eq("status", "pending").order("created_at", { ascending: false }).limit(50);
  console.log(`\n  PENDING EDITS (${edits?.length ?? 0})`);
  for (const e of edits ?? []) {
    console.log(`    #${e.id}  truck ${e.truck_id}  ${e.field} = ${String(e.value).slice(0, 80)}`);
  }

  // Reviews default to 'visible', so there is no queue — the useful view is
  // simply the most recent ones, which is where abuse shows up first.
  const { data: revs } = await db.from("reviews")
    .select("id,truck_id,rating,body,author_name,status,created_at")
    .order("created_at", { ascending: false }).limit(10);
  console.log(`\n  10 MOST RECENT REVIEWS (they publish immediately)`);
  for (const r of revs ?? []) {
    const flag = r.status === "visible" ? " " : "H";
    console.log(`   ${flag}#${r.id}  truck ${r.truck_id}  ${r.rating}*  ${r.author_name ?? "Anonymous"}`);
    if (r.body) console.log(`         ${r.body.slice(0, 100)}`);
  }

  const { data: hidden } = await db.from("trucks")
    .select("id,name,moderation_note,moderated_at").eq("status", "hidden");
  if (hidden?.length) {
    console.log(`\n  CURRENTLY HIDDEN TRUCKS (${hidden.length})`);
    for (const t of hidden) console.log(`    #${t.id}  ${t.name}  — ${t.moderation_note ?? "no reason recorded"}`);
  }
  console.log();
}

async function truckDetail() {
  const tid = id();
  const { data: t, error } = await db.from("trucks").select("*").eq("id", tid).single();
  if (error) die(error.message);
  console.log(`\n  TRUCK #${t.id}  ${t.name}${t.curated ? "   [curated]" : ""}`);
  console.log(`    status ${t.status}   confidence ${t.confidence}   ${t.rating_count} reviews (avg ${t.rating_avg ?? "-"})`);
  if (t.data_source) console.log(`    source ${t.data_source}${t.home_city ? ` · ${t.home_city}` : ""}`);
  if (t.moderated_at) console.log(`    moderated ${t.moderated_at} — run: moderate history truck ${t.id}`);

  const { data: apps } = await db.from("appearances").select("id,starts_at,ends_at,source,status").eq("truck_id", tid);
  const upcoming = (apps ?? []).filter((a) => a.status !== "cancelled" && new Date(a.ends_at) >= new Date());
  console.log(`    ${apps?.length ?? 0} appearances (${upcoming.length} upcoming)`);

  // The distinction that decides whether it is on the map tomorrow: a one-off
  // pin expires and never comes back, a standing rule re-materializes nightly.
  const { data: rules } = await db.from("schedules")
    .select("id,day_of_week,start_time,end_time,active,venue_id").eq("truck_id", tid);
  for (const s of rules ?? []) {
    const { data: v } = await db.from("venues").select("name").eq("id", s.venue_id).single();
    console.log(`      rule #${s.id} ${s.active ? "" : "(off) "}`
      + `${DAY_NAME[s.day_of_week]} ${s.start_time.slice(0, 5)}-${s.end_time.slice(0, 5)} at ${v?.name ?? "?"}`);
  }
  if (!rules?.length && !t.curated) {
    console.log(`      no standing rule — any pin it has will expire and not return.`);
    console.log(`      npm run moderate place ${t.id} -- --at <lat>,<lon> --place "Where"`);
  }

  const { data: revs } = await db.from("reviews").select("id,rating,body,author_name,status").eq("truck_id", tid);
  for (const r of revs ?? []) {
    console.log(`      review #${r.id} [${r.status}] ${r.rating}* ${r.author_name ?? "Anonymous"}: ${(r.body ?? "").slice(0, 70)}`);
  }
  console.log();
}

/**
 * Who performed the action. No moderator accounts exist yet, so this records
 * the operating-system user rather than pretending to an identity it does not
 * have. MODERATOR overrides it.
 */
const actor = process.env.MODERATOR
  ?? process.env.USERNAME ?? process.env.USER ?? "unknown";

/**
 * Every action goes through a SECURITY DEFINER RPC rather than a table update.
 *
 * Not ceremony: the reason for a takedown lives in private.moderation_log, and
 * `private` is unreachable from here — service_role bypasses RLS but not
 * PostgREST schema exposure. The RPCs are the only door, and they make the
 * status flip and the log entry one transaction. A takedown that succeeded
 * while its reason failed to record is precisely the outcome worth preventing.
 */
async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) die(error.code === "P0002" ? error.message : `${error.code ?? ""} ${error.message}`);
  return data;
}

async function setTruckStatus(hidden) {
  const tid = id();
  const out = await rpc("moderate_truck", {
    p_truck_id: tid,
    p_hide: hidden,
    p_reason: hidden ? requireReason() : null,
    p_actor: actor,
  });
  ok(hidden
    ? `Hidden: #${out.id} "${out.name}".\n`
      + `  Its appearances and schedule left the map with it — trucks_public_read,\n`
      + `  the appearances policy and trucks_at() all join to trucks.status.`
    : `Restored: #${out.id} "${out.name}" is active and back on the map.`);
}

async function setReviewStatus(hidden) {
  const rid = id();
  const out = await rpc("moderate_review", {
    p_review_id: rid,
    p_hide: hidden,
    p_reason: hidden ? requireReason() : null,
    p_actor: actor,
  });
  // The RPC returns the recomputed aggregate rather than us asserting it moved.
  ok(`${hidden ? "Hidden" : "Restored"}: review #${out.id} on truck ${out.truck_id}.\n`
    + `  Truck rating is now ${out.rating_avg ?? "-"} across ${out.rating_count} visible reviews.`);
}

async function reject(kind) {
  const out = await rpc("moderate_resolve", {
    p_kind: kind, p_id: id(), p_reject: true, p_actor: actor,
  });
  ok(`Rejected ${out.kind} #${out.id}. It is no longer publicly readable (migration 0014).`);
}

// --- putting a truck on the map ---------------------------------------------

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** null means "every day" — the SQL default, and the honest reading of a bare pin. */
function parseDays(v) {
  if (v == null) return null;
  const s = v.toLowerCase();
  if (s === "daily" || s === "all" || s === "every") return null;
  if (s === "weekdays") return [1, 2, 3, 4, 5];
  if (s === "weekends") return [0, 6];

  const out = [];
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const key = part.slice(0, 3);
    if (key in DOW) out.push(DOW[key]);
    else if (/^[0-6]$/.test(part)) out.push(Number(part));
    else die(`Don't know the day "${part}". Use sun..sat, or daily / weekdays / weekends.`);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function parseTime(v, fallback) {
  if (v == null) return fallback;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(v);
  if (!m) die(`Couldn't read the time "${v}". Try 17:00, or 5pm.`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) die(`"${v}" isn't a time of day.`);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Ohio and a wide margin. Not a boundary — a plausibility check.
 *
 * The mistake worth catching is writing lon,lat instead of lat,lon, and around
 * here BOTH orderings are numerically legal: this map's longitude is about -84,
 * which is a perfectly valid latitude (it is in Antarctica). A range check on
 * ±90 therefore catches nothing at all, and the pin lands eight thousand miles
 * away while every layer of the system reports success. Only a regional check
 * can see it.
 */
const REGION = { minLat: 37.0, maxLat: 43.0, minLon: -86.5, maxLon: -79.5 };
const inRegion = (lat, lon) =>
  lat >= REGION.minLat && lat <= REGION.maxLat && lon >= REGION.minLon && lon <= REGION.maxLon;

function parseAt(v) {
  if (v == null) return { lat: null, lon: null };
  const [lat, lon] = v.split(",").map((s) => Number(s.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    die('--at wants "lat,lon" with no space, e.g. --at 39.3995,-84.5613');
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    die(`${lat},${lon} isn't a coordinate pair.`);
  }

  if (!inRegion(lat, lon) && !flags.anywhere) {
    if (inRegion(lon, lat)) {
      die(`${lat},${lon} would put this truck in the Southern Ocean, but `
        + `${lon},${lat} is right here.\n  Coordinates go lat,lon — try:  --at ${lon},${lat}`);
    }
    die(`${lat},${lon} is a long way outside Ohio, and this map covers Butler `
      + `County and its neighbours.\n  If you mean it, add --anywhere.`);
  }
  return { lat, lon };
}

const list = (v) => (v == null ? null : v.split(",").map((s) => s.trim()).filter(Boolean));

/**
 * `add` (by name) and `place` (by existing id) are the same call — creating a
 * truck, vouching for it and giving it a standing rule all have to happen
 * together or you get a half-state: a truck with no pin, or a pin on a truck
 * tonight's confidence sweep will demote. curate_truck() does all three in one
 * transaction; this just decides which end to identify it from.
 */
async function curate(byId) {
  const { lat, lon } = parseAt(flag("at"));
  const days = parseDays(flag("days"));
  const from = parseTime(flag("from"), "11:00");
  const to = parseTime(flag("to"), "19:00");

  let name = null;
  if (!byId) {
    name = [arg, ...rest].join(" ").trim();
    if (name.length < 2) {
      die('A name is required.  e.g. moderate.mjs add "Taqueria La Bamba" --at 39.3995,-84.5613');
    }
  } else if (lat == null) {
    die(`place needs a location.  e.g. moderate.mjs place ${arg ?? "<id>"} `
      + `--at 39.3995,-84.5613 --place "Municipal Brew Works"\n`
      + `  To vouch for a truck without putting a pin down, use: add "<its name>"`);
  }

  const out = await rpc("curate_truck", {
    p_truck_id: byId ? id() : null,
    p_name: name,
    p_cuisines: list(flag("cuisines")),
    p_description: flag("desc"),
    p_website: flag("web"),
    p_facebook: flag("fb"),
    p_instagram: flag("ig"),
    p_phone: flag("phone"),
    p_lat: lat,
    p_lon: lon,
    p_place_name: flag("place"),
    p_venue_type: flag("type") ?? "other",
    p_days: days,
    p_start: from,
    p_end: to,
    p_actor: actor,
  });

  const head = `#${out.id} "${out.name}" — ${out.created ? "created and curated" : "curated"}.`;

  if (!out.venue_id) {
    ok(`${head}\n`
      + `  It is pinned 'active' and will not be auto-demoted, but it has no\n`
      + `  location, so it has no pin and will not show on the map yet.\n\n`
      + `  Give it one:  npm run moderate place ${out.id} -- --at 39.3995,-84.5613 --place "Where"`);
    return;
  }

  const when = (days ?? [0, 1, 2, 3, 4, 5, 6]).map((d) => DAY_NAME[d]).join(", ");
  ok(`${head}\n`
    + `  Standing rule: ${when}  ${from}–${to}  at ${out.venue_name}\n`
    + `  ${out.schedules_added} rule${out.schedules_added === 1 ? "" : "s"} added`
    + `${out.schedules_added === 0 ? " (it already had them)" : ""}, `
    + `${out.upcoming_appearances} upcoming appearance${out.upcoming_appearances === 1 ? "" : "s"} on the map.\n\n`
    + `  It stays there: the rule re-materializes nightly over a rolling 14 days,\n`
    + `  and curated trucks are exempt from the sweep that demotes quiet ones.\n`
    + `  Nothing in the UI marks it as curated — it looks like any other truck.`);
}

async function uncurate() {
  const out = await rpc("uncurate_truck", {
    p_truck_id: id(),
    p_drop_schedules: flags["keep-schedule"] ? false : true,
    p_reason: reason || null,
    p_actor: actor,
  });
  ok(`#${out.id} "${out.name}" is no longer curated.\n`
    + `  ${out.schedules_deactivated} standing rule(s) switched off, `
    + `${out.appearances_cancelled} future appearance(s) cancelled.\n`
    + `  The truck row stays — this retracts your vouching for it, it is not a\n`
    + `  takedown. Use hide-truck for that.`);
}

async function curatedList() {
  const { data, error } = await db.from("trucks")
    .select("id,name,status,confidence,data_source,home_city")
    .eq("curated", true).order("name");
  if (error) die(error.message);

  console.log(`\n  CURATED TRUCKS (${data.length}) — vouched for, never auto-demoted\n`);
  for (const t of data) {
    const { count } = await db.from("appearances")
      .select("id", { count: "exact", head: true })
      .eq("truck_id", t.id).gte("ends_at", new Date().toISOString());
    console.log(`    #${String(t.id).padEnd(4)} ${t.name}`);
    console.log(`          ${t.status}  conf ${t.confidence}  `
      + `${count ?? 0} upcoming  ${t.home_city ? `· ${t.home_city}` : ""}`);
  }
  if (!data.length) {
    console.log(`    Nothing yet. Put a truck on the map:\n`
      + `      npm run moderate add "Truck name" -- --at 39.3995,-84.5613 --place "Where"`);
  }
  console.log();
}

async function history() {
  const rows = await rpc("moderation_history", {
    p_entity_type: arg ?? null,
    p_entity_id: rest[0] ? Number(rest[0]) : null,
    p_limit: 50,
  });
  console.log(`\n  MODERATION HISTORY (${rows.length})\n`);
  for (const r of rows) {
    console.log(`  ${r.created_at.slice(0, 19).replace("T", " ")}  ${r.action.padEnd(7)} `
      + `${r.entity_type} #${r.entity_id}  by ${r.actor ?? "?"}`);
    if (r.reason) console.log(`      ${r.reason}`);
  }
  if (!rows.length) console.log("  Nothing recorded yet.");
  console.log();
}

const COMMANDS = {
  queue,
  truck: truckDetail,
  history,
  add: () => curate(false),
  place: () => curate(true),
  uncurate,
  curated: curatedList,
  "hide-truck": () => setTruckStatus(true),
  "show-truck": () => setTruckStatus(false),
  "hide-review": () => setReviewStatus(true),
  "show-review": () => setReviewStatus(false),
  "reject-edit": () => reject("edit"),
  "reject-submission": () => reject("submission"),
};

const fn = COMMANDS[cmd];
if (!fn) {
  console.log(`
  Moderation, and putting trucks on the map. Nothing here deletes; hidden rows
  stay for appeal and for evidence. Every action is logged to
  private.moderation_log with a reason and an actor.

  LOOKING
    queue                            what needs a decision
    truck <id>                       everything about one truck
    curated                          trucks you've vouched for
    history [type] [id]              why things happened, newest first

  PUTTING A TRUCK ON THE MAP  (it stays there — see migration 0018)
    add "<name>" [options]           create or adopt by name, then curate
    place <id> [options]             same, for a truck that already exists
    uncurate <id> ["<why>"]          retract it; --keep-schedule to leave pins

      --at 39.3995,-84.5613          lat,lon — required by 'place'
      --place "Municipal Brew Works" what to call the spot
      --days thu,fri                 or daily / weekdays / weekends  [daily]
      --from 17:00  --to 21:00       local wall-clock                [11:00-19:00]
      --type brewery                 park, street, private_lot, market, ...
      --anywhere                     allow a pin outside the Ohio region
      --cuisines tacos,mexican
      --desc "..."  --web  --fb  --ig  --phone

  TAKING THINGS DOWN
    hide-truck <id> "<why>"          full takedown — pins and schedule go too
    show-truck <id>                  put it back (as 'active')
    hide-review <id> "<why>"         drops out of the truck's average
    show-review <id>
    reject-edit <id>
    reject-submission <id>

  Through npm, put -- before the options so npm passes them through:
    npm run moderate add "Taqueria La Bamba" -- --at 39.3995,-84.5613 --days fri

  Acting as: ${actor}   (set MODERATOR to override)
`);
  process.exit(cmd ? 1 : 0);
}
await fn();
