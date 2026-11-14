import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden } from "@/lib/api/errors";
import { workOutPlacements, type AnchorPlacement, type PlacingVersion } from "@/lib/file-anchor-placements";
import { canUserManageFile } from "@/lib/file-authz";
import { lockFileRow } from "@/lib/file-version-data";
import { parsePdfTarget, type PdfTarget } from "@/lib/pdf-anchor";
import { mapsJoin, parsePageMap, type MapVersion, type PageMap } from "@/lib/pdf-page-map";
import { workOutPageMap, writePageMapIfNone, type SheetFactsRead } from "@/lib/pdf-page-map-build";
import { prisma, type TransactionClient } from "@/lib/prisma";

// docs/PDF.md §13, "Moving a note forward" — the move: an anchor on one
// version of a file given a target on a later one, which becomes its
// version. "Note" there and here stands for both kinds of row that hold a PDF
// target and have a writer: an annotation, and a part of an anchored link.
//
// Three things are here. **The write** (`writeAnchorMoves`), which every
// move goes through, one note's or a carry's hundreds. **The bulk carry**,
// which moves forward every posted note that places itself: planned
// (`planCarry`), shown (`previewCarry*`) and run (`carryFromVersion`, and a
// promotion's, src/lib/file-manage.ts). And **a carry's moves shown or
// hidden together** (`setCarryHidden`).
//
// **Working out where each note goes comes first and outside the
// transaction**, since it reads sheets and takes seconds
// (src/lib/file-anchor-placements.ts). The transaction then holds the file
// row's lock, and **the write's own condition** is what makes the stale
// read safe: a row is changed only where it is still on the version, and at
// the target, its placement was worked out from. A carry's write refuses a
// row marked "stays here" as well, so a mark made while the carry was
// working holds.
//
// Each function a person's act reaches takes an `Actor` and asks the gate
// itself, so an MCP front door is a wrapper (CLAUDE.md, "A write the UI and
// the MCP server share").
//
// Server-only (Prisma).

/** The two kinds of row a move changes. */
export type AnchorKind = "annotation" | "link-part";

/** One anchor as a placement is worked out from it. */
export type MovableAnchor = {
  kind: AnchorKind;
  id: string;
  /** The version it is on. */
  versionId: string;
  target: PdfTarget;
  quotedText: string;
  /**
   * Postgres's own digest of the target less its text version, which the
   * write compares with the row as it then is. Made in SQL at both ends, so
   * no number passes through JavaScript on the way. **Less its text
   * version**: `scripts/upgrade-pdf-text-version.ts` restamps a target whose
   * sheet reads the same, and that alone leaves a placement true.
   */
  fingerprint: string;
};

/** What the write takes for one anchor: where it was read, and where it goes. */
export type MoveToWrite = {
  kind: AnchorKind;
  id: string;
  fromVersionId: string;
  fingerprint: string;
  target: PdfTarget;
  quotedText: string;
};

// A move's transaction waits for the file row as a version's other writes do
// (`VERSION_WRITE_TIMEOUTS`, file-manage.ts).
export const MOVE_WRITE_TIMEOUTS = { maxWait: 30_000, timeout: 60_000 } as const;

/** How many anchors one statement takes: a carry of several thousand splits its parameter, inside the one transaction. */
const WRITE_BATCH = 500;

// ---------------------------------------------------------------------------
// What a bulk carry takes, in SQL, with the table's alias fixed: `a` for an
// annotation, `p` for a link part. Each is used twice, to read the anchors
// a carry places and again in the write's condition, so a note that stopped
// being one of them while the placements were worked out is not moved.

/**
 * A note that is still listed: not deleted, or deleted with a reply of it
 * still standing, since such a thread is still shown and nobody else could
 * move its replies.
 */
export const NOTE_STANDS = Prisma.sql`
  (a."deleted_by_user_id" IS NULL OR EXISTS (
    WITH RECURSIVE below AS (
      SELECT r."id", r."status", r."deleted_by_user_id" FROM "annotation" r WHERE r."parent_annotation_id" = a."id"
      UNION ALL
      SELECT r."id", r."status", r."deleted_by_user_id" FROM "annotation" r JOIN below ON r."parent_annotation_id" = below."id"
    )
    SELECT 1 FROM below WHERE below."status" <> 'DRAFT' AND below."deleted_by_user_id" IS NULL
  ))`;

/** Whether a note, or a link part, carries a "stays here" mark. */
export const NOTE_MARKED = Prisma.sql`EXISTS (SELECT 1 FROM "file_anchor_move" k WHERE k."annotation_id" = a."id" AND k."to_version_id" IS NULL)`;
export const PART_MARKED = Prisma.sql`EXISTS (SELECT 1 FROM "file_anchor_move" k WHERE k."anchored_link_anchor_id" = p."id" AND k."to_version_id" IS NULL)`;

/** A posted note that still stands and isn't marked "stays here". */
const CARRIES_NOTE = Prisma.sql`a."status" <> 'DRAFT' AND ${NOTE_STANDS} AND NOT ${NOTE_MARKED}`;

/**
 * A part of a minted link that isn't deleted, open in its creator's tray or
 * marked "stays here". The tray holds an open link's parts as it loaded
 * them, each with its version, so a part moved under it would be drawn on
 * the wrong sheets until a reload.
 */
const CARRIES_PART = Prisma.sql`
  EXISTS (
    SELECT 1 FROM "anchored_link" l
    WHERE l."id" = p."link_id" AND l."minted_at" IS NOT NULL AND l."reopened_at" IS NULL AND l."deleted_at" IS NULL
  )
  AND NOT ${PART_MARKED}`;

type AnchorRow = { id: string; versionId: string; target: unknown; quotedText: string; fingerprint: string };

function anchorsFrom(kind: AnchorKind, rows: readonly AnchorRow[]): MovableAnchor[] {
  return rows.flatMap((row) => {
    const target = parsePdfTarget(row.target);
    return target ? [{ kind, id: row.id, versionId: row.versionId, target, quotedText: row.quotedText, fingerprint: row.fingerprint }] : [];
  });
}

/** Every anchor a carry takes on these versions of the file: everyone's posted notes and the parts of everyone's minted links. */
async function carriedAnchorsOn(fileId: string, versionIds: readonly string[]): Promise<MovableAnchor[]> {
  if (versionIds.length === 0) return [];
  const [notes, parts] = await Promise.all([
    prisma.$queryRaw<AnchorRow[]>(Prisma.sql`
      SELECT a."id", a."file_version_id" AS "versionId", a."pdf_target" AS "target", a."quoted_text" AS "quotedText",
             md5((a."pdf_target" - 'textVersion')::text) AS "fingerprint"
      FROM "annotation" a
      WHERE a."file_id" = ${fileId} AND a."file_version_id" = ANY(${[...versionIds]}::text[]) AND a."pdf_target" IS NOT NULL AND ${CARRIES_NOTE}
      ORDER BY a."created_at", a."id"`),
    prisma.$queryRaw<AnchorRow[]>(Prisma.sql`
      SELECT p."id", p."file_version_id" AS "versionId", p."selector" AS "target", p."quoted_text" AS "quotedText",
             md5((p."selector" - 'textVersion')::text) AS "fingerprint"
      FROM "anchored_link_anchor" p
      WHERE p."file_id" = ${fileId} AND p."file_version_id" = ANY(${[...versionIds]}::text[]) AND p."selector_kind" = 'PDF_TEXT' AND ${CARRIES_PART}
      ORDER BY p."link_id", p."part_order", p."id"`),
  ]);
  return [...anchorsFrom("annotation", notes), ...anchorsFrom("link-part", parts)];
}

// ---------------------------------------------------------------------------
// The write.

/**
 * Writes moves to `destinationVersionId`, inside `tx`, **which holds the
 * file row's lock** (`lockFileRow`). Answers the anchors it moved. One not
 * answered was skipped: it had left the version or the target its placement
 * was worked out from (moved from another tab, or by a carry that got there
 * first), or, for a carry, it was no longer a note a carry takes.
 *
 * **Two checks are the file's, and are made once**: the destination is a
 * promoted version of the file later than every version the notes are on,
 * and it has page text at each text version the new targets name. Whether
 * the mover may make the move is the caller's to have asked.
 *
 * **The third is each note's, and is the write's own condition.** One
 * statement for each anchor table takes its whole batch as one parameter:
 * an `UPDATE` that sets a row's target, quote and version where the row is
 * still on the version, and at the target, the placement started from,
 * feeding the `INSERT` that writes the history of exactly the rows it
 * changed. Raw SQL: Prisma has no update that sets different values on
 * different rows. The history keeps the version, target and quote the row
 * had, read in the same statement (`prior`, the table joined to itself,
 * which an `UPDATE` reads as it was).
 *
 * **A carry** (`carryId` set) adds to the condition that the row is still a
 * note a carry takes, and so that it has no "stays here" mark; its moves
 * are hidden. **A move of one note** takes its mark off, and its row says
 * the note was marked; its move is shown.
 *
 * It changes nothing else on a row: not a note's `editedAt`, and not a
 * link's. The search vector follows the quote by its own trigger.
 */
export async function writeAnchorMoves(
  tx: TransactionClient,
  opts: { fileId: string; destinationVersionId: string; moves: readonly MoveToWrite[]; movedByUserId: string; carryId: string | null },
): Promise<{ kind: AnchorKind; id: string }[]> {
  const { fileId, destinationVersionId: destination, moves, movedByUserId, carryId } = opts;
  if (moves.length === 0) return [];

  const versions = await tx.fileVersion.findMany({
    where: { fileId, id: { in: [destination, ...new Set(moves.map((move) => move.fromVersionId))] } },
    select: { id: true, number: true, promotedAt: true, abandonedAt: true },
  });
  const to = versions.find((version) => version.id === destination);
  if (!to || to.promotedAt === null || to.abandonedAt !== null) {
    throw new ApiError("conflict", "A note can be moved only to a version of this file that has been promoted.");
  }
  const numberOf = new Map(versions.map((version) => [version.id, version.number]));
  for (const move of moves) {
    const from = numberOf.get(move.fromVersionId);
    if (from === undefined || from >= to.number) {
      throw new ApiError("conflict", `A note is moved forward only, and version ${to.number} is not later than the version one of these notes is on.`);
    }
  }
  const named = [...new Set(moves.map((move) => move.target.textVersion))];
  const held = await tx.filePageText.groupBy({ by: ["textVersion"], where: { fileVersionId: destination, textVersion: { in: named } } });
  if (held.length < named.length) {
    throw new ApiError("conflict", `Version ${to.number} has no page text at the text version these notes were placed against. Try again.`);
  }

  const hidden = carryId !== null;
  const moved: { kind: AnchorKind; id: string }[] = [];
  const batchOf = (kind: AnchorKind, from: number) =>
    JSON.stringify(
      moves
        .filter((move) => move.kind === kind)
        .slice(from, from + WRITE_BATCH)
        .map((move) => ({ id: move.id, from: move.fromVersionId, fingerprint: move.fingerprint, target: move.target, quote: move.quotedText })),
    );
  const BATCH = (json: string) => Prisma.sql`
    SELECT * FROM jsonb_to_recordset(${json}::jsonb) AS b("id" text, "from" text, "fingerprint" text, "target" jsonb, "quote" text)`;

  const notes = moves.filter((move) => move.kind === "annotation").length;
  for (let from = 0; from < notes; from += WRITE_BATCH) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH batch AS (${BATCH(batchOf("annotation", from))}),
      moved AS (
        UPDATE "annotation" a
        SET "pdf_target" = b."target", "quoted_text" = b."quote", "file_version_id" = ${destination}
        FROM batch b, "annotation" prior
        WHERE a."id" = b."id" AND prior."id" = a."id"
          AND a."file_id" = ${fileId}
          AND a."file_version_id" = b."from"
          AND md5((a."pdf_target" - 'textVersion')::text) = b."fingerprint"
          AND ${carryId !== null ? CARRIES_NOTE : Prisma.sql`TRUE`}
        RETURNING a."id", prior."file_version_id" AS "from", prior."pdf_target" AS "target", prior."quoted_text" AS "quote"
      )
      INSERT INTO "file_anchor_move" ("annotation_id", "from_version_id", "from_target", "from_quoted_text", "to_version_id", "moved_by_user_id", "carry_id", "was_marked", "hidden")
      SELECT m."id", m."from", m."target", m."quote", ${destination}, ${movedByUserId}, ${carryId},
             EXISTS (SELECT 1 FROM "file_anchor_move" k WHERE k."annotation_id" = m."id" AND k."to_version_id" IS NULL), ${hidden}
      FROM moved m
      RETURNING "annotation_id" AS "id"`);
    moved.push(...rows.map((row) => ({ kind: "annotation" as const, id: row.id })));
  }

  const parts = moves.length - notes;
  for (let from = 0; from < parts; from += WRITE_BATCH) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      WITH batch AS (${BATCH(batchOf("link-part", from))}),
      moved AS (
        UPDATE "anchored_link_anchor" p
        SET "selector" = b."target", "quoted_text" = b."quote", "file_version_id" = ${destination}
        FROM batch b, "anchored_link_anchor" prior
        WHERE p."id" = b."id" AND prior."id" = p."id"
          AND p."file_id" = ${fileId}
          AND p."selector_kind" = 'PDF_TEXT'
          AND p."file_version_id" = b."from"
          AND md5((p."selector" - 'textVersion')::text) = b."fingerprint"
          AND ${carryId !== null ? CARRIES_PART : Prisma.sql`TRUE`}
        RETURNING p."id", prior."file_version_id" AS "from", prior."selector" AS "target", prior."quoted_text" AS "quote"
      )
      INSERT INTO "file_anchor_move" ("anchored_link_anchor_id", "from_version_id", "from_target", "from_quoted_text", "to_version_id", "moved_by_user_id", "carry_id", "was_marked", "hidden")
      SELECT m."id", m."from", m."target", m."quote", ${destination}, ${movedByUserId}, ${carryId},
             EXISTS (SELECT 1 FROM "file_anchor_move" k WHERE k."anchored_link_anchor_id" = m."id" AND k."to_version_id" IS NULL), ${hidden}
      FROM moved m
      RETURNING "anchored_link_anchor_id" AS "id"`);
    moved.push(...rows.map((row) => ({ kind: "link-part" as const, id: row.id })));
  }

  // Moving a note takes its "stays here" mark off. A carry moved no marked
  // row, so it has none to take.
  if (carryId === null && moved.length > 0) {
    const ids = (kind: AnchorKind) => moved.filter((row) => row.kind === kind).map((row) => row.id);
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "file_anchor_move"
      WHERE "to_version_id" IS NULL AND ("annotation_id" = ANY(${ids("annotation")}::text[]) OR "anchored_link_anchor_id" = ANY(${ids("link-part")}::text[]))`);
  }
  return moved;
}

// ---------------------------------------------------------------------------
// The bulk carry.

/** What a carry would do, in numbers, for whoever is about to run it. */
export type CarryPreview = {
  /** The version the notes would move to. */
  toNumber: number;
  /** The versions whose notes it takes, oldest first. */
  fromNumbers: number[];
  /** How many posted notes and how many link parts would move. */
  notes: number;
  parts: number;
  /** What would stay, by the version it is on: what has a proposal or no place, for its author. */
  stays: { number: number; count: number }[];
  /** The versions whose page map the carry would store first, each saying it holds its base's text. */
  storesMaps: number[];
};

/** What a carry did. */
export type CarryResult = {
  carryId: string;
  toNumber: number;
  /** How many notes and link parts it moved. */
  moved: number;
  /** What stayed, by version. */
  stayed: { number: number; count: number }[];
  /** What placed itself and was not written: moved or marked meanwhile. The next carry takes what is still there. */
  skipped: number;
  /** The versions whose page map it stored. */
  storedMaps: number[];
};

/** A version of a file in its line of versions, with the page map it has over its base. */
export type LineVersion = PlacingVersion & { baseVersionId: string | null; promotedAt: Date | null; abandonedAt: Date | null; map: PageMap | null };

/** A carry worked out and not yet written. */
export type CarryPlan = {
  fileId: string;
  destination: LineVersion;
  sources: LineVersion[];
  /** Maps worked out for versions that have none, to be stored with the carry. */
  mapsToStore: { version: LineVersion; map: PageMap }[];
  anchors: MovableAnchor[];
  placements: AnchorPlacement[];
};

/** A file's versions, oldest first. */
export async function lineOf(fileId: string): Promise<LineVersion[]> {
  const rows = await prisma.fileVersion.findMany({
    where: { fileId },
    orderBy: { number: "asc" },
    select: { id: true, number: true, sha256: true, pageCount: true, baseVersionId: true, promotedAt: true, abandonedAt: true, pageMap: true },
  });
  return rows.map(({ pageMap, ...version }) => ({ ...version, map: parsePageMap(pageMap) }));
}

/**
 * What carries a sheet between these versions (`carrySheet`): each one's
 * stored page map, or the one `worked` holds for it, worked out and not
 * stored.
 */
export function mapsOfLine(versions: readonly LineVersion[], worked: ReadonlyMap<string, PageMap> = new Map()): MapVersion[] {
  const numberOf = new Map(versions.map((version) => [version.id, version.number]));
  return versions.map((version) => ({
    number: version.number,
    base: version.baseVersionId ? (numberOf.get(version.baseVersionId) ?? null) : null,
    map: (worked.get(version.id) ?? version.map)?.sheets ?? null,
  }));
}

/**
 * Works out a carry to `destinationId`, **storing nothing**.
 *
 * It takes the notes on every earlier version that page maps join to the
 * destination without a break. A version followed by one without a map ends
 * the chain: a revised text followed it, and what is on it or before it
 * waits for its authors.
 *
 * With `startFromId`, the carry a manager starts on one earlier version: a
 * map is first worked out for every version from there forward that has
 * none. Starting it on a version that a revised text followed is that
 * manager's judgement that the two hold the same text after all, and the
 * plan carries those maps to be stored only if the carry is run.
 */
export async function planCarry(fileId: string, destinationId: string, startFromId: string | null): Promise<CarryPlan> {
  const versions = await lineOf(fileId);
  const destination = versions.find((version) => version.id === destinationId);
  if (!destination || destination.abandonedAt !== null) throw new ApiError("not_found", "That version doesn't exist.");
  const byId = new Map(versions.map((version) => [version.id, version]));

  const mapsToStore: CarryPlan["mapsToStore"] = [];
  if (startFromId !== null) {
    const start = byId.get(startFromId);
    // The versions from the destination back to the one it starts on, each over its base.
    const forward: LineVersion[] = [];
    let at: LineVersion | undefined = destination;
    while (at && at.id !== startFromId) {
      forward.push(at);
      at = at.baseVersionId ? byId.get(at.baseVersionId) : undefined;
    }
    if (!start || !at || start.promotedAt === null || start.abandonedAt !== null || start.id === destination.id) {
      throw new ApiError("conflict", `Version ${destination.number} was not uploaded over that version, so no note on it can be carried there.`);
    }
    // One reading of each version's sheets for all of them: a version between
    // two others is the version of one map and the base of the next.
    const read: SheetFactsRead = new Map();
    for (const version of forward.reverse()) {
      if (!version.map) mapsToStore.push({ version, map: (await workOutPageMap(version.id, read)).map });
    }
  }
  const maps = mapsOfLine(versions, new Map(mapsToStore.map(({ version, map }) => [version.id, map])));

  const sources = versions.filter(
    (version) =>
      version.id !== destination.id &&
      version.promotedAt !== null &&
      version.abandonedAt === null &&
      version.number < destination.number &&
      mapsJoin(version.number, destination.number, maps),
  );
  const anchors = await carriedAnchorsOn(fileId, sources.map((version) => version.id));
  const placements = await workOutPlacements(anchors, sources, destination, maps);
  return { fileId, destination, sources, mapsToStore, anchors, placements };
}

/** The moves a plan would write: what places itself. */
export function movesOf(plan: CarryPlan): MoveToWrite[] {
  return plan.anchors.flatMap((anchor, index): MoveToWrite[] => {
    const placement = plan.placements[index];
    if (placement.kind !== "placed") return [];
    return [{ kind: anchor.kind, id: anchor.id, fromVersionId: anchor.versionId, fingerprint: anchor.fingerprint, target: placement.target, quotedText: placement.quotedText }];
  });
}

function staysOf(plan: CarryPlan): { number: number; count: number }[] {
  const counts = new Map<string, number>();
  plan.anchors.forEach((anchor, index) => {
    if (plan.placements[index].kind !== "placed") counts.set(anchor.versionId, (counts.get(anchor.versionId) ?? 0) + 1);
  });
  return plan.sources.flatMap((version) => (counts.has(version.id) ? [{ number: version.number, count: counts.get(version.id)! }] : []));
}

export function previewOf(plan: CarryPlan): CarryPreview {
  const moves = movesOf(plan);
  const notes = moves.filter((move) => move.kind === "annotation").length;
  return {
    toNumber: plan.destination.number,
    fromNumbers: plan.sources.map((version) => version.number),
    notes,
    parts: moves.length - notes,
    stays: staysOf(plan),
    storesMaps: plan.mapsToStore.map(({ version }) => version.number),
  };
}

/** A plan's moves written inside `tx`, which holds the file row's lock, and what that did. */
export async function writeCarry(tx: TransactionClient, plan: CarryPlan, actor: Actor, carryId: string): Promise<CarryResult> {
  const moves = movesOf(plan);
  const moved = await writeAnchorMoves(tx, { fileId: plan.fileId, destinationVersionId: plan.destination.id, moves, movedByUserId: actor.userId, carryId });
  return {
    carryId,
    toNumber: plan.destination.number,
    moved: moved.length,
    stayed: staysOf(plan),
    skipped: moves.length - moved.length,
    storedMaps: plan.mapsToStore.map(({ version }) => version.number),
  };
}

/** A new carry's id: what its moves share, and the maps it stores. */
export function newCarryId(): string {
  return randomUUID();
}

/** The version, its file, and the actor's right to manage that file: a carry is its managers'. */
async function requireCarryVersion(actor: Actor, versionId: string): Promise<{ fileId: string; slug: string; number: number; currentVersionId: string | null }> {
  const version = await prisma.fileVersion.findUnique({
    where: { id: versionId },
    select: { fileId: true, number: true, file: { select: { slug: true, currentVersionId: true } } },
  });
  if (!version) throw new ApiError("not_found", "That version doesn't exist.");
  if (!(await canUserManageFile(actor.userId, actor.role, version.fileId))) throw forbidden("You don't have permission to manage this file.");
  return { fileId: version.fileId, number: version.number, slug: version.file.slug, currentVersionId: version.file.currentVersionId };
}

/**
 * What promoting a candidate with the carry would move, for the candidate's
 * page. Null where the candidate has no page map: a promotion builds none,
 * and so offers no carry.
 */
export async function previewCarryAtPromotion(actor: Actor, candidateId: string): Promise<CarryPreview | null> {
  const version = await requireCarryVersion(actor, candidateId);
  const row = await prisma.fileVersion.findUnique({ where: { id: candidateId }, select: { pageMap: true } });
  if (!parsePageMap(row?.pageMap)) return null;
  return previewOf(await planCarry(version.fileId, candidateId, null));
}

/**
 * What a carry started on one earlier version would do: the maps it would
 * store and the notes it would move to the latest. It stores neither, since
 * nothing in the app undoes one.
 */
export async function previewCarryFromVersion(actor: Actor, versionId: string): Promise<CarryPreview> {
  const version = await requireCarryVersion(actor, versionId);
  if (!version.currentVersionId) throw new ApiError("conflict", "This file has no latest version to carry notes to.");
  return previewOf(await planCarry(version.fileId, version.currentVersionId, versionId));
}

/**
 * Runs the bulk carry a manager starts on one earlier version (docs/PDF.md
 * §13, "Moving a note forward"): stores the page map of every version from
 * there forward that has none, and moves every posted note and minted link
 * part that places itself to the latest.
 *
 * One transaction, the file row locked: the maps and the moves are written
 * together or not at all. **A map another request stored meanwhile refuses
 * the carry**, since its placements were worked out through the map it made
 * for itself; run again, it reads the one that stands.
 *
 * Run again it moves what places itself by then: a note posted on an
 * earlier version since, one that an accepted run of sheets now reaches,
 * one whose author took the mark off, and one an earlier carry skipped.
 */
export async function carryFromVersion(actor: Actor, versionId: string): Promise<CarryResult & { slug: string }> {
  const version = await requireCarryVersion(actor, versionId);
  if (!version.currentVersionId) throw new ApiError("conflict", "This file has no latest version to carry notes to.");
  const plan = await planCarry(version.fileId, version.currentVersionId, versionId);
  return { ...(await runPlannedCarry(plan, actor)), slug: version.slug };
}

/**
 * The one transaction of a carry started on a version, from a plan worked
 * out before it: the maps the plan means to store, then its moves. Apart
 * from `carryFromVersion` so that a test can change something between the
 * working-out and the write and run this very transaction
 * (`carryAcrossChanges`, e2e/db-worker.ts). It asks no gate: its caller has.
 */
export async function runPlannedCarry(plan: CarryPlan, actor: Actor): Promise<CarryResult> {
  const carryId = newCarryId();
  return prisma.$transaction(async (tx) => {
    const file = await lockFileRow(tx, plan.fileId);
    if (!file) throw new ApiError("not_found", "File not found.");
    if (file.deleted) throw new ApiError("conflict", "This file is deleted, and no note on it is moved until it is restored.");
    for (const { version: mapped, map } of plan.mapsToStore) {
      const written = await writePageMapIfNone(tx, mapped.id, map, { userId: actor.userId, carryId });
      if (!written.stored) {
        throw new ApiError("conflict", `Version ${mapped.number}'s pages were matched while this carry was being worked out. Look at what it would do again, then run it.`);
      }
    }
    return writeCarry(tx, plan, actor, carryId);
  }, MOVE_WRITE_TIMEOUTS);
}

/**
 * Shows or hides the moves of one carry together, by its id. Whoever may
 * manage the file does: a carry's moves are hidden when it is run, which
 * suits a corrected scan, where a move tells a reader nothing, and a carry
 * that turns out to be mistaken can be shown.
 */
export async function setCarryHidden(actor: Actor, carryId: string, hidden: boolean): Promise<{ slug: string; changed: number }> {
  const move = await prisma.fileAnchorMove.findFirst({
    where: { carryId },
    select: { fromVersion: { select: { fileId: true, file: { select: { slug: true } } } } },
  });
  if (!move) throw new ApiError("not_found", "That carry moved nothing.");
  const { fileId, file } = move.fromVersion;
  if (!(await canUserManageFile(actor.userId, actor.role, fileId))) throw forbidden("You don't have permission to manage this file.");
  const { count } = await prisma.fileAnchorMove.updateMany({ where: { carryId }, data: { hidden: hidden === true } });
  return { slug: file.slug, changed: count };
}

/** One carry into a file, as the version list shows it to a manager. */
export type CarryRecord = {
  id: string;
  /** The version its notes were moved to. */
  toVersionId: string;
  at: string;
  moves: number;
  /**
   * How many of its moves are shown. A manager shows and hides them
   * together, and a note's author one of their own, so it can be some.
   */
  shown: number;
  /** Whether every one of its moves is hidden, as they are when it is run. */
  hidden: boolean;
};

/** The carries that moved a note of this file, newest first. */
export async function carriesOf(fileId: string): Promise<CarryRecord[]> {
  const rows = await prisma.$queryRaw<{ id: string; toVersionId: string; at: Date; moves: number; shown: number; hidden: boolean }[]>(Prisma.sql`
    SELECT m."carry_id" AS "id", m."to_version_id" AS "toVersionId", min(m."moved_at") AS "at", count(*)::int AS "moves",
           (count(*) FILTER (WHERE NOT m."hidden"))::int AS "shown", bool_and(m."hidden") AS "hidden"
    FROM "file_anchor_move" m
    JOIN "file_version" v ON v."id" = m."to_version_id"
    WHERE v."file_id" = ${fileId} AND m."carry_id" IS NOT NULL
    GROUP BY m."carry_id", m."to_version_id"
    ORDER BY min(m."id") DESC`);
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}
