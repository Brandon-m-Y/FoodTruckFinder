/**
 * Delete the [DEMO] seed data from the live project.
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION
 * ----------------------------------------
 * Migration 0006 put this data in, so a migration taking it out is the tidy
 * symmetry — and it is the wrong shape. A migration applies on the next
 * `db push`, which means the moment it lands in the folder it is a landmine:
 * anyone pushing an unrelated schema change silently empties the map. WHEN the
 * demo data goes is a product decision (it goes when real data arrives), not a
 * schema decision, and the two should not be coupled.
 *
 * WHY IT MATTERS
 * --------------
 * The demo reviews are prose written to look like real customers. On a public
 * map they are indistinguishable from genuine ones — a visitor has no way to
 * know "Great birria, worth the wait" was invented to make a screenshot look
 * populated. That is a credibility problem, not a tidiness problem.
 *
 * SAFETY
 * ------
 * Dry run unless you pass --yes. Only touches rows in the demo namespace:
 * trucks/venues whose name starts with "[DEMO]" AND whose slug starts with
 * "demo-" (trucks) — two independent markers, so a real truck someone
 * mischievously names "[DEMO] Tacos" is not eligible. Everything else goes by
 * FK cascade, which the schema already guarantees:
 *
 *   trucks  -> schedules, appearances, reviews, truck_edits,
 *              private.sightings, private.review_authors   (all ON DELETE CASCADE)
 *   venues  -> schedules (cascade), appearances.venue_id (set null)
 *
 * Usage:
 *   node scripts/purge-demo.mjs           # show what would go
 *   node scripts/purge-demo.mjs --yes     # actually delete
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
} catch {
  console.error("No .env found — this needs SUPABASE_SECRET_KEY to delete anything.");
  process.exit(1);
}

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.");
  process.exit(1);
}

const COMMIT = process.argv.includes("--yes");
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const counts = async () => {
  const out = {};
  for (const t of ["trucks", "venues", "schedules", "appearances",
                   "reviews", "truck_edits", "truck_submissions"]) {
    const { count } = await db.from(t).select("*", { count: "exact", head: true });
    out[t] = count ?? 0;
  }
  return out;
};

console.log(`\n  ${COMMIT ? "PURGING" : "DRY RUN"} -> ${SUPABASE_URL}\n`);

// --- identify -----------------------------------------------------------------
// Two markers, both required. A single marker is one careless rename away from
// deleting a real truck.
const { data: demoTrucks, error: tErr } = await db
  .from("trucks").select("id,name,slug,rating_count")
  .like("name", "[DEMO]%").like("slug", "demo-%").order("id");
if (tErr) { console.error("  Could not read trucks:", tErr.message); process.exit(1); }

const { data: demoVenues, error: vErr } = await db
  .from("venues").select("id,name").like("name", "[DEMO]%").order("id");
if (vErr) { console.error("  Could not read venues:", vErr.message); process.exit(1); }

const truckIds = demoTrucks.map((t) => t.id);
const venueIds = demoVenues.map((v) => v.id);

if (!truckIds.length && !venueIds.length) {
  console.log("  Nothing matches the demo namespace. Already clean.\n");
  process.exit(0);
}

// Cascaded rows, counted before the delete so the report is real rather than
// inferred from what the schema promises.
const cascaded = {};
for (const [table, col] of [["schedules", "truck_id"], ["appearances", "truck_id"],
                            ["reviews", "truck_id"], ["truck_edits", "truck_id"]]) {
  const { count } = await db.from(table)
    .select("*", { count: "exact", head: true }).in(col, truckIds.length ? truckIds : [-1]);
  cascaded[table] = count ?? 0;
}

console.log("  Demo trucks (cascade takes their schedules, appearances, reviews, edits, sightings):");
for (const t of demoTrucks) console.log(`    ${String(t.id).padStart(4)}  ${t.name}  (${t.rating_count} reviews)`);
console.log("\n  Demo venues:");
for (const v of demoVenues) console.log(`    ${String(v.id).padStart(4)}  ${v.name}`);
console.log("\n  Cascaded rows:");
for (const [k, v] of Object.entries(cascaded)) console.log(`    ${k.padEnd(14)} ${v}`);

// What SURVIVES. The point of printing this is that an empty map after a purge
// should be a thing you chose, not a thing you discover.
const { data: keep } = await db.from("trucks").select("id,name,status")
  .not("id", "in", `(${truckIds.length ? truckIds.join(",") : -1})`).order("id");
console.log(`\n  Surviving trucks: ${keep?.length ?? 0}`);
for (const t of keep ?? []) console.log(`    ${String(t.id).padStart(4)}  ${t.name} (${t.status})`);

if (!COMMIT) {
  console.log("\n  Dry run — nothing deleted. Re-run with --yes to commit.\n");
  process.exit(0);
}

// --- delete -------------------------------------------------------------------
const before = await counts();

if (truckIds.length) {
  const { error } = await db.from("trucks").delete().in("id", truckIds);
  if (error) { console.error("\n  Truck delete failed:", error.message); process.exit(1); }
  console.log(`\n  Deleted ${truckIds.length} demo trucks (+ cascades).`);
}
if (venueIds.length) {
  const { error } = await db.from("venues").delete().in("id", venueIds);
  if (error) { console.error("  Venue delete failed:", error.message); process.exit(1); }
  console.log(`  Deleted ${venueIds.length} demo venues (+ cascades).`);
}

const after = await counts();
console.log("\n  table            before   after");
for (const k of Object.keys(before)) {
  console.log(`  ${k.padEnd(18)}${String(before[k]).padStart(4)}${String(after[k]).padStart(9)}`);
}
console.log("\n  Done. Migration 0006 still describes this data — it is history, leave it.\n");
