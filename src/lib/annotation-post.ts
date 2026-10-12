import type { JSONContent } from "@tiptap/core";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { viewerOf } from "@/lib/actor";
import { seedAnnotationYdocFromJson } from "@/lib/annotation-ydoc-seed";
import { MAX_BODY_LENGTH, settleAnnotationBody, writeSettledBody } from "@/lib/annotation-settle";
import { extractText } from "@/lib/diff";
import type { PdfTarget } from "@/lib/pdf-anchor";
import { ydocIdForAnnotation } from "@/lib/ydoc-names";
import { ApiError, invalid } from "@/lib/api/errors";
import { ydocStore } from "../../server/ydoc-store";

// docs/MCP.md §9 — one call that creates a LIVE annotation, root or reply,
// where the UI spreads the same work across a draft, the body's websocket and
// Post:
//
// 1. Create: the row, as a DRAFT, and its body ydoc, seeded from the parsed
//    body with its Yjs client registered (annotation-ydoc-seed.ts).
// 2. Settle: `settleAnnotationBody` asks the collab server for the mark, and
//    `writeSettledBody` writes, in one transaction, version 1, the cache
//    columns, the status, `postedAt` and the anchor.
//
// A refusal before step 1 writes nothing; a failure after it removes the
// draft and its ydoc, so a half-made annotation is never left behind.
//
// **Never raised, never resolved.** Raising emails the body off the instance,
// to every other byline author or owner, and an email can't be unsent;
// resolving a thread, once it exists, is a person's act. So this writes LIVE
// and nothing else. Callers have already checked the container and the
// parent (posted, not deleted, in the same container) and resolved the anchor.

/** Where a new annotation points. */
export type PostedAnchor =
  /** On the whole doc or PDF, or — for a reply — on the whole of its parent. */
  | { kind: "none"; stamp: bigint | null }
  /** Columns into a doc (a root) or into the parent's body (a reply), measured at `stamp`. */
  | { kind: "range"; stamp: bigint; from: number; to: number; quotedText: string }
  /** A root on a PDF page: the whole target, its quote derived by this server. */
  | { kind: "pdf"; target: PdfTarget; quotedText: string };

export async function createPostedAnnotation(
  actor: Actor,
  opts: {
    container: { kind: "doc" | "file"; id: string };
    parentId: string | null;
    /** The body, annotationContentExtensions JSON, already schema-checked. */
    body: JSONContent;
    anchor: PostedAnchor;
  },
): Promise<{ id: string; createdAt: Date; stamp: bigint | null }> {
  const text = extractText(opts.body);
  if (!text.trim()) throw invalid("An annotation can't be empty.");
  if (text.length > MAX_BODY_LENGTH) {
    throw new ApiError("too_large", `An annotation is at most ${MAX_BODY_LENGTH} characters; long-form writing belongs in a doc.`);
  }

  const seed = seedAnnotationYdocFromJson(opts.body, actor.userId);
  const row = await prisma.annotation.create({
    data: {
      ...(opts.container.kind === "doc" ? { docId: opts.container.id } : { fileId: opts.container.id }),
      parentAnnotationId: opts.parentId,
      userId: actor.userId,
      proseJson: seed.proseJson as Prisma.InputJsonValue,
      bodyText: "",
      status: "DRAFT",
    },
    select: { id: true, createdAt: true },
  });
  const ydocId = ydocIdForAnnotation(row.id);
  try {
    await ydocStore.createIfAbsent(ydocId, seed.ydoc, seed.stateVector);
    const settled = await settleAnnotationBody(row.id, viewerOf(actor), { expectChange: false });
    if ("error" in settled) throw invalid(settled.error);

    const anchor = opts.anchor;
    const stamp = anchor.kind === "pdf" ? null : anchor.stamp;
    const now = new Date();
    await writeSettledBody({
      annotationId: row.id,
      settled,
      userId: actor.userId,
      at: now,
      alongside: {
        status: "LIVE",
        postedAt: now,
        ydocUpdateId: stamp,
        ...(anchor.kind === "range"
          ? { anchorFrom: anchor.from, anchorTo: anchor.to, quotedText: anchor.quotedText }
          : anchor.kind === "pdf"
            ? { pdfTarget: anchor.target as unknown as Prisma.InputJsonValue, quotedText: anchor.quotedText }
            : {}),
      },
    });
    return { id: row.id, createdAt: row.createdAt, stamp };
  } catch (err) {
    await prisma.annotation.delete({ where: { id: row.id } }).catch(() => {});
    await prisma.ydoc.deleteMany({ where: { id: ydocId } }).catch(() => {});
    throw err;
  }
}
