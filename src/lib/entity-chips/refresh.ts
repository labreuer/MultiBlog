import type { JSONContent } from "@tiptap/core";
import { Prisma } from "@/generated/prisma/client";
import { annotationBodyText } from "@/lib/annotation-body";
import { prismaIncludingDeleted as prisma } from "@/lib/prisma";
import { parseChipRecords, relabelChipRecords } from "@/lib/anchors";
import { chipInputsForBody } from "./context";
import { relabelChips } from "./materialize";
import { chipsInJSON } from "./renderings";
import { chipLabels, type ChipLabels } from "./text";

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
//  - **An anchor into either** (a note's stored quote, a link's or a tag's
//    part) gets its chip records' labels from the body they point into, by
//    instance id, so a quote shown with no ydoc open reads as that body now
//    does. The annotation search vector follows through its trigger.
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
// `chip-labels` finding and `check-annotation-snapshots.ts`'s
// `settled-cache` report whatever is left, and the next store of that doc
// repairs it.
//
// Server-only.

/** Hocuspocus's store debounce waits ten seconds at most (docs/DOCS.md); this is past it. */
const SECOND_PASS_MS = 15_000;

export type RefreshResult = { docs: number; annotations: number; anchors: number };

/**
 * Relabels every doc and note that mentions one of `userIds`, or one of
 * their bots: a bot's label can name the person it works for.
 */
export async function refreshMentionLabels(userIds: readonly string[]): Promise<RefreshResult> {
  if (userIds.length === 0) return { docs: 0, annotations: 0, anchors: 0 };
  const bots = await prisma.user.findMany({ where: { worksForUserId: { in: [...userIds] } }, select: { id: true } });
  const targets = [...new Set([...userIds, ...bots.map((bot) => bot.id)])];

  const rows = await prisma.mention.findMany({
    where: { userId: { in: targets }, postId: null },
    select: { docId: true, annotationId: true },
  });
  const docIds = [...new Set(rows.flatMap((row) => (row.docId ? [row.docId] : [])))];
  const annotationIds = [...new Set(rows.flatMap((row) => (row.annotationId ? [row.annotationId] : [])))];

  // One at a time: a prolific person's rename is hundreds of documents, and
  // nothing is waiting on any one of them.
  let docs = 0;
  let annotations = 0;
  let anchors = 0;
  for (const id of docIds) {
    if (await refreshDoc(id)) docs += 1;
    anchors += await refreshAnchorsInto({ kind: "doc", id });
  }
  for (const id of annotationIds) {
    if (await refreshAnnotation(id)) annotations += 1;
    anchors += await refreshAnchorsInto({ kind: "annotation", id });
  }
  return { docs, annotations, anchors };
}

async function refreshDoc(docId: string): Promise<boolean> {
  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { proseJson: true } });
  if (!doc?.proseJson) return false;
  const before = doc.proseJson as JSONContent;
  const after = relabelChips(before, await chipInputsForBody(before));
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

/** The three anchor tables that keep a chip record inside their `selector` (src/lib/anchors/selector.ts). */
const SELECTOR_TABLES = ["tag_anchor", "anchored_link_anchor", "comment_quote_anchor"] as const;

/** The chip records of every anchor into one body, a doc's or a note's, relabelled as that body reads now. */
async function refreshAnchorsInto(target: { kind: "doc" | "annotation"; id: string }): Promise<number> {
  const body =
    target.kind === "doc"
      ? await prisma.doc.findUnique({ where: { id: target.id }, select: { proseJson: true } })
      : await prisma.annotation.findUnique({ where: { id: target.id }, select: { proseJson: true } });
  if (!body?.proseJson) return 0;
  const json = body.proseJson as JSONContent;
  if (chipsInJSON(json).length === 0) return 0;
  return refreshAnchorRecords(target, chipLabels(json, await chipInputsForBody(json)));
}

/**
 * Rewrites the chip records of every anchor into one body with `labels`,
 * that body's own by instance id. So a record reads as the doc-order pass
 * labelled its chip there, with whatever told two same-named people apart.
 * A record whose chip the body no longer holds keeps the label it had.
 *
 * The doc store calls this too (server/doc-cache.ts), with the labels it has
 * just written to `prose_json`: an edit can change a label it never touched,
 * by adding a second person of the same name, and the records follow the
 * column.
 */
export async function refreshAnchorRecords(target: { kind: "doc" | "annotation"; id: string }, labels: ChipLabels): Promise<number> {
  if (labels.size === 0) return 0;
  let written = 0;

  // Notes: a root's quote of the doc, or a reply's quote of the note it answers.
  const notes = await prisma.annotation.findMany({
    where: {
      ...(target.kind === "doc" ? { docId: target.id, parentAnnotationId: null } : { parentAnnotationId: target.id }),
      anchorChips: { not: Prisma.DbNull },
    },
    select: { id: true, anchorChips: true },
  });
  for (const note of notes) {
    const was = parseChipRecords(note.anchorChips);
    const now = relabelChipRecords(was, labels);
    if (was.length === 0 || JSON.stringify(was) === JSON.stringify(now)) continue;
    written += await prisma.$executeRaw(
      Prisma.sql`UPDATE "annotation" SET anchor_chips = ${JSON.stringify(now)}::jsonb WHERE id = ${note.id} AND anchor_chips = ${JSON.stringify(note.anchorChips)}::jsonb`,
    );
  }

  const column = Prisma.raw(target.kind === "doc" ? "doc_id" : "target_annotation_id");
  for (const name of SELECTOR_TABLES) {
    const table = Prisma.raw(`"${name}"`);
    const rows = await prisma.$queryRaw<{ id: string; selector: unknown }[]>(
      Prisma.sql`SELECT id, selector FROM ${table} WHERE ${column} = ${target.id} AND selector_kind = 'DOC_RANGE' AND selector ? 'chips'`,
    );
    for (const row of rows) {
      const selector = row.selector as Record<string, unknown>;
      const was = parseChipRecords(selector.chips);
      const now = relabelChipRecords(was, labels);
      if (was.length === 0 || JSON.stringify(was) === JSON.stringify(now)) continue;
      written += await prisma.$executeRaw(
        Prisma.sql`UPDATE ${table} SET selector = ${JSON.stringify({ ...selector, chips: now })}::jsonb WHERE id = ${row.id} AND selector = ${JSON.stringify(selector)}::jsonb`,
      );
    }
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
  const ids = [...userIds];
  const run = (pass: string) =>
    refreshMentionLabels(ids).catch((err) => {
      console.error(`[entity-chips] the ${pass} label refresh for ${ids.join(", ")} failed:`, err);
    });
  void run("first");
  setTimeout(() => void run("second"), SECOND_PASS_MS).unref();
}
