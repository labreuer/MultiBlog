import type { JSONContent } from "@tiptap/core";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { annotationContentExtensions } from "./tiptap-schema";
import { CITATION, referentKind } from "./entity-chips/kinds/citation";
import { chipsInJSON } from "./entity-chips/renderings";
import { linkHrefsIn } from "./pdf-fragment-findings";
import { prisma } from "./prisma";
import { ydocIdForAnnotation, ydocIdForDoc } from "./ydoc-names";
import { readYdocContent } from "./ydoc-render";
import { materializeYdocAt } from "./ydoc-snapshot";

// docs/PDF.md §13, "Links into the file" — dating a link against a moment in
// a file's history: whether the body that holds it held it before a mark,
// which the integrity check asks of a link without `v=` once its file has a
// second version. A link written before that version existed means the first
// version, as it always did; one written after it can only have been typed
// by hand, and its writer most likely meant the latest.
//
// **The clock is `ydoc_update.id`**, one sequence across every doc and every
// annotation body, an id never given twice. A version's row holds the highest
// id at its upload (`uploaded_at_update_id`), so:
//
// - a body whose last update is at or below the mark was written wholly
//   before it, and one whose first is above it wholly after: neither needs a
//   replay;
// - a body edited on both sides is replayed once to the mark, for the hrefs
//   it held then;
// - a post holds the hrefs its doc held at the snapshot it was published
//   from, so one published at or before the mark is wholly before it, and
//   for one published after it the doc is replayed to the mark;
// - a comment has no update log: its link is dated by the earliest of its
//   revisions that holds the href, against the time the version was uploaded,
//   and so is a post whose publication has lost its snapshot.
//
// An update whose transaction was open when a mark was read can carry an id
// below the mark and commit after it. The check only warns, so that is
// accepted.
//
// Server-only, and it reads as the operator, as the check it serves does.

/** A moment in a file's history: the highest `ydoc_update.id` then, and the time. */
export type LinkMark = { updateId: bigint; at: Date };

/** What holds a link: a body with a history of its own. */
export type LinkHolder = { kind: "doc" | "annotation" | "post" | "comment"; id: string };

/**
 * Every address a body holds that may point into a PDF: its link marks'
 * hrefs, and its citations' `/pdf/` referents, which are links into the
 * work's file (docs/CITATIONS.md, "A passage in a citation").
 */
export function pdfHrefsIn(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const referents = chipsInJSON(json as JSONContent).flatMap((chip) => {
    const referent = chip.data.referent;
    return chip.kind === CITATION && typeof referent === "string" && referentKind(referent) === "pdf" ? [referent] : [];
  });
  return [...linkHrefsIn(json), ...referents];
}

/**
 * Answers, for one run, whether a body held an href before a mark. Each
 * body's log bounds are read once, and each body is replayed at most once
 * per mark.
 */
export class LinkDater {
  private bounds = new Map<string, Promise<{ min: bigint; max: bigint } | null>>();
  private held = new Map<string, Promise<Set<string> | null>>();

  /**
   * Whether `href` was written into `holder` after `mark`: true only where
   * that can be shown. A body that can't be dated (no log, a replay that
   * fails) answers false, so the check stays quiet rather than guess.
   */
  async writtenAfter(holder: LinkHolder, href: string, mark: LinkMark): Promise<boolean> {
    switch (holder.kind) {
      case "doc":
        return this.ydocWroteAfter(ydocIdForDoc(holder.id), "doc", href, mark);
      case "annotation":
        return this.ydocWroteAfter(ydocIdForAnnotation(holder.id), "annotation", href, mark);
      case "post":
        return this.postWroteAfter(holder.id, href, mark);
      case "comment":
        return this.commentWroteAfter(holder.id, href, mark);
    }
  }

  private boundsOf(ydocId: string): Promise<{ min: bigint; max: bigint } | null> {
    let pending = this.bounds.get(ydocId);
    if (!pending) {
      pending = prisma.ydocUpdate
        .aggregate({ where: { ydocId }, _min: { id: true }, _max: { id: true } })
        .then(({ _min, _max }) => (_min.id === null || _max.id === null ? null : { min: _min.id, max: _max.id }));
      this.bounds.set(ydocId, pending);
    }
    return pending;
  }

  /** The hrefs a body held at the mark, or null where it can't be replayed. */
  private heldAt(ydocId: string, schema: "doc" | "annotation", mark: LinkMark): Promise<Set<string> | null> {
    const key = `${ydocId}@${mark.updateId}`;
    let pending = this.held.get(key);
    if (!pending) {
      pending = (async () => {
        let doc;
        try {
          doc = await materializeYdocAt(ydocId, mark.updateId);
        } catch (error) {
          console.error(`[pdf-link-dating] couldn't replay ${ydocId} to ${mark.updateId}:`, error);
          return null;
        }
        try {
          if (schema === "annotation") {
            return new Set(pdfHrefsIn(TiptapTransformer.extensions(annotationContentExtensions).fromYdoc(doc, "default")));
          }
          const content = readYdocContent(doc);
          return content.ok ? new Set(pdfHrefsIn(content.bodyJSON)) : null;
        } catch (error) {
          console.error(`[pdf-link-dating] ${ydocId} at ${mark.updateId} doesn't decode:`, error);
          return null;
        } finally {
          doc.destroy();
        }
      })();
      this.held.set(key, pending);
    }
    return pending;
  }

  private async ydocWroteAfter(ydocId: string, schema: "doc" | "annotation", href: string, mark: LinkMark): Promise<boolean> {
    const bounds = await this.boundsOf(ydocId);
    if (!bounds || bounds.max <= mark.updateId) return false;
    if (bounds.min > mark.updateId) return true;
    const held = await this.heldAt(ydocId, schema, mark);
    return held !== null && !held.has(href);
  }

  private async postWroteAfter(postId: string, href: string, mark: LinkMark): Promise<boolean> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { publishEvent: { select: { docId: true, createdAt: true, ydocSnapshot: { select: { lastYdocUpdateId: true } } } } },
    });
    const event = post?.publishEvent;
    if (!event) return false;
    // An event that has lost its snapshot, or its doc, is dated by its time, as a comment is.
    if (!event.ydocSnapshot || !event.docId) return event.createdAt.getTime() > mark.at.getTime();
    if (event.ydocSnapshot.lastYdocUpdateId <= mark.updateId) return false;
    const ydocId = ydocIdForDoc(event.docId);
    const bounds = await this.boundsOf(ydocId);
    // The doc had nothing by the mark, so the post's every link is later.
    if (!bounds || bounds.min > mark.updateId) return true;
    const held = await this.heldAt(ydocId, "doc", mark);
    return held !== null && !held.has(href);
  }

  private async commentWroteAfter(commentId: string, href: string, mark: LinkMark): Promise<boolean> {
    const revisions = await prisma.commentRevision.findMany({
      where: { commentId },
      orderBy: { revisionNo: "asc" },
      select: { body: true, createdAt: true },
    });
    const first = revisions.find((revision) => pdfHrefsIn(revision.body).includes(href));
    return first !== undefined && first.createdAt.getTime() > mark.at.getTime();
  }
}
