import type { JSONContent } from "@tiptap/core";
import { Prisma } from "@/generated/prisma/client";
import { annotationBodyText } from "@/lib/annotation-body";
import { commentBodyTextFromJSON, commentChipLabels } from "@/lib/comment-body";
import { prismaIncludingDeleted as prisma } from "@/lib/prisma";
import { parseChipRecords, relabelChipRecords, type ChipRecord } from "@/lib/anchors";
import { chipInputsForBody, loadChipContext } from "./context";
import { CITATION } from "./kinds/citation";
import { MENTION } from "./kinds/mention";
import { relabelChips } from "./materialize";
import { chipKind } from "./registry";
import { chipRenderings, chipsInJSON } from "./renderings";
import { parseChipStyles } from "./settings";
import { chipLabels, type ChipLabels } from "./text";
import { DEFAULT_CHIP_STYLES } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 10 — the refresh. A label is computed
// from its target's record, and three places hold a computed label as text:
// a doc's `prose_json` (item 8), a note's `body_text` (item 13), and the chip
// record of an anchor whose passage holds the chip (item 11). An edit
// rewrites the first two through the ordinary store. A rename is not an
// edit, so nothing would rewrite them, and a doc nobody opens would be
// found, and excerpted, under the old name for good.
//
// So whatever changes a record a label reads calls this with the target's
// id. It finds the docs and notes through the kind's index table and
// recomputes their labels:
//
//  - **A doc** is relabelled from `prose_json`'s own chips. No ydoc is
//    decoded. Only `prose_json` is written, in raw SQL, so `updated_at` and
//    the last editor don't move: a rename must not make hundreds of docs look
//    freshly edited. The search vector follows through its trigger.
//  - **A note** gets `body_text` recomputed from its `prose_json`, which is
//    label-free. No date moves either: a note's "updated" date is the edit
//    its card tells readers about (docs/FULLTEXT.md §6).
//  - **A comment** gets `body_text` recomputed from its `body`, in the
//    comment style, the same way and for the same reason: neither `edited_at`
//    nor any revision moves (docs/ENTITY_CHIPS.md, "Planned: chips in
//    comments"). Its page shows the new label at its next regeneration.
//  - **An anchor into either** (a note's stored quote, a link's or a tag's
//    part) gets its chip records' labels from the body they point into, by
//    instance id, so a quote shown with no ydoc open reads as that body now
//    does. The annotation search vector follows through its trigger.
//  - **A record whose chip that body no longer holds** has no label there to
//    take, and its doc may not be in the index at all. It is found by what
//    its fields name, and relabelled alone (`refreshOrphanRecords`).
//  - **A post** is left alone. It froze its labels at publish, and
//    republishing is what refreshes them.
//
// Each write is a compare-and-set on the text it read. A store that got
// there first wrote fresh labels of its own and is never overwritten, and a
// row that changed meanwhile is simply skipped: its writer relabelled it.
// The value compared is the content, not `prose_json_update_id`, because a
// store with no update id to give (a shutdown drain) leaves that id where it
// was while changing the body.
//
// One window stays open: a store that loaded its chip context just before
// the rename and writes just after this pass puts the old label back. The
// second pass below, a little later than the store debounce's ceiling,
// closes it for a server that is still up; `check-doc-integrity.ts`'s
// `chip-labels` finding, `check-annotation-snapshots.ts`'s `settled-cache`
// and `check-annotation-anchors.ts`'s `record-labels` report whatever is
// left, and the next store of that doc repairs it.
//
// Server-only.

/** Hocuspocus's store debounce waits ten seconds at most (docs/DOCS.md); this is past it. */
const SECOND_PASS_MS = 15_000;

export type RefreshResult = { docs: number; annotations: number; comments: number; anchors: number };

/** An index table's row, as the refresh reads it: the source and the chip. */
type IndexRow = { docId: string | null; annotationId: string | null; commentId: string | null; iid: string };

/**
 * Relabels every doc and note that mentions one of `userIds`, or one of
 * their bots: a bot's label can name the person it works for.
 */
export async function refreshMentionLabels(userIds: readonly string[]): Promise<RefreshResult> {
  if (userIds.length === 0) return { docs: 0, annotations: 0, comments: 0, anchors: 0 };
  const bots = await prisma.user.findMany({ where: { worksForUserId: { in: [...userIds] } }, select: { id: true } });
  const targets = [...new Set([...userIds, ...bots.map((bot) => bot.id)])];

  const rows = await prisma.mention.findMany({
    where: { userId: { in: targets }, postId: null },
    select: { docId: true, annotationId: true, commentId: true, iid: true },
  });
  const result = await refreshSources(rows);
  return { ...result, anchors: result.anchors + (await refreshOrphanRecords(MENTION, targets, rows)) };
}

/**
 * Relabels every doc and note that cites one of `refIds`: a reference's
 * record or abbreviation changed (docs/CITATIONS.md, "Refresh"). Found
 * through the `citation` table, as a mention's are through `mention`.
 */
export async function refreshCitationLabels(refIds: readonly string[]): Promise<RefreshResult> {
  if (refIds.length === 0) return { docs: 0, annotations: 0, comments: 0, anchors: 0 };
  const rows = await prisma.citation.findMany({
    where: { referenceId: { in: [...refIds] }, postId: null },
    select: { docId: true, annotationId: true, commentId: true, iid: true },
  });
  const result = await refreshSources(rows);
  return { ...result, anchors: result.anchors + (await refreshOrphanRecords(CITATION, refIds, rows)) };
}

/** The refresh proper, over the docs, notes and comments an index table named. */
async function refreshSources(rows: readonly IndexRow[]): Promise<RefreshResult> {
  const docIds = [...new Set(rows.flatMap((row) => (row.docId ? [row.docId] : [])))];
  const annotationIds = [...new Set(rows.flatMap((row) => (row.annotationId ? [row.annotationId] : [])))];
  const commentIds = [...new Set(rows.flatMap((row) => (row.commentId ? [row.commentId] : [])))];

  // One at a time: a prolific person's rename is hundreds of documents, and
  // nothing is waiting on any one of them.
  let docs = 0;
  let annotations = 0;
  let comments = 0;
  let anchors = 0;
  for (const id of docIds) {
    if (await refreshDoc(id)) docs += 1;
    anchors += await refreshAnchorsInto({ kind: "doc", id });
  }
  for (const id of annotationIds) {
    if (await refreshAnnotation(id)) annotations += 1;
    anchors += await refreshAnchorsInto({ kind: "annotation", id });
  }
  for (const id of commentIds) {
    if (await refreshComment(id)) comments += 1;
    anchors += await refreshAnchorsInto({ kind: "comment", id });
  }
  return { docs, annotations, comments, anchors };
}

async function refreshDoc(docId: string): Promise<boolean> {
  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { proseJson: true, chipStyles: true } });
  if (!doc?.proseJson) return false;
  const before = doc.proseJson as JSONContent;
  const after = relabelChips(before, await chipInputsForBody(before, parseChipStyles(doc.chipStyles)));
  const [was, now] = [JSON.stringify(before), JSON.stringify(after)];
  if (was === now) return false;
  const written = await prisma.$executeRaw(
    Prisma.sql`UPDATE "doc" SET prose_json = ${now}::jsonb WHERE id = ${docId} AND prose_json = ${was}::jsonb`,
  );
  return written > 0;
}

async function refreshAnnotation(annotationId: string): Promise<boolean> {
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { proseJson: true, bodyText: true },
  });
  if (!annotation?.proseJson) return false;
  const bodyText = await annotationBodyText(annotation.proseJson as JSONContent);
  if (bodyText === annotation.bodyText) return false;
  const written = await prisma.$executeRaw(
    Prisma.sql`UPDATE "annotation" SET body_text = ${bodyText} WHERE id = ${annotationId} AND body_text = ${annotation.bodyText}`,
  );
  return written > 0;
}

async function refreshComment(commentId: string): Promise<boolean> {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { body: true, bodyText: true } });
  if (!comment?.body) return false;
  const body = comment.body as JSONContent;
  const bodyText = commentBodyTextFromJSON(body, commentChipLabels(body, (await chipInputsForBody(body)).context));
  if (bodyText === comment.bodyText) return false;
  const written = await prisma.$executeRaw(
    Prisma.sql`UPDATE "comment" SET body_text = ${bodyText} WHERE id = ${commentId} AND body_text = ${comment.bodyText}`,
  );
  return written > 0;
}

/** The three anchor tables that keep a chip record inside their `selector` (src/lib/anchors/selector.ts). */
const SELECTOR_TABLES = ["tag_anchor", "anchored_link_anchor", "comment_quote_anchor"] as const;

/** The chip records of every anchor into one body, a doc's, a note's or a comment's, relabelled as that body reads now. */
async function refreshAnchorsInto(target: AnchoredBody): Promise<number> {
  if (target.kind === "comment") {
    const comment = await prisma.comment.findUnique({ where: { id: target.id }, select: { body: true } });
    const json = comment?.body as JSONContent | null | undefined;
    if (!json || chipsInJSON(json).length === 0) return 0;
    return refreshAnchorRecords(target, commentChipLabels(json, (await chipInputsForBody(json)).context));
  }
  // A doc's labels are in its own style; a note's body has none of its own.
  const body =
    target.kind === "doc"
      ? await prisma.doc.findUnique({ where: { id: target.id }, select: { proseJson: true, chipStyles: true } })
      : { ...(await prisma.annotation.findUnique({ where: { id: target.id }, select: { proseJson: true } })), chipStyles: null };
  if (!body?.proseJson) return 0;
  const json = body.proseJson as JSONContent;
  if (chipsInJSON(json).length === 0) return 0;
  return refreshAnchorRecords(target, chipLabels(json, await chipInputsForBody(json, parseChipStyles(body.chipStyles))));
}

/** A body that anchors point into and whose chips can be relabelled. */
type AnchoredBody = { kind: "doc" | "annotation" | "comment"; id: string };

/**
 * Rewrites the chip records of every anchor into one body with `labels`,
 * that body's own by instance id. So a record reads as the doc-order pass
 * labelled its chip there, with whatever told two same-named people apart.
 * A record whose chip the body no longer holds keeps the label it had.
 *
 * The doc store calls this too (server/doc-cache.ts), with the labels it has
 * just written to `prose_json`, and so does a note's settle
 * (`refreshAnchorsIntoNote`): an edit can change a label it never touched,
 * by adding a second person of the same name, and the records follow the
 * body.
 */
export async function refreshAnchorRecords(target: AnchoredBody, labels: ChipLabels): Promise<number> {
  if (labels.size === 0) return 0;
  let written = 0;

  // Notes: a root's quote of the doc, or a reply's quote of the note it
  // answers. No note is on a comment.
  const notes =
    target.kind === "comment"
      ? []
      : await prisma.annotation.findMany({
          where: {
            ...(target.kind === "doc" ? { docId: target.id, parentAnnotationId: null } : { parentAnnotationId: target.id }),
            anchorChips: { not: Prisma.DbNull },
          },
          select: { id: true, anchorChips: true },
        });
  for (const note of notes) {
    written += await writeRecords({ table: "annotation", id: note.id, stored: note.anchorChips }, (was) => relabelChipRecords(was, labels));
  }

  const column = Prisma.raw(target.kind === "doc" ? "doc_id" : target.kind === "annotation" ? "target_annotation_id" : "target_comment_id");
  for (const table of SELECTOR_TABLES) {
    const rows = await prisma.$queryRaw<{ id: string; selector: unknown }[]>(
      Prisma.sql`SELECT id, selector FROM ${Prisma.raw(`"${table}"`)} WHERE ${column} = ${target.id} AND selector_kind = 'DOC_RANGE' AND selector ? 'chips'`,
    );
    for (const row of rows) {
      written += await writeRecords({ table, id: row.id, stored: row.selector }, (was) => relabelChipRecords(was, labels));
    }
  }
  return written;
}

/**
 * The chip records of every anchor into a note's body, relabelled as that
 * body was just settled: its replies' quotes, and any tag, link or comment
 * quote on it. A note's body is settled, never stored, as the version its
 * readers see (src/lib/annotation-settle.ts), so this is the note's
 * counterpart of the doc store's call. A body with no chip costs nothing.
 */
export async function refreshAnchorsIntoNote(annotationId: string, body: JSONContent): Promise<number> {
  if (chipsInJSON(body).length === 0) return 0;
  // A note's body has no style of its own.
  return refreshAnchorRecords({ kind: "annotation", id: annotationId }, chipLabels(body, await chipInputsForBody(body)));
}

/** One anchor row's chip records as stored: `anchor_chips` itself on a note, the whole `selector` elsewhere. */
type StoredRecords = { table: "annotation" | (typeof SELECTOR_TABLES)[number]; id: string; stored: unknown };

/** The records inside a stored value. */
function recordsOf(row: StoredRecords): ChipRecord[] {
  return parseChipRecords(row.table === "annotation" ? row.stored : (row.stored as Record<string, unknown> | null)?.chips);
}

/**
 * Writes one row's records as `relabel` makes them, if that changes them and
 * the row still holds what was read. Answers how many rows it wrote.
 */
async function writeRecords(row: StoredRecords, relabel: (was: ChipRecord[]) => ChipRecord[]): Promise<number> {
  const was = recordsOf(row);
  if (was.length === 0) return 0;
  const now = relabel(was);
  if (JSON.stringify(was) === JSON.stringify(now)) return 0;
  if (row.table === "annotation") {
    return prisma.$executeRaw(
      Prisma.sql`UPDATE "annotation" SET anchor_chips = ${JSON.stringify(now)}::jsonb WHERE id = ${row.id} AND anchor_chips = ${JSON.stringify(row.stored)}::jsonb`,
    );
  }
  const selector = row.stored as Record<string, unknown>;
  return prisma.$executeRaw(
    Prisma.sql`UPDATE ${Prisma.raw(`"${row.table}"`)} SET selector = ${JSON.stringify({ ...selector, chips: now })}::jsonb WHERE id = ${row.id} AND selector = ${JSON.stringify(selector)}::jsonb`,
  );
}

/**
 * Relabels the chip records that name one of `targetIds` and whose chip is
 * gone from the body their anchor points into: the mention was deleted, or
 * its passage rewritten, and the note on it stayed.
 *
 * No body has a label for such a record, so the pass above leaves it, and a
 * doc that no longer names the target is not in the index to be visited at
 * all. Without this a detached note would show a person's old name for good.
 * The record's own fields say what it names, which is how it is found (the
 * chip kind's `naming`, by jsonb containment) and what its label is computed
 * from.
 *
 * It is labelled alone, in its chip kind's default style. A number, or the
 * extra that tells two same-named people apart, comes from a doc-order pass
 * over a body, and this chip is in none. A record whose target no longer
 * exists keeps the label it had.
 *
 * `held` is the index's rows for the same targets: a record whose instance
 * its body still holds is not an orphan, and has its label from the body.
 *
 * No index serves the containment, so each call reads every anchor row that
 * has records. A change to a name or a reference is rare, and nothing waits
 * on this.
 */
export async function refreshOrphanRecords(kindName: string, targetIds: readonly string[], held: readonly IndexRow[]): Promise<number> {
  const kind = chipKind(kindName);
  if (!kind || targetIds.length === 0) return 0;
  const patterns = targetIds.map((id) => JSON.stringify([{ kind: kindName, data: kind.naming(id) }]));
  const bodyKey = (docId: string | null, annotationId: string | null, commentId: string | null = null) =>
    commentId ? `comment:${commentId}` : annotationId ? `annotation:${annotationId}` : `doc:${docId}`;
  const inBody = new Set(held.map((row) => `${bodyKey(row.docId, row.annotationId, row.commentId)}:${row.iid}`));

  // Each row with the body its anchor points into: a reply's is the note it answers.
  const rows: (StoredRecords & { body: string })[] = [];
  const notes = await prisma.$queryRaw<{ id: string; doc_id: string | null; parent_annotation_id: string | null; anchor_chips: unknown }[]>(
    Prisma.sql`SELECT id, doc_id, parent_annotation_id, anchor_chips FROM "annotation" WHERE anchor_chips IS NOT NULL AND anchor_chips @> ANY (${patterns}::jsonb[])`,
  );
  for (const note of notes) {
    rows.push({ table: "annotation", id: note.id, stored: note.anchor_chips, body: bodyKey(note.doc_id, note.parent_annotation_id) });
  }
  for (const table of SELECTOR_TABLES) {
    const parts = await prisma.$queryRaw<
      { id: string; doc_id: string | null; target_annotation_id: string | null; target_comment_id: string | null; selector: unknown }[]
    >(
      Prisma.sql`SELECT id, doc_id, target_annotation_id, target_comment_id, selector FROM ${Prisma.raw(`"${table}"`)} WHERE selector_kind = 'DOC_RANGE' AND selector -> 'chips' @> ANY (${patterns}::jsonb[])`,
    );
    for (const part of parts) {
      rows.push({ table, id: part.id, stored: part.selector, body: bodyKey(part.doc_id, part.target_annotation_id, part.target_comment_id) });
    }
  }
  if (rows.length === 0) return 0;

  const wanted = new Set(targetIds);
  const isOrphan = (record: ChipRecord, body: string) => {
    if (record.kind !== kindName || inBody.has(`${body}:${record.iid}`)) return false;
    const data = kind.validate(record.data);
    return data !== null && kind.targets(data).some((id) => wanted.has(id));
  };
  const orphans = rows.flatMap((row) => recordsOf(row).filter((record) => isOrphan(record, row.body)));
  if (orphans.length === 0) return 0;
  const context = await loadChipContext(orphans.map((record) => ({ ...record, pos: 0 })));
  const labelOf = (record: ChipRecord): string | undefined => {
    const [rendering] = chipRenderings([{ kind: record.kind, iid: record.iid, data: record.data, pos: 0 }], DEFAULT_CHIP_STYLES, context);
    return rendering.status === "unknown" ? undefined : rendering.label;
  };

  let written = 0;
  for (const row of rows) {
    written += await writeRecords(row, (was) =>
      was.map((record) => {
        const label = isOrphan(record, row.body) ? labelOf(record) : undefined;
        return label === undefined ? record : { ...record, label };
      }),
    );
  }
  return written;
}

/**
 * Starts a refresh for `userIds` and returns at once: the write that changed
 * the record has committed, and its caller is not kept waiting on a fan-out.
 * A second pass follows (above). A failure is logged and dropped; the
 * integrity checks report what a lost refresh leaves.
 *
 * Call it after the change commits, never inside its transaction, or the
 * refresh reads the record as it was.
 */
export function scheduleMentionRefresh(userIds: readonly string[]): void {
  schedule([...userIds], refreshMentionLabels);
}

/** The same for references whose record or abbreviation changed: every doc and note citing one is relabelled. */
export function scheduleCitationRefresh(refIds: readonly string[]): void {
  schedule([...refIds], refreshCitationLabels);
}

function schedule(ids: string[], refresh: (ids: readonly string[]) => Promise<RefreshResult>): void {
  const run = (pass: string) =>
    refresh(ids).catch((err) => {
      console.error(`[entity-chips] the ${pass} label refresh for ${ids.join(", ")} failed:`, err);
    });
  void run("first");
  setTimeout(() => void run("second"), SECOND_PASS_MS).unref();
}
