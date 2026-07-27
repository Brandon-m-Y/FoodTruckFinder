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
 * Usage:
 *   node scripts/moderate.mjs queue                       what needs a decision
 *   node scripts/moderate.mjs truck <id>                  everything about one truck
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

const [cmd, arg, ...rest] = process.argv.slice(2);
const reason = rest.join(" ").trim();
const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };
const ok = (m) => console.log(`\n  ${m}\n`);

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
    if (s.phone || s.website) console.log(`         ${s.phone ?? ""} ${s.website ?? ""}`.trim());
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
  console.log(`\n  TRUCK #${t.id}  ${t.name}`);
  console.log(`    status ${t.status}   confidence ${t.confidence}   ${t.rating_count} reviews (avg ${t.rating_avg ?? "-"})`);
  if (t.moderation_note) console.log(`    HIDDEN: ${t.moderation_note}  (${t.moderated_at})`);
  const { data: apps } = await db.from("appearances").select("id,starts_at,ends_at,source,status").eq("truck_id", tid);
  console.log(`    ${apps?.length ?? 0} appearances`);
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
  Moderation. Nothing here deletes; hidden rows stay for appeal and for evidence.
  Every action is logged to private.moderation_log with a reason and an actor.

    queue                            what needs a decision
    truck <id>                       everything about one truck
    history [type] [id]              why things were hidden, newest first

    hide-truck <id> "<why>"          full takedown — pins and schedule go too
    show-truck <id>                  put it back (as 'active')
    hide-review <id> "<why>"         drops out of the truck's average
    show-review <id>
    reject-edit <id>
    reject-submission <id>

  Acting as: ${actor}   (set MODERATOR to override)
`);
  process.exit(cmd ? 1 : 0);
}
await fn();
