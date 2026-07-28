/**
 * Import mobile food service licence records from a health district export.
 *
 * Ohio licences are issued locally but valid STATEWIDE (docs/FINDINGS.md,
 * Finding 1), so a truck licensed in Warren County legally trades in Butler
 * County — which is why this project asks four districts rather than one, and
 * why overlap between their lists is expected rather than a bug.
 *
 * THE COLUMN THIS DELIBERATELY THROWS AWAY
 * ----------------------------------------
 * Every export so far carries an address, and it is NOT where the truck
 * operates. It is the licence holder's registered address — for a one-truck
 * business, their home. In the Warren County file, 55 of 97 are residential
 * street addresses.
 *
 * Geocoding them would put pins on ninety-odd private houses, sourced from a
 * records request those people had no say in. The street line is parsed only far
 * enough to pull out the town, then discarded. Town and county are kept because
 * "Lebanon-based" genuinely helps someone judge whether a truck comes their way,
 * and a town of 20,000 identifies nobody.
 *
 * If you ever find yourself adding a --geocode flag here, re-read this.
 *
 * WHAT GETS WRITTEN
 * Names only, as `dormant` trucks with provenance. Dormant means licensed and
 * real, but with no evidence of current operation and no location — so it has no
 * appearances and never reaches the map until somebody reports seeing it. The
 * import builds the identity layer; the crowd supplies the locations.
 *
 * Usage:
 *   node scripts/import-licences.mjs <file.xlsx|file.csv> --source warren_county_health
 *   node scripts/import-licences.mjs <file> --source ... --yes      # actually write
 *   node scripts/import-licences.mjs <file> --source ... --show-all # list every row
 */
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { inflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* checked below */ }

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const COMMIT = flag("yes");
const SOURCE = opt("source");

if (!file || !SOURCE) {
  console.error(`
  Usage: node scripts/import-licences.mjs <file.xlsx|.csv> --source <slug> [--yes]

    --source   provenance tag, e.g. warren_county_health
    --yes      write to the database (otherwise dry run)
    --show-all list every parsed row, not just the summary
`);
  process.exit(2);
}

// --- xlsx ---------------------------------------------------------------------
// An .xlsx is a zip of XML. Reading it directly keeps this dependency-free,
// which matters for a script that runs a handful of times a year: a parsing
// library would be a permanent supply-chain surface for an occasional chore.

/** Minimal store/deflate zip reader — enough for the parts a spreadsheet has. */
function unzip(buf) {
  const files = {};
  // Walk the central directory from the End Of Central Directory record.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file (no EOCD record)");
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const method = buf.readUInt16LE(p + 10);
    const localOff = buf.readUInt32LE(p + 42);
    const size = buf.readUInt32LE(p + 24);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + size);
    files[name] = method === 0 ? raw : inflateRawSync(raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "");
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
  .replace(/&amp;/g, "&");

function readXlsx(buf) {
  const files = unzip(buf);
  const get = (n) => files[n]?.toString("utf8") ?? "";

  const shared = [...get("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => unesc(stripTags(m[1])));

  const sheetName = Object.keys(files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  const rows = new Map();
  for (const m of get(sheetName).matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const [, col, rowNum, attrs, inner] = m;
    const isShared = /t="s"/.test(attrs);
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    let val = "";
    if (isShared && v != null) val = shared[Number(v)] ?? "";
    else if (/t="inlineStr"/.test(attrs)) val = unesc(stripTags(inner));
    else if (v != null) val = v;
    if (!rows.has(Number(rowNum))) rows.set(Number(rowNum), {});
    rows.get(Number(rowNum))[col] = val.trim();
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

// --- csv ----------------------------------------------------------------------
/** RFC4180-ish: quoted fields, doubled quotes, embedded newlines and commas. */
function readCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift()?.map((h) => h.trim()) ?? [];
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return [
    Object.fromEntries(header.map((h, i) => [LETTERS[i], h])),
    ...rows.filter((r) => r.some((c) => c.trim()))
      .map((r) => Object.fromEntries(r.map((c, i) => [LETTERS[i], c.trim()]))),
  ];
}

// --- column detection ---------------------------------------------------------
// Districts will not agree on headers. Match on meaning, and say what was picked
// rather than guessing silently.
const COLUMN_PATTERNS = {
  name: /record\s*name|facility|business|establishment|dba|trade\s*name|name/i,
  address: /addr|address|location|street/i,
  contact: /contact\s*type|type|role/i,
};

function detectColumns(header) {
  const found = {};
  for (const [key, pattern] of Object.entries(COLUMN_PATTERNS)) {
    for (const [col, label] of Object.entries(header)) {
      if (label && pattern.test(label) && !Object.values(found).includes(col)) {
        found[key] = col;
        break;
      }
    }
  }
  return found;
}

/**
 * Town only. The street line is never returned, and never stored.
 *
 * Works backwards from the `ST ZIP` segment rather than assuming a street line
 * comes first — 11 of Warren County's rows are bare "Mason, OH 45040" with no
 * street at all, and a pattern that required a leading comma dropped every one
 * of them.
 *
 * Out-of-state holders return null on purpose. Six records are registered in
 * Texas, Louisiana and North Carolina — franchise head offices and owners who
 * live elsewhere. Recording "Smithville" as the home town of a truck that trades
 * in Warren County would be worse than recording nothing: it reads as local
 * knowledge and is not.
 *
 * @returns {{town: string|null, outOfState: string|null}}
 */
function townFrom(address) {
  if (!address) return { town: null, outOfState: null };
  const parts = String(address).split(",").map((s) => s.trim());

  for (let i = parts.length - 1; i >= 1; i--) {
    const m = /^([A-Za-z]{2})\s+\d{5}(?:-\d{4})?$/.exec(parts[i]);
    if (!m) continue;
    if (!/^oh$/i.test(m[1])) return { town: null, outOfState: m[1].toUpperCase() };
    return { town: parts[i - 1] || null, outOfState: null };
  }

  // "Ohio" written out rather than abbreviated.
  const m = /(?:^|,)\s*([A-Za-z][A-Za-z .'-]*?),\s*Ohio\b/i.exec(address);
  return { town: m ? m[1].trim() : null, outOfState: null };
}

/**
 * Records that are licensed as mobile food service but are probably not "a food
 * truck you would drive to" — farms selling produce, seasonal attractions,
 * theme-park units. Flagged for a human, never auto-excluded: Ohio licenses
 * these identically and the boundary is a judgement call, not a rule.
 */
const REVIEW_PATTERN =
  /\b(farm|farms|orchard|hayride|haunted|tent|renfest|renaissance|kings island|catering|winery|brewery)\b/i;

// --- run ----------------------------------------------------------------------
const buf = readFileSync(file);
const ext = extname(file).toLowerCase();
const parsed = ext === ".xlsx" ? readXlsx(buf)
  : ext === ".csv" ? readCsv(buf.toString("utf8"))
  : (() => { throw new Error(`Unsupported file type "${ext}" — expected .xlsx or .csv`); })();

const [header, ...body] = parsed;
const cols = detectColumns(header);

console.log(`\n  ${COMMIT ? "IMPORTING" : "DRY RUN"}  ${file}`);
console.log(`  source tag: ${SOURCE}\n`);
console.log("  columns detected:");
for (const key of ["name", "address", "contact"]) {
  console.log(`    ${key.padEnd(8)} ${cols[key] ? `${cols[key]}  "${header[cols[key]]}"` : "(not found)"}`);
}
if (!cols.name) {
  console.error(`\n  Could not find a name column. Headers were: ${Object.values(header).join(" | ")}\n`);
  process.exit(1);
}
if (cols.address) {
  console.log(`\n  The address column is READ FOR ITS TOWN ONLY. Street lines are`);
  console.log(`  discarded and never stored — they are licence-holder home addresses.`);
}

const seen = new Set();
const records = [];
for (const row of body) {
  const name = (row[cols.name] ?? "").trim();
  if (!name || name.length < 2) continue;
  const key = name.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const place = cols.address ? townFrom(row[cols.address]) : { town: null, outOfState: null };
  records.push({
    name,
    town: place.town,
    outOfState: place.outOfState,
    contact: cols.contact ? row[cols.contact] : null,
    review: REVIEW_PATTERN.test(name),
  });
}

console.log(`\n  ${records.length} distinct records (${body.length} rows read)`);

const towns = {};
for (const r of records) {
  if (r.outOfState) continue;
  const k = r.town ?? "(unknown)";
  towns[k] = (towns[k] ?? 0) + 1;
}
console.log("\n  towns (Ohio only):");
for (const [t, n] of Object.entries(towns).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${t}`);
}

// Reported separately rather than lumped into "(unknown)". These are franchise
// head offices and owners living out of state; recording "Smithville, TX" as the
// home town of a truck trading in Warren County would read as local knowledge
// and be wrong.
const away = records.filter((r) => r.outOfState);
if (away.length) {
  console.log(`\n  ${away.length} holder(s) registered out of state — town left blank:`);
  for (const r of away) console.log(`    ${r.name}  (${r.outOfState})`);
}

const flagged = records.filter((r) => r.review);
if (flagged.length) {
  console.log(`\n  ${flagged.length} FLAGGED FOR REVIEW — licensed as mobile food service, but`);
  console.log("  possibly not a truck someone would drive to. Imported anyway; hide with");
  console.log("  `npm run moderate hide-truck <id> \"<why>\"` if they do not belong.");
  for (const r of flagged) console.log(`    ${r.name}`);
}

if (flag("show-all")) {
  console.log("\n  all records:");
  for (const r of records) console.log(`    ${r.name}${r.town ? `  [${r.town}]` : ""}`);
}

if (!COMMIT) {
  console.log(`\n  Dry run — nothing written. Re-run with --yes to import.\n`);
  process.exit(0);
}

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("\n  Needs SUPABASE_URL and SUPABASE_SECRET_KEY in .env to write.\n");
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

const county = opt("county") ?? SOURCE.replace(/_county.*$/, "").replace(/_/g, " ");
let created = 0, updated = 0, failed = 0;
for (const r of records) {
  const { data, error } = await db.rpc("import_truck", {
    p_name: r.name,
    p_source: SOURCE,
    p_home_city: r.town,
    p_home_county: county,
  });
  if (error) { failed++; console.log(`  FAIL  ${r.name}: ${error.message}`); continue; }
  data.created ? created++ : updated++;
}

console.log(`\n  created ${created}   already known ${updated}   failed ${failed}`);
console.log("  All imported as 'dormant' — no location, so nothing reaches the map");
console.log("  until someone reports a sighting.\n");
