import { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import { capturePdfTextAnchor } from "@/lib/anchors/capture";
import { displayNameOf } from "@/lib/display-name";
import {
  MOVE_WRITE_TIMEOUTS,
  NOTE_MARKED,
  NOTE_STANDS,
  PART_MARKED,
  lineOf,
  mapsOfLine,
  writeAnchorMoves,
  type AnchorKind,
} from "@/lib/file-anchor-move";
import { isWordless, workOutPlacements, type NoPlace } from "@/lib/file-anchor-placements";
import { canUserReadFile } from "@/lib/file-authz";
import { pageStampFor, pdfPath } from "@/lib/file-version";
import { lockFileRow } from "@/lib/file-version-data";
import { parsePdfTarget, type PdfTarget } from "@/lib/pdf-anchor";
import { formatPageName } from "@/lib/pdf-open-params";
import type { QuadsFound, QuoteFound } from "@/lib/pdf-placing";
import { prisma, type TransactionClient } from "@/lib/prisma";

// docs/PDF.md §13, "Moving a note forward" — the selective move: one note,
// moved by a person who judges that it still applies. "Note" stands for both
// kinds of row that hold a PDF target and have a writer: an annotation, and
// a part of an anchored link, whose author is the link's creator.
//
// **Only a note's author acts on it here**: moves it, marks it as staying or
// takes the mark off, and shows or hides a move of it. For a note a bot
// wrote, the person the bot works for does too (`user.works_for_user_id`). A
// manager of the file who is neither moves nobody's note one at a time, and
// neither does an ADMIN: no role curates other people's notes. Whoever acts
// must be able to read the file. `requireOwnNote` is that gate, and every
// function a person's act reaches asks it, so an MCP front door is a wrapper
// (CLAUDE.md, "A write the UI and the MCP server share").
//
// **The worklist** (`worklistFor`) is "my notes on earlier versions": the
// viewer's notes and link parts, and those of the bots that work for them,
// on any version but the latest, less the ones marked as staying.
// **Suggestions** (`openWorklist`) are worked out when it is opened, by the
// placing rules against the latest version, each from where the note is now.
//
// **A move is written as a carry's are** (`writeAnchorMoves`), in one
// transaction with the file row locked, and changes a row only where it is
// still on the version, and at the target, the decision was made from. Its
// target is checked as a capture's is, against the destination's own page
// text, whether the app suggested it or a person selected it.
//
// Server-only (Prisma).

/** One note: an annotation, or a part of an anchored link. */
export type NoteRef = { kind: AnchorKind; id: string };

/** A worklist's key for one note, and a suggestion's. */
export const noteKey = (ref: NoteRef): string => `${ref.kind}:${ref.id}`;

const ONLY_ITS_AUTHOR = "Only a note's author moves it, marks it as staying or shows its moves.";

type NoteRow = {
  id: string;
  fileId: string;
  versionId: string;
  target: unknown;
  quotedText: string;
  fingerprint: string;
  authorId: string;
  authorName: string | null;
  /** The person its author works for, where its author is a bot. */
  worksFor: string | null;
  /** A DRAFT, or a part of a link open in its creator's tray: its writer's alone. */
  unposted: boolean;
  /** A deleted note with no reply standing, or a part of a deleted link. */
  gone: boolean;
  marked: boolean;
  text: string;
  createdAt: Date;
  /** A part's link. */
  linkId: string | null;
};

// One read for each kind, taking the same filter: one note for the gate, a
// viewer's own on a file for the worklist. `a` and `p` are the aliases the
// carry's SQL fixes (file-anchor-move.ts).
const NOTE_COLUMNS = Prisma.sql`
  a."id", a."file_id" AS "fileId", a."file_version_id" AS "versionId", a."pdf_target" AS "target", a."quoted_text" AS "quotedText",
  md5((a."pdf_target" - 'textVersion')::text) AS "fingerprint",
  a."user_id" AS "authorId", u."name" AS "authorName", u."works_for_user_id" AS "worksFor",
  (a."status" = 'DRAFT') AS "unposted", NOT ${NOTE_STANDS} AS "gone", ${NOTE_MARKED} AS "marked",
  a."body_text" AS "text", a."created_at" AS "createdAt", NULL::text AS "linkId"
  FROM "annotation" a JOIN "user" u ON u."id" = a."user_id"
  WHERE a."pdf_target" IS NOT NULL AND a."file_version_id" IS NOT NULL AND a."parent_annotation_id" IS NULL`;

const PART_COLUMNS = Prisma.sql`
  p."id", p."file_id" AS "fileId", p."file_version_id" AS "versionId", p."selector" AS "target", p."quoted_text" AS "quotedText",
  md5((p."selector" - 'textVersion')::text) AS "fingerprint",
  l."created_by_id" AS "authorId", u."name" AS "authorName", u."works_for_user_id" AS "worksFor",
  (l."minted_at" IS NULL OR l."reopened_at" IS NOT NULL) AS "unposted", (l."deleted_at" IS NOT NULL) AS "gone", ${PART_MARKED} AS "marked",
  coalesce(l."name", '') AS "text", l."created_at" AS "createdAt", l."id" AS "linkId"
  FROM "anchored_link_anchor" p JOIN "anchored_link" l ON l."id" = p."link_id" JOIN "user" u ON u."id" = l."created_by_id"
  WHERE p."selector_kind" = 'PDF_TEXT' AND p."file_version_id" IS NOT NULL`;

async function noteRow(ref: NoteRef): Promise<NoteRow | null> {
  const [row] =
    ref.kind === "annotation"
      ? await prisma.$queryRaw<NoteRow[]>(Prisma.sql`SELECT ${NOTE_COLUMNS} AND a."id" = ${ref.id}`)
      : await prisma.$queryRaw<NoteRow[]>(Prisma.sql`SELECT ${PART_COLUMNS} AND p."id" = ${ref.id}`);
  return row ?? null;
}

function parseRef(ref: NoteRef): NoteRef {
  if ((ref?.kind !== "annotation" && ref?.kind !== "link-part") || typeof ref.id !== "string") throw invalid("That isn't a note.");
  return { kind: ref.kind, id: ref.id };
}

/**
 * The note, to an actor who may act on it: its author, or for a note a bot
 * wrote the person the bot works for, who can read its file. Refused to
 * everyone else, a manager of the file and an ADMIN included.
 *
 * **A draft, and a part of a link still open in its creator's tray, is its
 * writer's alone**, a bot's included: a DRAFT has no other reader
 * (docs/ANNOTATIONS.md), so to anyone else it is not there.
 */
async function requireOwnNote(actor: Actor, ref: NoteRef): Promise<NoteRow & { slug: string }> {
  const row = await noteRow(ref);
  const file = row ? await prisma.storedFile.findUnique({ where: { id: row.fileId }, select: { id: true, slug: true, visibility: true, deletedByUserId: true } }) : null;
  const own = row?.authorId === actor.userId;
  if (!row || !file || file.deletedByUserId !== null || !(await canUserReadFile(actor.userId, actor.role, file)) || (row.unposted && !own)) {
    throw new ApiError("not_found", "That note doesn't exist.");
  }
  if (!own && row.worksFor !== actor.userId) throw forbidden(ONLY_ITS_AUTHOR);
  return { ...row, slug: file.slug };
}

// ---------------------------------------------------------------------------
// The move.

/** What a move of one note takes: where the decision was made from, and where the note goes. */
export type NoteMoveInput = NoteRef & {
  /** The version the note was on, and its target's digest there, when its mover decided: the write's own condition. */
  fromVersionId: string;
  fingerprint: string;
  /** The version the target was measured on: the latest when the decision was made, and not checked to be the latest still. */
  destinationVersionId: string;
  /** The target there, as a capture sends one: a suggestion handed back, or a selection. */
  target: unknown;
};

/**
 * Moves one note to a later version of its file, to the target given there.
 *
 * **`moved: false` is a note that was not as the decision found it**: moved
 * from another tab, or by a carry that got there first. Nothing is written,
 * and the caller shows a fresh suggestion.
 *
 * **The target is checked as a move is, not as a capture from the bare
 * address is**: the destination is a promoted version later than the one the
 * note is on, and need not still be the latest. A decision made against a
 * version that was the latest when it was made is written to that version,
 * where a refusal would discard the person's work; the note is then on an
 * earlier version again.
 *
 * **Its quote is derived here**, from the destination's page text at the
 * offsets sent, as a capture's is (`capturePdfTextAnchor`). A capture whose
 * words don't check keeps its quads and drops its quote; a move is refused
 * there, since the note has a quote now and nothing is lost by its staying.
 *
 * The move is shown, and takes the note's "stays here" mark off
 * (`writeAnchorMoves`, with no carry).
 */
export async function moveNote(actor: Actor, input: NoteMoveInput): Promise<{ slug: string; moved: boolean; toNumber: number }> {
  const ref = parseRef(input);
  if (typeof input.fromVersionId !== "string" || typeof input.fingerprint !== "string" || typeof input.destinationVersionId !== "string") {
    throw invalid("That isn't a move.");
  }
  const note = await requireOwnNote(actor, ref);
  if (note.gone) {
    throw new ApiError("conflict", ref.kind === "annotation" ? "A deleted note is moved once it is restored." : "A part of a deleted link is moved once the link is restored.");
  }
  const [destination, from] = await Promise.all([
    prisma.fileVersion.findFirst({
      where: { id: input.destinationVersionId, fileId: note.fileId },
      select: { id: true, number: true, pageCount: true, promotedAt: true, abandonedAt: true },
    }),
    prisma.fileVersion.findUnique({ where: { id: note.versionId }, select: { number: true } }),
  ]);
  if (!destination || !from) throw new ApiError("not_found", "That version doesn't exist.");
  // The write checks both again, under the lock and against the version it finds the note on. Asked
  // here first, so a move that could never be made is refused before its target is read.
  if (destination.promotedAt === null || destination.abandonedAt !== null) {
    throw new ApiError("conflict", "A note can be moved only to a version of this file that has been promoted.");
  }
  if (destination.number <= from.number) {
    throw new ApiError("conflict", `A note is moved forward only, and it is on version ${from.number}.`);
  }

  const sent = parsePdfTarget(input.target);
  const captured = sent ? await capturePdfTextAnchor({ fileVersionId: destination.id, rawTarget: sent }) : null;
  if (!sent || !captured || captured.target.pageIndex >= (destination.pageCount ?? 0)) {
    throw invalid("That selection couldn't be read. Select the passage again.");
  }
  if (!isWordless(sent) && captured.quotedText === "") {
    throw new ApiError("conflict", `That passage couldn't be checked against version ${destination.number}'s text. Reload the page, then select it again.`);
  }

  const moved = await prisma.$transaction(async (tx) => {
    const file = await lockFileRow(tx, note.fileId);
    if (!file || file.deleted) throw new ApiError("not_found", "File not found.");
    return writeAnchorMoves(tx, {
      fileId: note.fileId,
      destinationVersionId: destination.id,
      moves: [{ kind: ref.kind, id: ref.id, fromVersionId: input.fromVersionId, fingerprint: input.fingerprint, target: captured.target, quotedText: captured.quotedText }],
      movedByUserId: actor.userId,
      carryId: null,
    });
  }, MOVE_WRITE_TIMEOUTS);
  return { slug: note.slug, moved: moved.length > 0, toNumber: destination.number };
}

// ---------------------------------------------------------------------------
// "Stays here".

const anchorOf = (ref: NoteRef) => (ref.kind === "annotation" ? { annotationId: ref.id } : { anchoredLinkAnchorId: ref.id });

/** The version a note is on, read inside a transaction that holds its file row's lock: a move needs that lock, so it can't change beneath this. */
async function versionOfNote(tx: TransactionClient, ref: NoteRef): Promise<{ id: string; number: number } | null> {
  const row =
    ref.kind === "annotation"
      ? await tx.annotation.findUnique({ where: { id: ref.id }, select: { fileVersion: { select: { id: true, number: true } } } })
      : await tx.anchoredLinkAnchor.findUnique({ where: { id: ref.id }, select: { fileVersion: { select: { id: true, number: true } } } });
  return row?.fileVersion ?? null;
}

/**
 * Marks a note "stays here", or takes the mark off: its author's word that
 * it has been looked at and belongs on its version. A marked note is in no
 * worklist and no carry moves it.
 *
 * **Written with the file row locked, on the version the note is then on,
 * and refused where that is the latest**: a note on the latest has nothing
 * to stay behind from, and takes no mark in advance. A carry's write refuses
 * a marked row, so a mark made while a carry was working out its placements
 * holds.
 */
export async function setNoteStays(actor: Actor, rawRef: NoteRef, stays: boolean): Promise<{ slug: string; stays: boolean; versionNumber: number }> {
  const ref = parseRef(rawRef);
  const note = await requireOwnNote(actor, ref);
  const versionNumber = await prisma.$transaction(async (tx) => {
    const file = await lockFileRow(tx, note.fileId);
    const at = file && !file.deleted ? await versionOfNote(tx, ref) : null;
    if (!file || !at) throw new ApiError("not_found", "That note doesn't exist.");
    if (stays !== true) {
      await tx.fileAnchorMove.deleteMany({ where: { ...anchorOf(ref), toVersionId: null } });
      return at.number;
    }
    if (at.id === file.currentVersionId) {
      throw new ApiError("conflict", `This note is on version ${at.number}, the latest, where it has nothing to stay behind from.`);
    }
    const marked = await tx.fileAnchorMove.findFirst({ where: { ...anchorOf(ref), toVersionId: null }, select: { id: true } });
    if (!marked) {
      await tx.fileAnchorMove.create({
        data:
          ref.kind === "annotation"
            ? { annotationId: ref.id, fromVersionId: at.id, movedByUserId: actor.userId }
            : { anchoredLinkAnchorId: ref.id, fromVersionId: at.id, movedByUserId: actor.userId },
      });
    }
    return at.number;
  }, MOVE_WRITE_TIMEOUTS);
  return { slug: note.slug, stays: stays === true, versionNumber };
}

/**
 * Shows or hides one move of a note: its author's, for any move of their own
 * note, a carry's included. A shown move is on the note's card and on its
 * entry on the page of the version it left; a hidden one is in neither.
 */
export async function setNoteMoveHidden(actor: Actor, moveId: string, hidden: boolean): Promise<{ slug: string }> {
  if (typeof moveId !== "string" || !/^\d{1,18}$/.test(moveId)) throw invalid("That isn't a move.");
  const move = await prisma.fileAnchorMove.findUnique({
    where: { id: BigInt(moveId) },
    select: { id: true, annotationId: true, anchoredLinkAnchorId: true, toVersionId: true },
  });
  const anchorId = move?.annotationId ?? move?.anchoredLinkAnchorId;
  if (!move || move.toVersionId === null || !anchorId) throw new ApiError("not_found", "That move doesn't exist.");
  const note = await requireOwnNote(actor, { kind: move.annotationId ? "annotation" : "link-part", id: anchorId });
  await prisma.fileAnchorMove.update({ where: { id: move.id }, data: { hidden: hidden === true } });
  return { slug: note.slug };
}

// ---------------------------------------------------------------------------
// The worklist.

/** One note of a viewer's worklist. */
export type WorklistItem = NoteRef & {
  /** The version it is on and its target's digest there: what a move of it hands back as the write's condition. */
  versionId: string;
  versionNumber: number;
  fingerprint: string;
  /** A posted note, a draft, a part of a minted link, or a part of the link open in the tray. */
  what: "note" | "draft" | "part" | "open-part";
  quotedText: string;
  /** Its sheet on its own version, 0-based. */
  pageIndex: number;
  /** A note's own words, cut short, or the name of a part's link; "" for neither. */
  text: string;
  /** The bot that wrote it, where it is not the viewer's own. */
  by: string | null;
  /** The note where it is: its version's page, on its sheet. A posted note's card has its own link (`OtherVersionNote.href`). */
  href: string;
  /** A part's link. */
  linkId: string | null;
};

const TEXT_SHOWN = 160;

/**
 * "My notes on earlier versions": the viewer's notes and link parts, and
 * those of the bots that work for them, on any version of the file but the
 * latest, less the ones marked as staying.
 *
 * Drafts and the parts of the link open in the tray are in it, the viewer's
 * own alone. Replies are not, since each travels with its root, and neither
 * is a deleted note until it is restored. Oldest version first, and within
 * one by sheet.
 *
 * No gate of its own: it takes a file its caller has checked the viewer may
 * read, and answers only that viewer's rows.
 */
export async function worklistFor(viewerId: string, file: { id: string; slug: string; currentVersionId: string | null }): Promise<WorklistItem[]> {
  return (await ownNotesOn(viewerId, file)).map(({ item }) => item);
}

/** The worklist's notes, each with the whole target a suggestion is worked out from. */
async function ownNotesOn(
  viewerId: string,
  file: { id: string; slug: string; currentVersionId: string | null },
): Promise<{ item: WorklistItem; target: PdfTarget }[]> {
  if (!file.currentVersionId) return [];
  const mine = (author: Prisma.Sql) => Prisma.sql`(${author} = ${viewerId} OR u."works_for_user_id" = ${viewerId})`;
  const [versions, notes, parts] = await Promise.all([
    prisma.fileVersion.findMany({ where: { fileId: file.id }, select: { id: true, number: true } }),
    prisma.$queryRaw<NoteRow[]>(Prisma.sql`
      SELECT ${NOTE_COLUMNS} AND a."file_id" = ${file.id} AND a."file_version_id" <> ${file.currentVersionId} AND ${mine(Prisma.sql`a."user_id"`)}`),
    prisma.$queryRaw<NoteRow[]>(Prisma.sql`
      SELECT ${PART_COLUMNS} AND p."file_id" = ${file.id} AND p."file_version_id" <> ${file.currentVersionId} AND ${mine(Prisma.sql`l."created_by_id"`)}`),
  ]);
  const numberOf = new Map(versions.map((version) => [version.id, version.number]));
  const found = (kind: AnchorKind, rows: readonly NoteRow[]) =>
    rows.flatMap((row): { item: WorklistItem; target: PdfTarget }[] => {
      const target = parsePdfTarget(row.target);
      const number = numberOf.get(row.versionId);
      const own = row.authorId === viewerId;
      if (!target || number === undefined || row.marked || row.gone || (row.unposted && !own)) return [];
      const text = row.text.trim();
      const item: WorklistItem = {
        kind,
        id: row.id,
        versionId: row.versionId,
        versionNumber: number,
        fingerprint: row.fingerprint,
        what: kind === "annotation" ? (row.unposted ? "draft" : "note") : row.unposted ? "open-part" : "part",
        quotedText: row.quotedText,
        pageIndex: target.pageIndex,
        text: text.length > TEXT_SHOWN ? `${text.slice(0, TEXT_SHOWN).trimEnd()}…` : text,
        by: own ? null : displayNameOf({ name: row.authorName }),
        href: `${pdfPath(file.slug, { number, isLatest: false })}#${formatPageName({ sheet: target.pageIndex + 1, stamp: pageStampFor(number, versions.length) })}`,
        linkId: row.linkId,
      };
      return [{ item, target }];
    });
  return [...found("annotation", notes), ...found("link-part", parts)].sort(
    (a, b) => a.item.versionNumber - b.item.versionNumber || a.item.pageIndex - b.item.pageIndex || a.item.id.localeCompare(b.item.id),
  );
}

/** Where the placing rules would put one note on the latest version, or why they give it no place. */
export type NoteSuggestion =
  | {
      kind: "placed" | "proposal";
      /** The target on the latest, which accepting hands back as it is. */
      target: PdfTarget;
      quotedText: string;
      /** How it was found: on the matching sheet, once elsewhere in the version, with its words corrected, or by its sheet's ink. */
      how: QuoteFound | QuadsFound;
      /** Where its words were corrected: the share of the quote's letters that changed. */
      changed?: number;
    }
  | { kind: "none"; why: NoPlace };

export type OpenedWorklist = {
  /** The latest version, which every suggestion is on. */
  destination: { id: string; number: number };
  items: WorklistItem[];
  /** By `noteKey`. */
  suggestions: Record<string, NoteSuggestion>;
};

/**
 * A viewer's worklist on one file as it is when they open it, with where
 * each note would go on the latest version.
 *
 * **The placing rules run here, when it is asked for**, each note starting
 * from where it is now: the work reads sheets and takes seconds, and its
 * answer is true only of the latest as it then is. Their answer is a
 * suggestion whether they say the note places itself or has a proposal: one
 * note moved by a person is that person's judgement either way. Nothing is
 * stored.
 */
export async function openWorklist(actor: Actor, fileId: string): Promise<OpenedWorklist> {
  if (typeof fileId !== "string") throw invalid("That isn't a file.");
  const file = await prisma.storedFile.findUnique({
    where: { id: fileId },
    select: { id: true, slug: true, visibility: true, deletedByUserId: true, currentVersionId: true },
  });
  if (!file || file.deletedByUserId !== null || !(await canUserReadFile(actor.userId, actor.role, file))) throw new ApiError("not_found", "File not found.");
  const versions = await lineOf(file.id);
  const destination = versions.find((version) => version.id === file.currentVersionId);
  if (!destination) throw new ApiError("conflict", "This file has no latest version.");
  const notes = await ownNotesOn(actor.userId, file);
  const sources = versions.filter((version) => version.id !== destination.id && version.abandonedAt === null);
  const placements = await workOutPlacements(
    notes.map(({ item, target }) => ({ versionId: item.versionId, target })),
    sources,
    destination,
    mapsOfLine(versions),
  );
  const suggestions: Record<string, NoteSuggestion> = {};
  notes.forEach(({ item }, index) => {
    suggestions[noteKey(item)] = placements[index];
  });
  return { destination: { id: destination.id, number: destination.number }, items: notes.map(({ item }) => item), suggestions };
}

// ---------------------------------------------------------------------------
// What a card and an entry say of a note's moves.

/** One move of a note, as its card or its entry says it. */
export type NoteMoveShown = {
  id: string;
  fromNumber: number;
  toNumber: number;
  /** Who moved it, where that is not its author; null for its author, and for a mover whose account is gone. */
  by: string | null;
  hidden: boolean;
};

/** Where a note stands among its file's versions, for the viewer asking. */
export type NoteStanding = {
  /** Whether the viewer may move it, mark it and show or hide its moves: its author, or the person its author works for. */
  mine: boolean;
  /** Whether it is marked "stays here". Told to whoever may take the mark off, and to nobody else. */
  stays: boolean;
  /** Its moves, oldest first: the shown ones, and for whoever may show them the hidden ones too. */
  moves: NoteMoveShown[];
};

/**
 * Where each of these notes stands, for one viewer: its shown moves, and for
 * its author its hidden ones and its mark. **A hidden move is withheld from
 * every other reader here**, on the server: that a note was moved is the
 * thing a hidden move doesn't say.
 */
export async function noteStandings(viewerId: string, notes: readonly { id: string; authorId: string | null }[]): Promise<Map<string, NoteStanding>> {
  const standings = new Map<string, NoteStanding>();
  if (notes.length === 0) return standings;
  const [bots, rows] = await Promise.all([
    prisma.user.findMany({ where: { worksForUserId: viewerId }, select: { id: true } }),
    prisma.fileAnchorMove.findMany({
      where: { annotationId: { in: notes.map((note) => note.id) } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        annotationId: true,
        toVersionId: true,
        hidden: true,
        movedByUserId: true,
        movedBy: { select: { name: true } },
        fromVersion: { select: { number: true } },
        toVersion: { select: { number: true } },
      },
    }),
  ]);
  const mineIds = new Set([viewerId, ...bots.map((bot) => bot.id)]);
  for (const note of notes) {
    const mine = note.authorId !== null && mineIds.has(note.authorId);
    const own = rows.filter((row) => row.annotationId === note.id);
    standings.set(note.id, {
      mine,
      stays: mine && own.some((row) => row.toVersionId === null),
      moves: own.flatMap((row): NoteMoveShown[] => {
        if (!row.toVersion || (row.hidden && !mine)) return [];
        const by = row.movedByUserId !== null && row.movedByUserId !== note.authorId && row.movedBy ? displayNameOf(row.movedBy) : null;
        return [{ id: row.id.toString(), fromNumber: row.fromVersion.number, toNumber: row.toVersion.number, by, hidden: row.hidden }];
      }),
    });
  }
  return standings;
}
