// One-shot import of an Etherpad Lite `dirty.db` into this app's document
// stack, PRESERVING THE FULL PER-REVISION EDIT HISTORY. Each pad becomes a Doc
// (PLAN.md §12) plus a `ydoc`/`ydoc_update` history (§11); no Post rows are
// created.
//
// Usage:
//   npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --verify
//   npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --list-authors
//   npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --authors=<json> --dry-run
//   npx tsx scripts/etherpad/import-etherpad.ts --source=<dirty.db> --authors=<json>
//
// Full rationale, the atext -> ProseMirror mapping table, and what is
// deliberately lossy: scripts/etherpad/README.md.
//
// --verify runs everything that touches no database (read, replay, map, and the
// list-nesting self-test) and prints the attribute inventory. --list-authors
// prints an --authors skeleton; you cannot write that file without it, because
// Etherpad author ids are opaque. --include-titles (with --list-authors) adds
// each author's pad titles to their entry as a `pads` array — a revision count
// rarely tells you who an anonymous id is, but recognizing which documents they
// wrote in often does, and putting it in the entry means the file can be filled
// in author-by-author with no cross-referencing. `pads` is tolerated and
// ignored on the way back in, so the file round-trips as --authors unedited.
// --dry-run does the whole import inside a transaction and rolls it back, so
// its summary is a real result.
//
// WHY A PAD BECOMES A DOC AND NOT A POST
// A post here is an immutable snapshot of a doc at a chosen point in that doc's
// history (§15). The editable, collaboratively-authored, revision-bearing thing
// an Etherpad pad actually IS therefore maps onto a Doc, and publishing is a
// later deliberate act through /posts/[id] (§15c) — including publishing from
// any point in the imported history, which is the whole reason the history is
// imported rather than just the final text.
//
// THE HISTORY IS THE POINT: ONE ydoc_update ROW PER ETHERPAD REVISION
// Etherpad stores a changeset, an author and a timestamp per revision. The log
// is replayed by /ydoc-debug and DocScrubBar and is never truncated (§11b), so
// it is an exact home for that. Rows carry their revision's real timestamp
// (`ydoc_update.created_at` is a plain @default(now()), so it can simply be
// passed), and each revision's Yjs structs carry a per-author clientID.
//
// ROWS DO NOT CORRESPOND ONE-TO-ONE WITH REVISIONS, AND THAT IS NOT A BUG.
// A Y.Doc transaction that changes nothing emits NO update event at all. Some
// Etherpad revisions are real at the atext level but no-ops once mapped —
// an `insertorder` churn, an authorship-attribute change for an author whose
// marks are dropped, or an edit that only touched the boilerplate this import
// removes. Those revisions produce no row. Every one is listed by
// number in the summary, and snapshot marks are resolved from the row index the
// update handler actually saw, never from the revision number, because a shear
// of even one row would silently point a snapshot at the wrong content.
//
// THE BOILERPLATE PAD TEXT IS REMOVED FROM THE WHOLE HISTORY, NOT JUST THE HEAD
// Etherpad seeds every new pad with `settings.defaultPadText` — here "Welcome to
// Etherpad!" and three more paragraphs, one of them a DirtyDB warning. That is
// the software talking, not the authors, so the imported history is written as
// though it had never been there: not merely deleted at the end, but absent from
// every revision, including the ones before whoever it was got around to
// selecting it and hitting delete, and including pads where nobody ever did.
//
// It is identified BY IDENTITY, not by content: revision 0 is the seeding
// revision, so the characters it inserts are flagged (`Cell.seed`,
// changeset.ts) and the flag rides along through every later changeset. A `-`
// op drops those cells, an attributed `=` copies the flag onto the rewritten
// cell, and no `+` op ever sets it. So a pad that deleted the boilerplate
// halfway through, one that deleted half of it, and one that typed inside it
// all come out right, with no text matching anywhere. The mapping stage then
// looks only at the unflagged cells.
//
// This does NOT weaken the correctness gate below: the atext checkpoints still
// compare the FULL replayed document, boilerplate included, against Etherpad's
// own stored atext. Only the mapping looks away. --keep-default-text imports it.
//
// THE LOG IS WHAT THE ydoc BLOB IS COMPUTED FROM
// Exactly as in scripts/import-legacy.ts: `Y.mergeUpdates(rows)` and
// `Y.encodeStateVectorFromUpdate(state)`, so "the blob equals a replay of the
// log" is true by construction. Row #1 is a full state (invariant 1, §11b),
// holding the seeded "title" fragment; every later row is a plain per-
// transaction delta captured from `master.on("update")` — NOT
// `Y.encodeStateAsUpdate(doc, sv)`, which re-ships the document's entire delete
// set on every call (import-legacy.ts:509 measured what that costs).
//
// ATTRIBUTION HAS TWO INDEPENDENT LEVERS AND THIS USES BOTH
// - `authorHighlight` marks (§3d) carry Etherpad's per-character `author`
//   attribute. This is the exact layer: what a reader sees is what Etherpad
//   showed. Nothing on the doc side ever strips these marks (§12d), so they
//   persist; publishing strips them on the way to a post (§15b).
// - The `clients` Y.Map (§11d), clientID -> User.id, written the first time each
//   author produces a change, exactly as server/ydoc-hooks.ts's attributeUpdate
//   does live. `master.clientID` is reassigned per revision (outside transact),
//   which yjs supports — clientID is read only at struct-creation time and
//   per-client clocks are tracked independently. This layer is APPROXIMATE:
//   y-prosemirror's diff can delete and reinsert a run whose marks changed, so
//   untouched characters may end up carrying the editing author's clientID at
//   the CRDT level. The summary reports generated bytes against characters
//   actually typed so the approximation stays visible.
//
// ydoc.created_at IS NOT BACKDATED. It is the lineage stamp a client's
// y-indexeddb store is keyed on (§11e): it changes only when the row is
// recreated, which is exactly how a stale local copy is prevented from merging
// into a re-imported document. Backdating it would reintroduce that bug.
// (doc.updated_at and ydoc.updated_at ARE backdated, via raw SQL — both are
// @updatedAt, which Prisma stamps with now() whatever you pass.)
//
// NOT IMPORTED: pad chat (there is no honest target — a Comment needs a Post
// and an Annotation needs an anchor mark in the document, and inventing anchors
// from chat text would be fabrication), read-only share links, sessions,
// tokens, groups, and saved-revision labels (ydoc_snapshot has no label column;
// they are printed instead). Each is counted in the summary rather than
// silently skipped.
//
// A --dry-run still consumes ydoc_update's BIGSERIAL values on rollback.
// Harmless — nothing depends on the ids being contiguous — but it means the
// live run's ids won't start where the dry run's did.

import "dotenv/config";
import fs from "node:fs";
import * as Y from "yjs";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { Node as PMNode } from "@tiptap/pm/model";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { readDirtyDb, type PadRecord, type Revision } from "./dirty-db";
import {
  applyChangeset,
  atextToCells,
  cellsDiffer,
  cellsText,
  emptyDocument,
  hasSeedCells,
  insertedChars,
  poolOf,
  unpack,
  withoutSeedCells,
  type ApplyAnomaly,
  type Cell,
} from "./changeset";
import {
  cellsToProseMirror,
  cellsTextWithoutMarkers,
  proseMirrorText,
  runMappingSelfTest,
  type MapOptions,
} from "./to-prosemirror";
import { docContentExtensions, pmDocContentSchema } from "../../src/lib/tiptap-schema";
import { ydocIdForDoc } from "../../src/lib/ydoc-names";
import { colorForSeed } from "../../src/lib/author-colors";
import { slugify } from "../../src/lib/slug";
import { DocVisibility, Role } from "../../src/generated/prisma/enums";
import type { Prisma } from "../../src/generated/prisma/client";

const ROLLBACK = Symbol("dry-run-rollback");
const UPDATE_BATCH = 1000;
// Etherpad's own id for text it wrote itself (a pad created from
// settings.defaultPadText). Never a person, and it has no globalAuthor record.
const SYSTEM_AUTHOR = "a.etherpad-system";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function args(name: string): string[] {
  return process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

function asEnum<T extends Record<string, string>>(values: T, raw: string, column: string): T[keyof T] {
  const match = Object.values(values).find((v) => v === raw);
  if (!match) fail(`${column} value ${JSON.stringify(raw)} is not one of ${Object.values(values).join(", ")}.`);
  return match as T[keyof T];
}

// Mirrors import-legacy.ts's claimSlug: uniqueDocSlug/uniqueUserSlug query the
// global client and so cannot see rows created earlier in this same
// transaction, which for a 50-pad import is most of them.
async function claimSlug(
  tx: Prisma.TransactionClient,
  kind: "doc" | "user",
  desired: string,
  claimed: Set<string>,
): Promise<string> {
  const base = slugify(desired, kind);
  let candidate = base;
  let suffix = 2;

  const taken = async (slug: string): Promise<boolean> => {
    if (claimed.has(slug)) return true;
    if (kind === "doc") {
      return (
        (await tx.doc.findFirst({ where: { slug }, select: { id: true } })) !== null ||
        (await tx.docSlugHistory.findFirst({ where: { slug }, select: { id: true } })) !== null
      );
    }
    return (
      (await tx.user.findFirst({ where: { slug }, select: { id: true } })) !== null ||
      (await tx.userSlugHistory.findFirst({ where: { slug }, select: { id: true } })) !== null
    );
  };

  while (await taken(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  claimed.add(candidate);
  return candidate;
}

function deriveInitials(name: string | null, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : words[0][1];
    return `${first}${last ?? ""}`.toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

// Deterministic, nonzero, and stable across re-imports, so the same person
// keeps the same clientID if the import is ever re-run. Collisions inside one
// pad are checked and bumped by the caller; against a real client's random
// uint32 the odds are ~2^-32.
function clientIdFor(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function prettyTitle(padId: string, mode: "pretty" | "raw"): string {
  if (mode === "raw") return padId;
  return padId.replace(/_/g, " ").replace(/\s+/g, " ").trim() || padId;
}

// ---------------------------------------------------------------------------
// Stage 2+3: replay a pad and map every revision to ProseMirror JSON.
// Pure — no database, no Yjs.
// ---------------------------------------------------------------------------

type ReplayStep = { rev: number; author: string; timestamp: number; doc: PMNode };

type ReplayResult = {
  steps: ReplayStep[];
  finalCells: Cell[];
  // finalCells minus the boilerplate seed text — what was actually mapped.
  finalVisibleCells: Cell[];
  keyRevsChecked: number;
  unknown: Map<string, number>;
  ignored: Map<string, number>;
  indentLines: number;
  synthesizedItems: number;
  strayLineMarkers: number;
  lineCountAnomalies: number;
  etherpadInsertedChars: number;
  // Boilerplate was found and dropped from this pad's history.
  seeded: boolean;
  // The pad still carried some of its boilerplate at head, i.e. nobody ever
  // deleted it and the import is what removed it.
  seedSurvivedToHead: boolean;
  // Nothing but boilerplate: every revision maps to an empty document.
  emptyAfterSeedStrip: boolean;
};

function replayPad(
  padId: string,
  pad: PadRecord,
  revs: Map<number, Revision>,
  mapOptions: MapOptions,
  opts: { stripSeedText: boolean; defaultPadText: string },
): ReplayResult {
  const pool = poolOf(pad.pool);
  let cells = emptyDocument();
  const steps: ReplayStep[] = [];
  const unknown = new Map<string, number>();
  const ignored = new Map<string, number>();
  const anomalies: ApplyAnomaly[] = [];
  let keyRevsChecked = 0;
  let indentLines = 0;
  let synthesizedItems = 0;
  let strayLineMarkers = 0;
  let etherpadInsertedChars = 0;
  let seeded = false;
  let visible: Cell[] = cells;

  // Revisions are 0..head — Etherpad's Pad constructor starts head at -1 and
  // init() appends rev 0 with the pad's initial text. Rev 0 is also a keyRev
  // (floor(0/100)*100 === 0), so the correctness gate fires immediately.
  for (let rev = 0; rev <= pad.head; rev++) {
    const revision = revs.get(rev);
    if (!revision) throw new Error(`${padId}: revision ${rev} is missing (head is ${pad.head})`);

    // Revision 0 is the seeding revision, so whatever it inserts IS the pad's
    // boilerplate — but only when it actually looks like the boilerplate, since
    // a pad created through the API has real content at revision 0. Deciding off
    // the charbank means the check happens before anything is marked.
    const isSeedRev =
      rev === 0 && opts.stripSeedText && unpack(revision.changeset).charBank.startsWith(opts.defaultPadText);

    try {
      cells = applyChangeset(cells, revision.changeset, pool, { anomalies, markInsertsAsSeed: isSeedRev });
    } catch (err) {
      throw new Error(`${padId} rev ${rev}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (isSeedRev) seeded = true;
    etherpadInsertedChars += insertedChars(revision.changeset);

    // Every 100th revision stores the full atext it should have produced.
    // Comparing CELL MODELS (not re-serialized attribution strings) makes this
    // a real divergence check with no formatting hazard — see changeset.ts.
    if (revision.meta.atext) {
      const stored = atextToCells(revision.meta.atext, poolOf(revision.meta.pool ?? pad.pool));
      const diff = cellsDiffer(cells, stored);
      if (diff) throw new Error(`${padId} rev ${rev} does not match its stored atext — ${diff}`);
      keyRevsChecked += 1;
    }

    // The gates above compared the FULL document against Etherpad's own stored
    // atext; only the mapping looks away from the boilerplate.
    visible = seeded ? withoutSeedCells(cells) : cells;
    const mapped = cellsToProseMirror(visible, mapOptions);
    // MAX over revisions, not sum. Every revision re-maps the whole document, so
    // summing would report a 40-line indented pad edited 1000 times as 40,000
    // indented lines — a number that reads as catastrophic and means nothing.
    // The max is "how much of this was ever in the document at once".
    for (const [k, v] of mapped.unknown) unknown.set(k, Math.max(unknown.get(k) ?? 0, v));
    for (const [k, v] of mapped.ignored) ignored.set(k, Math.max(ignored.get(k) ?? 0, v));
    indentLines = Math.max(indentLines, mapped.indentLines);
    synthesizedItems = Math.max(synthesizedItems, mapped.synthesizedItems);
    strayLineMarkers = Math.max(strayLineMarkers, mapped.strayLineMarkers);

    let doc: PMNode;
    try {
      doc = PMNode.fromJSON(pmDocContentSchema, mapped.doc);
      doc.check();
    } catch (err) {
      throw new Error(
        `${padId} rev ${rev} produced a document the schema rejects: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    steps.push({ rev, author: revision.meta.author ?? "", timestamp: revision.meta.timestamp, doc });
  }

  const headDiff = cellsDiffer(cells, atextToCells(pad.atext, pool));
  if (headDiff) throw new Error(`${padId} head does not match the pad's stored atext — ${headDiff}`);

  return {
    steps,
    finalCells: cells,
    finalVisibleCells: visible,
    keyRevsChecked,
    unknown,
    ignored,
    indentLines,
    synthesizedItems,
    strayLineMarkers,
    lineCountAnomalies: anomalies.length,
    etherpadInsertedChars,
    seeded,
    seedSurvivedToHead: seeded && hasSeedCells(cells),
    emptyAfterSeedStrip: seeded && cellsText(visible).trim() === "",
  };
}

// ---------------------------------------------------------------------------
// Stage 4: a pad's replay -> an ordered Yjs update log.
// ---------------------------------------------------------------------------

type LogRow = { bytes: Uint8Array<ArrayBuffer>; at: Date };
type PendingSnapshot = { rev: number; afterIndex: number; bytes: Uint8Array; userId: string | null; at: Date };

type BuiltLog = {
  rows: LogRow[];
  snapshots: PendingSnapshot[];
  collapsedRevs: number[];
  clientsWritten: Map<number, string>;
  generatedBytes: number;
};

function buildLog(opts: {
  padId: string;
  title: string;
  steps: ReplayStep[];
  savedRevisions: Map<number, { userId: string | null; at: Date }>;
  snapshotEvery: number;
  userIdFor: (etherpadAuthorId: string) => string | null;
}): BuiltLog {
  const { steps, title, savedRevisions, snapshotEvery, userIdFor } = opts;
  if (steps.length === 0) throw new Error(`${opts.padId}: no revisions`);

  // gc: true, the yjs default and what the collab server runs with (§11d), so
  // what gets written is what production would have written.
  const master = new Y.Doc();

  // Distinct clientID per Etherpad author, checked for collisions within this
  // pad. A collision would matter: yjs tracks per-client clocks by id.
  const clientIds = new Map<string, number>();
  const usedClientIds = new Set<number>();
  const clientIdOf = (authorId: string): number => {
    const hit = clientIds.get(authorId);
    if (hit !== undefined) return hit;
    let id = clientIdFor(authorId || "etherpad:unattributed");
    while (usedClientIds.has(id)) id = (id + 1) >>> 0 || 1;
    usedClientIds.add(id);
    clientIds.set(authorId, id);
    return id;
  };

  const clientsWritten = new Map<number, string>();

  // Row 1: the title fragment, encoded as a full state. Written under the first
  // revision's author, so no synthetic import identity ever appears in the
  // document. The shape — a "paragraph" XmlElement holding one XmlText — is what
  // titleExtensions expects and what the app itself produces.
  const firstAuthor = steps[0].author;
  master.clientID = clientIdOf(firstAuthor);
  const firstUserId = userIdFor(firstAuthor);
  master.transact(() => {
    const fragment = master.getXmlFragment("title");
    const paragraph = new Y.XmlElement("paragraph");
    if (title) paragraph.insert(0, [new Y.XmlText(title)]);
    fragment.insert(0, [paragraph]);
    if (firstUserId) {
      master.getMap<string>("clients").set(String(master.clientID), firstUserId);
      clientsWritten.set(master.clientID, firstUserId);
    }
  });

  const rows: LogRow[] = [{ bytes: new Uint8Array(Y.encodeStateAsUpdate(master)), at: new Date(steps[0].timestamp) }];
  let generatedBytes = rows[0].bytes.length;

  // Capture inside the handler rather than around the transaction: a transaction
  // that changes nothing emits nothing, so counting rows any other way shears
  // the row<->revision correspondence the snapshot marks depend on.
  let pendingAt: Date = rows[0].at;
  master.on("update", (update: Uint8Array) => {
    const bytes = new Uint8Array(update);
    generatedBytes += bytes.length;
    rows.push({ bytes, at: pendingAt });
  });

  const snapshots: PendingSnapshot[] = [];
  const collapsedRevs: number[] = [];
  const body = master.getXmlFragment("default");

  for (const step of steps) {
    const cid = clientIdOf(step.author);
    // Outside transact(), never within one.
    master.clientID = cid;
    pendingAt = new Date(step.timestamp);
    const userId = userIdFor(step.author);
    const before = rows.length;

    master.transact(() => {
      if (userId && !clientsWritten.has(cid)) {
        master.getMap<string>("clients").set(String(cid), userId);
        clientsWritten.set(cid, userId);
      }
      prosemirrorToYXmlFragment(step.doc, body);
    });

    const emitted = rows.length - before;
    if (emitted === 0) collapsedRevs.push(step.rev);
    if (emitted > 1) throw new Error(`${opts.padId} rev ${step.rev} emitted ${emitted} updates for one transaction`);

    const saved = savedRevisions.get(step.rev);
    const periodic = snapshotEvery > 0 && step.rev > 0 && step.rev % snapshotEvery === 0;
    if (saved || periodic) {
      // Captured immediately after this row and before anything else is
      // applied, so these bytes equal a replay of rows[0..afterIndex] exactly —
      // which is invariant 2 (§11b).
      snapshots.push({
        rev: step.rev,
        afterIndex: rows.length - 1,
        bytes: new Uint8Array(Y.encodeStateAsUpdate(master)),
        userId: saved?.userId ?? null,
        at: saved?.at ?? new Date(step.timestamp),
      });
    }
  }

  master.destroy();
  return { rows, snapshots, collapsedRevs, clientsWritten, generatedBytes };
}

// ---------------------------------------------------------------------------
// Author resolution
// ---------------------------------------------------------------------------

type AuthorMapEntry =
  | string
  | {
      email: string;
      name?: string;
      adminInitials?: string;
      role?: string;
      // Written by --list-authors --include-titles, never read: the titles of
      // the pads this author wrote in, carried in the file so the mapping can
      // be filled in author-by-author without cross-referencing anything.
      pads?: string[];
    };

// Everything an entry object is allowed to carry. Unknown keys are rejected
// rather than ignored: the resolver only ever reads `email`, so a mistyped
// "emial" would otherwise be inert, and inert means the person silently gets a
// placeholder account with attribution that can't be repointed afterwards —
// the same failure mode the unmatched-author-id check exists to prevent.
const AUTHOR_ENTRY_KEYS = ["email", "name", "adminInitials", "role", "pads"] as const;

type ResolvedAuthor = {
  etherpadId: string;
  userId: string;
  email: string;
  name: string | null;
  created: boolean;
  revisions: number;
};

function loadAuthorMap(path: string | undefined): Map<string, AuthorMapEntry> {
  const map = new Map<string, AuthorMapEntry>();
  if (!path) return map;
  if (!fs.existsSync(path)) fail(`--authors file not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    fail(`--authors is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`--authors must be a JSON object of {"a.xxx": "email" | {"email": ...}}`);
  }

  const known = new Set<string>(AUTHOR_ENTRY_KEYS);
  const problems: string[] = [];
  for (const [k, v] of Object.entries(parsed as Record<string, AuthorMapEntry>)) {
    if (typeof v === "string") {
      map.set(k, v);
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      problems.push(`${JSON.stringify(k)} — must be an email string or an object, got ${JSON.stringify(v)}`);
      continue;
    }
    for (const key of Object.keys(v)) {
      if (known.has(key)) continue;
      // Name the intended key when it's an obvious typo, the same way the
      // unmatched-author-id check names a case-mismatched id.
      const near = AUTHOR_ENTRY_KEYS.find(
        (e) => e.toLowerCase() === key.toLowerCase() || [...e].sort().join("") === [...key.toLowerCase()].sort().join(""),
      );
      problems.push(
        `${JSON.stringify(k)} has unknown field ${JSON.stringify(key)}` +
          (near ? ` — did you mean ${JSON.stringify(near)}?` : ` — expected one of ${AUTHOR_ENTRY_KEYS.join(", ")}`),
      );
    }
    map.set(k, v);
  }

  if (problems.length) {
    console.error(`\n  ${problems.length} problem(s) in ${path}:`);
    for (const p of problems) console.error(`    ${p}`);
    fail("Refusing to import: an unrecognized field is silently ignored, which would hand someone a placeholder account.");
  }
  return map;
}

// ---------------------------------------------------------------------------

async function main() {
  const sourcePath = arg("source");
  if (!sourcePath) fail("--source=<path to dirty.db> is required.");
  if (!fs.existsSync(sourcePath)) fail(`--source file not found: ${sourcePath}`);

  const verifyOnly = process.argv.includes("--verify");
  const listPads = process.argv.includes("--list-pads");
  const listAuthors = process.argv.includes("--list-authors");
  const includeTitles = process.argv.includes("--include-titles");
  const dryRun = process.argv.includes("--dry-run");
  const replace = process.argv.includes("--replace");
  const timeout = Number(arg("timeout") ?? 900_000);
  const visibility = asEnum(DocVisibility, arg("visibility") ?? DocVisibility.PRIVATE, "--visibility");
  const titleMode = arg("titles") === "raw" ? "raw" : "pretty";
  const indentAs = arg("indent-as") === "paragraph" ? "paragraph" : "blockquote";
  const headingAttributeRaw = arg("heading-attribute") ?? "heading";
  const headingAttribute = headingAttributeRaw === "off" ? null : headingAttributeRaw;
  const snapshotEvery = Number(arg("snapshot-every") ?? 0);
  const authorDomain = arg("author-domain") ?? "etherpad.invalid";
  const ignoreAttributes = new Set((arg("ignore-attributes") ?? "").split(",").filter(Boolean));
  const allowUnmapped = process.argv.includes("--allow-unmapped");
  const allowUnusedAuthors = process.argv.includes("--allow-unused-authors");
  const skipUntouched = process.argv.includes("--skip-untouched");
  const defaultPadText = arg("default-pad-text") ?? "Welcome to Etherpad!";
  const seedOptions = { stripSeedText: !process.argv.includes("--keep-default-text"), defaultPadText };
  const selectedPads = args("pad");

  console.log(`\nSource: ${sourcePath}`);
  const db = await readDirtyDb(sourcePath);
  const s = db.stats;
  console.log(
    `Read:   ${s.lines} lines, ${s.distinctKeys} live keys, ${db.pads.size} pads, ${db.authors.size} author records`,
  );
  console.log(
    `        tombstones: ${s.tombstonedMissingVal} (missing val) + ${s.tombstonedNull} (null)` +
      `${s.corruptLines ? `, ${s.corruptLines} unparseable lines skipped` : ""}`,
  );
  console.log(`        key kinds: ${[...s.keyKinds].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  if (s.tombstonedPads.length) console.log(`        deleted pads (skipped): ${s.tombstonedPads.join(", ")}`);
  if (s.unknownPadProps.size) {
    console.log(`        UNRECOGNIZED pad-record properties: ${[...s.unknownPadProps.keys()].join(", ")}`);
  }
  if (s.orphanRevPads.length) {
    console.log(`        revisions for pads that no longer exist (skipped): ${s.orphanRevPads.join(", ")}`);
  }
  const totalChats = [...db.chats.values()].reduce((a, b) => a + b, 0);
  if (totalChats) console.log(`        chat messages NOT imported: ${totalChats}`);

  const requestedPads = (selectedPads.length > 0 ? selectedPads : [...db.pads.keys()]).sort();
  for (const id of requestedPads) if (!db.pads.has(id)) fail(`--pad=${id} is not a live pad in this file.`);

  // A pad at head 0 has only its seeding revision: nobody has typed in it since
  // it was created, so when its text is still the stock defaultPadText the whole
  // document is Etherpad's boilerplate. 16 of the 50 pads in the real file are
  // like this — seven scratch pads, and nine that are a RETITLE of a real pad,
  // created seconds before it by typing the title with spaces instead of
  // underscores (Etherpad has no rename, so retitling means creating a new pad).
  //
  // They are IMPORTED BY DEFAULT even so: this is a transcription, and deciding
  // which of somebody's documents are worth keeping is not a migration's call to
  // make. They are named in the summary every run, and --skip-untouched drops
  // them for anyone who wants that. Note the retitles land as a second, empty
  // doc beside their content-bearing twin, sharing its title.
  const untouched: string[] = [];
  const padIds: string[] = [];
  for (const id of requestedPads) {
    const pad = db.pads.get(id)!;
    if (pad.head === 0 && pad.atext.text.startsWith(defaultPadText)) {
      untouched.push(id);
      if (skipUntouched) continue;
    }
    padIds.push(id);
  }
  if (untouched.length) {
    console.log(
      `\n  Never edited — head 0 and still the stock pad text (${untouched.length}), ` +
        `${skipUntouched ? "SKIPPED per --skip-untouched" : "imported anyway (--skip-untouched drops them)"}` +
        `${!skipUntouched && seedOptions.stripSeedText ? ", and empty once that text is stripped" : ""}:`,
    );
    for (const id of untouched) console.log(`    ${JSON.stringify(id)}`);
  }
  if (padIds.length === 0) fail("No pads left to import.");

  if (listPads) {
    // Deliberately requestedPads, not padIds: an inventory should show what is
    // in the file, including what the import would skip.
    console.log(`\npad                                        head  revs  chars  authors  saved`);
    for (const id of requestedPads) {
      const pad = db.pads.get(id)!;
      const revs = db.revs.get(id) ?? new Map();
      const authorSet = new Set([...revs.values()].map((r) => r.meta.author ?? ""));
      console.log(
        `  ${JSON.stringify(id).padEnd(42).slice(0, 42)} ${String(pad.head).padStart(4)} ` +
          `${String(revs.size).padStart(5)} ${String(pad.atext.text.length).padStart(6)} ` +
          `${String(authorSet.size).padStart(8)} ${String((pad.savedRevisions ?? []).length).padStart(6)}`,
      );
    }
    return;
  }

  // Which authors actually wrote something in the selected pads. The globalAuthor
  // table is a superset — it keeps records for authors whose pads are gone.
  const revisionsByAuthor = new Map<string, number>();
  const padsByAuthor = new Map<string, Set<string>>();
  for (const id of padIds) {
    const pad = db.pads.get(id)!;
    const revs = db.revs.get(id) ?? new Map();
    for (let rev = 0; rev <= pad.head; rev++) {
      const author = revs.get(rev)?.meta.author ?? "";
      revisionsByAuthor.set(author, (revisionsByAuthor.get(author) ?? 0) + 1);
      if (!padsByAuthor.has(author)) padsByAuthor.set(author, new Set());
      padsByAuthor.get(author)!.add(id);
    }
  }

  const authorMap = loadAuthorMap(arg("authors"));

  if (listAuthors) {
    console.log(`\n${revisionsByAuthor.size} authors wrote in the selected pads. An --authors skeleton:\n`);
    const skeleton: Record<string, { email: string; name: string; pads?: string[] }> = {};
    for (const [id, count] of [...revisionsByAuthor].sort((a, b) => b[1] - a[1])) {
      const ga = db.authors.get(id);
      const label = id === "" ? "(unattributed)" : id;
      console.log(
        `  // ${label.padEnd(22)} ${String(count).padStart(5)} revs in ${padsByAuthor.get(id)!.size} pads` +
          `  name=${JSON.stringify(ga?.name ?? null)} etherpadColor=${JSON.stringify(ga?.colorId ?? null)}`,
      );
      // `pads` goes in the entry itself rather than a comment above it: which
      // documents someone wrote in is usually what decides who they are, and
      // that decision is made one author at a time, so the evidence belongs
      // beside the field being filled in. Last of the three keys so `email`
      // stays at the top of each entry where it is edited. The importer
      // tolerates it and never reads it (AUTHOR_ENTRY_KEYS), so the file
      // round-trips straight back in as --authors with the titles still there.
      if (includeTitles) {
        skeleton[id] = {
          email: "",
          name: ga?.name ?? "",
          pads: [...padsByAuthor.get(id)!].sort().map((padId) => prettyTitle(padId, titleMode)),
        };
      } else {
        skeleton[id] = { email: "", name: ga?.name ?? "" };
      }
    }
    console.log(`\n${JSON.stringify(skeleton, null, 2)}\n`);
    console.log(`Leave an email blank to get a placeholder account at @${authorDomain} that cannot sign in.`);
    return;
  }

  // EVERY --authors KEY MUST NAME AN AUTHOR THAT ACTUALLY WROTE SOMETHING.
  // A key matching nothing is otherwise completely inert: the person it was
  // meant to cover falls through to a placeholder account, and the only trace
  // is one more line in a summary that looks much like the lines around it.
  // Attribution is baked into the Yjs history at import time and cannot be
  // repointed afterwards, so silently inert is the worst failure mode available
  // here — hence a hard stop rather than a warning.
  //
  // Etherpad author ids are case-sensitive (`a.HdfupRyGqy3CxVPV`), and the
  // placeholder emails this script generates are lower-cased, so building the
  // mapping file from a previous run's summary rather than from --list-authors
  // is an easy way to end up with keys that differ only in case. That case is
  // named explicitly rather than quietly accepted: matching case-insensitively
  // would be a guess about identity, and this file's whole job is not guessing.
  if (authorMap.size > 0) {
    const present = new Set(revisionsByAuthor.keys());
    const byLowercase = new Map<string, string>();
    for (const id of present) byLowercase.set(id.toLowerCase(), id);

    const unmatched: string[] = [];
    for (const key of authorMap.keys()) {
      if (present.has(key)) continue;
      const near = byLowercase.get(key.toLowerCase());
      unmatched.push(
        near
          ? `${JSON.stringify(key)} — no such author, but ${JSON.stringify(near)} exists` +
            ` (${revisionsByAuthor.get(near)} revs). Etherpad author ids are case-sensitive.`
          : `${JSON.stringify(key)} — no author with this id wrote in the selected pads`,
      );
    }

    if (unmatched.length) {
      console.error(`\n  ${unmatched.length} --authors entries match no author in this file:`);
      for (const u of unmatched) console.error(`    ${u}`);
      if (!allowUnusedAuthors) {
        fail(
          "Refusing to import: whoever those entries were meant to cover would silently get a placeholder " +
            "account instead, and attribution can't be repointed after the fact. Fix the ids " +
            "(--list-authors prints them verbatim), or pass --allow-unused-authors.",
        );
      }
    }
  }

  // ---- Stages 1-3, no database ------------------------------------------
  // Author ids are resolved to User.ids only in the write phase, so mapping
  // runs twice: once here against a stand-in so the schema/atext gates and the
  // attribute inventory are available before any DB work, and once for real.
  const identityMap: MapOptions = {
    authorIdToUserId: (id) => (id === SYSTEM_AUTHOR ? null : `pending:${id}`),
    indentAs,
    headingAttribute,
    ignoreAttributes,
  };

  const selfTestFailures = runMappingSelfTest();
  if (selfTestFailures.length) {
    console.error(`\n  The list-nesting self-test failed (${selfTestFailures.length}):`);
    for (const f of selfTestFailures) console.error(`    ${f}`);
    fail("Refusing to import with a broken structural mapping.");
  }
  console.log(`\nMapping self-test: passed.`);

  const replays = new Map<string, ReplayResult>();
  const unknownAll = new Map<string, number>();
  const ignoredAll = new Map<string, number>();
  const failedPads: string[] = [];
  let totalRevisions = 0;
  let totalKeyRevs = 0;
  let totalIndentLines = 0;
  let totalSynthesized = 0;
  let totalAnomalies = 0;

  const startedAt = Date.now();
  for (const id of padIds) {
    try {
      const result = replayPad(id, db.pads.get(id)!, db.revs.get(id) ?? new Map(), identityMap, seedOptions);
      // The atext gates prove the replay; this proves the whole
      // atext -> ProseMirror pipeline is lossless on text. Against the VISIBLE
      // cells, since dropping the boilerplate is exactly the difference the
      // mapping is now allowed to have from the pad.
      const expected = cellsTextWithoutMarkers(result.finalVisibleCells);
      const got = proseMirrorText(result.steps[result.steps.length - 1].doc.toJSON());
      if (got !== expected && result.synthesizedItems === 0) {
        throw new Error(
          `${id}: the mapped document's text does not match the pad's ` +
            `(${got.length} chars vs ${expected.length}); first difference at ` +
            `${[...got].findIndex((c, i) => c !== expected[i])}`,
        );
      }
      replays.set(id, result);
      totalRevisions += result.steps.length;
      totalKeyRevs += result.keyRevsChecked;
      totalIndentLines += result.indentLines;
      totalSynthesized += result.synthesizedItems;
      totalAnomalies += result.lineCountAnomalies;
      for (const [k, v] of result.unknown) unknownAll.set(k, (unknownAll.get(k) ?? 0) + v);
      for (const [k, v] of result.ignored) ignoredAll.set(k, (ignoredAll.get(k) ?? 0) + v);
    } catch (err) {
      failedPads.push(err instanceof Error ? err.message : String(err));
    }
  }

  console.log(
    `Replayed: ${totalRevisions} revisions across ${replays.size} pads in ${Date.now() - startedAt}ms\n` +
      `          ${totalKeyRevs} keyRev checkpoints + ${replays.size} head atexts matched exactly` +
      `${totalAnomalies ? `\n          ${totalAnomalies} |lines declarations disagreed with the actual newline count` : ""}` +
      `${totalIndentLines ? `\n          ${totalIndentLines} indent lines mapped to ${indentAs}` : ""}` +
      `${totalSynthesized ? `\n          ${totalSynthesized} list items synthesized for skipped nesting levels` : ""}`,
  );

  if (failedPads.length) {
    console.error(`\n  ${failedPads.length} pad(s) FAILED and will not be imported:`);
    for (const f of failedPads) console.error(`    ${f}`);
  }

  const seededPads = [...replays].filter(([, r]) => r.seeded);
  if (seedOptions.stripSeedText && seededPads.length) {
    const survived = seededPads.filter(([, r]) => r.seedSurvivedToHead);
    const emptied = seededPads.filter(([, r]) => r.emptyAfterSeedStrip);
    console.log(
      `\n  Etherpad's boilerplate pad text was removed from ${seededPads.length} pad(s)' ENTIRE history,` +
        ` as though it had never been there (--keep-default-text to import it):`,
    );
    console.log(
      `    ${seededPads.length - survived.length} had deleted it themselves at some point` +
        ` — those revisions now show no boilerplate before the deletion either`,
    );
    if (survived.length) {
      console.log(`    ${survived.length} still carried some of it at head, so the import is what removed it:`);
      for (const [id] of survived) console.log(`      ${JSON.stringify(id)}`);
    }
    if (emptied.length) {
      console.log(`    ${emptied.length} contained NOTHING ELSE and import as empty documents:`);
      for (const [id] of emptied) console.log(`      ${JSON.stringify(id)}`);
    }
  }
  if (ignoredAll.size) {
    console.log(`\n  Attributes dropped by --ignore-attributes:`);
    for (const [k, v] of ignoredAll) console.log(`    ${k} — ${v} characters`);
  }
  if (unknownAll.size) {
    console.log(`\n  UNKNOWN attributes (${unknownAll.size}) — these carry meaning this import would flatten:`);
    for (const [k, v] of unknownAll) console.log(`    ${k} — ${v} characters`);
    if (!allowUnmapped) {
      fail("Refusing to import. Map them, or pass --ignore-attributes=<a,b> / --allow-unmapped to drop them.");
    }
  }

  if (verifyOnly) {
    console.log(failedPads.length ? "\nVerification FAILED.\n" : "\nVerification passed. Nothing was written.\n");
    process.exitCode = failedPads.length ? 1 : 0;
    return;
  }
  if (failedPads.length) fail("Not importing while pads are failing verification. Fix or exclude them with --pad=.");

  // ---- Stage 5: write -----------------------------------------------------
  const { prismaIncludingDeleted } = await import("../../src/lib/prisma");
  console.log(`Target: ${(process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":****@")}`);
  console.log(dryRun ? "Mode:   DRY RUN (everything rolls back)\n" : "Mode:   LIVE\n");

  const summary = {
    usersCreated: [] as string[],
    usersLinked: [] as string[],
    docs: [] as string[],
    renamedSlugs: [] as string[],
    replaced: [] as string[],
    collapsed: [] as string[],
    snapshots: [] as string[],
    savedLabels: [] as string[],
    updateRows: 0,
    generatedBytes: 0,
    etherpadChars: 0,
  };

  try {
    await prismaIncludingDeleted.$transaction(
      async (tx) => {
        const claimedUserSlugs = new Set<string>();
        const claimedDocSlugs = new Set<string>();
        const claimedDocIds = new Set<string>();
        const resolved = new Map<string, ResolvedAuthor>();

        for (const [etherpadId, revisions] of [...revisionsByAuthor].sort((a, b) => b[1] - a[1])) {
          if (etherpadId === SYSTEM_AUTHOR) continue;

          const entry = authorMap.get(etherpadId);
          const ga = db.authors.get(etherpadId);
          const mappedEmail = typeof entry === "string" ? entry : entry?.email;
          const suffix = etherpadId === "" ? "unattributed" : etherpadId.replace(/^a\./, "").toLowerCase();
          const email = (mappedEmail || `etherpad-${suffix}@${authorDomain}`).toLowerCase();
          const name =
            (typeof entry === "object" ? entry.name : undefined) ??
            ga?.name ??
            (etherpadId === "" ? "Unattributed (Etherpad)" : null);

          const existing = await tx.user.findUnique({ where: { email }, select: { id: true, name: true } });
          if (existing) {
            resolved.set(etherpadId, { etherpadId, userId: existing.id, email, name: existing.name, created: false, revisions });
            summary.usersLinked.push(`${etherpadId || "(unattributed)"} → ${email} (existing account)`);
            continue;
          }

          const explicitInitials = typeof entry === "object" ? entry.adminInitials : undefined;
          const created = await tx.user.create({
            data: {
              email,
              slug: await claimSlug(tx, "user", name || email.split("@")[0], claimedUserSlugs),
              name,
              // NEVER a password, mapped or not. An account exists here to own
              // attribution, not to be signed into, and a data migration has no
              // business minting credentials — anything it could derive one from
              // (the author id) is in the file it just read, so the "password"
              // would be a published secret. An explicitly mapped address that
              // did not already exist is handed over with
              // `npx tsx scripts/set-user-password.ts`, or through the ordinary
              // password-reset flow.
              passwordHash: null,
              role: asEnum(Role, (typeof entry === "object" ? entry.role : undefined) ?? Role.COMMENTER, "--authors role"),
              color: colorForSeed(email),
              adminInitials: explicitInitials ?? deriveInitials(name, email),
            },
            select: { id: true },
          });
          resolved.set(etherpadId, { etherpadId, userId: created.id, email, name, created: true, revisions });
          summary.usersCreated.push(
            `${etherpadId || "(unattributed)"} → ${email}` +
              ` name=${JSON.stringify(name)} ${revisions} revs` +
              (mappedEmail
                ? "  [MAPPED but no such account existed — created WITHOUT a password; set one to hand it over]"
                : "  [placeholder, cannot sign in]") +
              `${ga?.colorId !== undefined ? `  etherpadColor=${JSON.stringify(ga.colorId)}` : ""}`,
          );
        }

        const userIdFor = (etherpadId: string): string | null => resolved.get(etherpadId)?.userId ?? null;
        const mapOptions: MapOptions = { authorIdToUserId: userIdFor, indentAs, headingAttribute, ignoreAttributes };

        // Within a group of pads whose names slugify alike, the one with the
        // most revisions goes first so it claims the unsuffixed id and url.
        // Plain alphabetical order would hand /doc/eve-and-the-serpent to the
        // empty pad created by a mistyped title and push the real document to
        // -2, because a space sorts before an underscore.
        const importOrder = [...padIds].sort((a, b) => {
          const sa = slugify(a, "doc");
          const sb = slugify(b, "doc");
          if (sa !== sb) return sa < sb ? -1 : 1;
          const ha = db.pads.get(a)!.head;
          const hb = db.pads.get(b)!.head;
          return hb - ha || (a < b ? -1 : 1);
        });

        for (const padId of importOrder) {
          const pad = db.pads.get(padId)!;
          // Deterministic so a re-run recognizes its own rows, but two pad names
          // can still slugify alike — "Eve and the serpent " and
          // "Eve_and_the_serpent" both do, since Etherpad has no rename and a
          // retitle means a second pad. padIds is sorted, so the suffix a given
          // pad gets is stable across runs.
          const baseDocId = `etherpad-${slugify(padId, "doc")}`;
          let docId = baseDocId;
          for (let n = 2; claimedDocIds.has(docId); n += 1) docId = `${baseDocId}-${n}`;
          if (docId !== baseDocId) summary.renamedSlugs.push(`${padId} → id ${docId} (name collides with another pad)`);
          claimedDocIds.add(docId);
          const title = prettyTitle(padId, titleMode);

          const clash = await tx.doc.findUnique({ where: { id: docId }, select: { id: true } });
          if (clash) {
            if (!replace) {
              throw new Error(
                `A doc already exists for pad ${JSON.stringify(padId)} (${docId}). Pass --replace to redo it.`,
              );
            }
            // ydoc has no FK to doc in either direction (§12b) — delete both.
            // Post.docId is onDelete: Restrict, so this correctly refuses to
            // pull a doc out from under a published post.
            await tx.ydoc.deleteMany({ where: { id: ydocIdForDoc(docId) } });
            await tx.doc.delete({ where: { id: docId } });
            summary.replaced.push(`${padId} (${docId})`);
          }

          // Re-map with real User.ids now that they exist.
          const replay = replayPad(padId, pad, db.revs.get(padId) ?? new Map(), mapOptions, seedOptions);

          const savedRevisions = new Map<number, { userId: string | null; at: Date }>();
          for (const saved of pad.savedRevisions ?? []) {
            savedRevisions.set(Number(saved.revNum), {
              userId: userIdFor(saved.savedById),
              at: new Date(saved.timestamp),
            });
            summary.savedLabels.push(
              `${padId} rev ${saved.revNum} — ${JSON.stringify(saved.label ?? "")} (label not stored; ydoc_snapshot has no column for it)`,
            );
          }

          const log = buildLog({
            padId,
            title,
            steps: replay.steps,
            savedRevisions,
            snapshotEvery,
            userIdFor,
          });
          summary.generatedBytes += log.generatedBytes;
          summary.etherpadChars += replay.etherpadInsertedChars;
          if (log.collapsedRevs.length) {
            summary.collapsed.push(
              `${padId} — ${log.collapsedRevs.length} revision(s) changed nothing once mapped, so wrote no row: ` +
                `${log.collapsedRevs.slice(0, 12).join(", ")}${log.collapsedRevs.length > 12 ? ", …" : ""}`,
            );
          }

          const bytes = log.rows.map((r) => r.bytes);
          const state = new Uint8Array(Y.mergeUpdates(bytes));
          const stateVector = Y.encodeStateVectorFromUpdate(state);

          // What the app will decode, from exactly the bytes about to be written.
          const decoded = new Y.Doc();
          Y.applyUpdate(decoded, state);
          const bodyJSON = TiptapTransformer.extensions(docContentExtensions).fromYdoc(decoded, "default");
          decoded.destroy();

          const slug = await claimSlug(tx, "doc", title, claimedDocSlugs);
          if (slug !== slugify(title, "doc")) summary.renamedSlugs.push(`${padId} → /doc/${slug}`);

          const authorsSeen: string[] = [];
          for (const step of replay.steps) {
            const userId = userIdFor(step.author);
            if (userId && !authorsSeen.includes(userId)) authorsSeen.push(userId);
          }

          await tx.doc.create({
            data: {
              id: docId,
              slug,
              title,
              visibility,
              proseJson: JSON.parse(JSON.stringify(bodyJSON)),
              createdAt: new Date(replay.steps[0].timestamp),
              authors: { create: authorsSeen.map((userId, i) => ({ userId, bylineOrder: i })) },
            },
          });

          const ydocId = ydocIdForDoc(docId);
          await tx.ydoc.create({
            data: { id: ydocId, ydoc: Buffer.from(state), stateVector: Buffer.from(stateVector) },
          });

          for (let i = 0; i < log.rows.length; i += UPDATE_BATCH) {
            const batch = log.rows.slice(i, i + UPDATE_BATCH);
            await tx.ydocUpdate.createMany({
              data: batch.map((row) => ({ ydocId, update: Buffer.from(row.bytes), createdAt: row.at })),
            });
            summary.updateRows += batch.length;
          }

          if (log.snapshots.length) {
            // The ydoc is new in this transaction, so these are exactly our rows,
            // in the order they were inserted.
            const ids = await tx.ydocUpdate.findMany({
              where: { ydocId },
              select: { id: true },
              orderBy: { id: "asc" },
            });
            if (ids.length !== log.rows.length) {
              throw new Error(`${padId}: wrote ${log.rows.length} update rows but read back ${ids.length}`);
            }
            await tx.ydocSnapshot.createMany({
              data: log.snapshots.map((snap) => ({
                ydocId,
                ydoc: Buffer.from(snap.bytes),
                stateVector: Buffer.from(Y.encodeStateVectorFromUpdate(snap.bytes)),
                lastYdocUpdateId: ids[snap.afterIndex].id,
                userId: snap.userId,
                createdAt: snap.at,
              })),
            });
            summary.snapshots.push(
              `${padId} — ${log.snapshots.length} at rev ${log.snapshots.map((x) => x.rev).join(", ")}`,
            );
          }

          const lastAt = log.rows[log.rows.length - 1].at;
          await tx.$executeRawUnsafe(`UPDATE "doc" SET "updated_at" = $1 WHERE "id" = $2`, lastAt, docId);
          await tx.$executeRawUnsafe(`UPDATE "ydoc" SET "updated_at" = $1 WHERE "id" = $2`, lastAt, ydocId);

          summary.docs.push(
            `${padId} → /doc/${slug} (${docId}) — ${log.rows.length} rows, ${authorsSeen.length} author(s), ` +
              `${new Date(replay.steps[0].timestamp).toISOString().slice(0, 10)}…${lastAt.toISOString().slice(0, 10)}`,
          );
        }

        if (dryRun) throw ROLLBACK;
      },
      { timeout, maxWait: 30_000 },
    );
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  } finally {
    await prismaIncludingDeleted.$disconnect();
  }

  const verb = dryRun ? "Would import" : "Imported";
  console.log(`\n${verb}:`);
  console.log(`  users:        ${summary.usersCreated.length} created, ${summary.usersLinked.length} linked by email`);
  console.log(`  docs:         ${summary.docs.length}`);
  console.log(`  ydoc_updates: ${summary.updateRows}`);
  console.log(
    `  log size:     ${(summary.generatedBytes / 1024).toFixed(0)} KiB of Yjs updates for ` +
      `${summary.etherpadChars} characters ever typed in Etherpad ` +
      `(${(summary.generatedBytes / Math.max(1, summary.etherpadChars)).toFixed(1)} bytes/char — a large ratio ` +
      `would mean y-prosemirror is rewriting whole paragraphs rather than diffing)`,
  );

  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    console.log(`\n  ${title} (${lines.length}):`);
    for (const line of lines) console.log(`    ${line}`);
  };
  // Written in import order (which is collision-preference order); read
  // alphabetically.
  summary.docs.sort((a, b) => (a < b ? -1 : 1));
  section("Users created", summary.usersCreated);
  section("Users linked to existing accounts", summary.usersLinked);
  section("Docs", summary.docs);
  section("Docs replaced", summary.replaced);
  section("Slug collisions resolved", summary.renamedSlugs);
  section("Revisions that wrote no row", summary.collapsed);
  section("Snapshots", summary.snapshots);
  section("Saved-revision labels", summary.savedLabels);

  console.log(dryRun ? "\nNothing was written. Re-run without --dry-run to apply.\n" : "\nDone.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
