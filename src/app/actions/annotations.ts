"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserReadDoc } from "@/lib/doc-authz";
import { isAdmin } from "@/lib/authz";
import { applyAnnotationMark, flushAnnotationCache, removeAnnotationMark } from "@/lib/annotation-admin";
import { docTitleOrFallback } from "@/lib/doc-title";
import { sendMail } from "@/lib/mail";
import { appUrl } from "@/lib/app-url";
import { seedAnnotationYdoc } from "@/lib/annotation-ydoc-seed";
import { captureAnnotationAnchor } from "@/lib/annotation-anchor-capture";
import { resolveUpdateIdForSnapshot } from "@/lib/ydoc-version";
import { materializeYdocAt } from "@/lib/ydoc-snapshot";
import {
  annotationContentExtensions,
  docContentExtensions,
  pmAnnotationContentSchema,
  pmDocContentSchema,
} from "@/lib/tiptap-schema";
import { ydocIdForAnnotation, ydocIdForDoc } from "@/lib/ydoc-names";
import { ydocStore } from "../../../server/ydoc-store";
import type { Prisma } from "@/generated/prisma/client";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

const MAX_BODY_LENGTH = 5000;

// PLAN.md §13d/§13j Phase 2 — a composer needs a row to attach a live
// editor to before a single keystroke lands, so opening one (the bottom
// composer, or Reply) creates a DRAFT eagerly: invisible to every other
// reader (annotation-data.ts's getDocAnnotationsAsThreads excludes another
// user's DRAFT rows outright) and carrying no inline mark until posted
// (applyAnnotationMark is only ever called from postAnnotation below, never
// from here). Seeded with an empty paragraph, same shape seedAnnotationYdoc
// already produces for real content.
export async function createDraftAnnotation(
  docId: string,
  parentAnnotationId?: string,
): Promise<{ id: string } | { error: string }> {
  const session = await auth();
  if (!session?.user) {
    return { error: "You must be signed in to annotate a doc." };
  }

  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { id: true, visibility: true } });
  if (!doc) {
    return { error: "Doc not found." };
  }
  if (!(await canUserReadDoc(session.user.id, session.user.role, doc))) {
    return { error: "You don't have permission to annotate this doc." };
  }

  let parentId: string | null = null;
  if (parentAnnotationId) {
    const parent = await prisma.annotation.findUnique({ where: { id: parentAnnotationId }, select: { docId: true } });
    if (!parent || parent.docId !== docId) {
      return { error: "Invalid reply target." };
    }
    parentId = parentAnnotationId;
  }

  const seed = seedAnnotationYdoc("");
  const annotation = await prisma.annotation.create({
    data: {
      docId,
      parentAnnotationId: parentId,
      userId: session.user.id,
      proseJson: seed.proseJson as Prisma.InputJsonValue,
      bodyText: "",
      status: "DRAFT",
    },
  });
  await ydocStore.createIfAbsent(ydocIdForAnnotation(annotation.id), seed.ydoc, seed.stateVector);

  return { id: annotation.id };
}

// Flips a DRAFT to LIVE (or RAISED — PLAN.md §13d) — the live ydoc editor
// (AnnotationBody) has already been writing the real content in via the
// collab server the whole time (server/annotation-cache.ts's store debounce
// keeps proseJson/bodyText current), so this only changes visibility and
// records the anchor, if the composer captured one.
//
// PLAN.md §13o — *how* it records that anchor is the one thing this action
// branches on, and it branches on `anchorMode`, which names the surface the
// annotation was composed on rather than anything about the author:
//
//   - "mark" — the doc editor. Applies the in-ydoc mark exactly as before
//     (row-first-mark-second, the ordering §12i's original submitAnnotation
//     established: a mark naming a still-DRAFT row would be
//     visible-but-unreadable to anyone who resolved it before this commits),
//     and writes no columns.
//   - "columns" — either reading view, and the default. Writes
//     anchorFrom/anchorTo/quotedText and touches the document not at all.
//     A reader annotating a doc no longer causes a write to it.
export async function postAnnotation(opts: {
  annotationId: string;
  // PLAN.md §13o. Defaults to "columns": every caller but the doc editor's
  // own popover is a reading surface, and a caller that forgets to say
  // should get the mechanism that can't mutate the document.
  anchorMode?: "mark" | "columns";
  anchorFrom?: number;
  anchorTo?: number;
  // The client's own reading of its selection. In "mark" mode the collab
  // server verifies the offsets against it; in "columns" mode
  // captureAnnotationAnchor does. Never stored as sent either way — §12i's
  // "a request field only, never a column" survives the column's arrival.
  quotedText?: string;
  // "Notify authors" (PLAN.md §13d) — RAISED is LIVE plus the doc's byline
  // authors emailed and raisedAt stamped; nothing else about visibility or
  // the mark differs from a plain LIVE post.
  raise?: boolean;
  // PLAN.md §12p/§13 — the ydoc_update the author's own view showed, string
  // because BigInt doesn't survive a server-action boundary. Supplied by the
  // inline popover only when it knows precisely (annotating while
  // scrub-frozen, DocView threads DocScrubBar's own position down); every
  // other caller (the bottom composer, a reply) omits it and falls back to
  // the doc's own update-log tail below.
  ydocUpdateId?: string;
  // PLAN.md §13q — the document version the offsets were measured against, as
  // a base64 Yjs snapshot captured at selection time. Preferred over the tail
  // below: it names what the annotator was actually looking at, where the
  // tail names what the server happens to hold now. Absent from any surface
  // with no live Y.Doc to capture from.
  atVersion?: string;
}): Promise<{ error?: string }> {
  const session = await auth();
  if (!session?.user) {
    return { error: "Unauthorized." };
  }

  const annotation = await prisma.annotation.findUnique({
    where: { id: opts.annotationId },
    select: { id: true, docId: true, userId: true, parentAnnotationId: true, status: true },
  });
  if (!annotation) {
    return { error: "Annotation not found." };
  }
  if (annotation.userId !== session.user.id) {
    return { error: "You don't have permission to post this annotation." };
  }
  if (annotation.status !== "DRAFT") {
    return { error: "This annotation has already been posted." };
  }

  // Forces the store-debounce write bodyText/proseJson normally wait for —
  // without this, a reader who opens the annotation the instant it becomes
  // LIVE could see whatever was cached as of the *last* debounce (for a
  // brand-new annotation, its creation-time empty paragraph) rather than
  // what was actually typed just now.
  //
  // The flush reads the *collab server's* Y.Doc, which only has what it's
  // already received from the client over the websocket — a keystroke and
  // an immediate click can outrace that delivery (real for a slow
  // connection, and reliably reproducible in an automated test that types
  // and clicks back-to-back with no human-typing-speed gap between them).
  // A bounded retry absorbs that without adding any real delay for the
  // overwhelming common case where the flush already sees everything.
  let bodyText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await flushAnnotationCache({ userId: session.user.id, role: session.user.role, annotationId: annotation.id });
    const fresh = await prisma.annotation.findUnique({ where: { id: annotation.id }, select: { bodyText: true } });
    bodyText = fresh?.bodyText ?? "";
    if (bodyText.trim() || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (!bodyText.trim()) {
    return { error: "Annotation can't be empty." };
  }
  if (bodyText.length > MAX_BODY_LENGTH) {
    return { error: `Annotation is too long (max ${MAX_BODY_LENGTH} characters).` };
  }

  const parentId = annotation.parentAnnotationId;

  // PLAN.md §13p — **what an anchor points at is decided by whether this is a
  // reply, not by what the client asked for.** A root annotation anchors into
  // the doc; a reply anchors into the annotation it answers, and cannot
  // anchor into the doc at all. That falls out of what a reply *is*: it is
  // about something its parent said, and a quotation of the doc belongs to
  // whichever annotation is about the doc.
  const anchorRequested =
    typeof opts.anchorFrom === "number" &&
    typeof opts.anchorTo === "number" &&
    !!opts.quotedText &&
    opts.anchorTo > opts.anchorFrom;

  // A reply is always columns, never a mark, and not as a policy choice: an
  // annotation's own body schema has no `annotation` mark in it
  // (annotationContentExtensions, §13a) precisely so a body can't carry an
  // anchor onto another annotation, and §13p doesn't change that.
  const anchorMode = parentId !== null ? "columns" : (opts.anchorMode ?? "columns");

  // Which ydoc the anchor is measured into — and therefore which update log
  // stamps it (§13o: the stamp is the coordinate system, so the two cannot be
  // chosen independently).
  const anchorYdocId = parentId !== null ? ydocIdForAnnotation(parentId) : ydocIdForDoc(annotation.docId);

  // The client's own position when it knew one precisely; otherwise the tail
  // of whichever log is about to matter. A malformed client value (should
  // never happen, but this is a server action) falls through to the same tail
  // lookup rather than failing the whole post over metadata.
  //
  // An *anchorless* annotation — including an anchorless reply, which is what
  // the plain Reply button still produces — stamps the doc's log, as every row
  // did before §13p: with no offsets to be a coordinate system for, the column
  // means only §13n's "what was I looking at", and that is the doc.
  //
  // Computed before the anchor, not alongside it: the anchor has to be
  // resolved against *this* state rather than whatever the document has
  // become by the time the update lands.
  let ydocUpdateId: bigint | null = null;
  if (opts.ydocUpdateId !== undefined) {
    try {
      ydocUpdateId = BigInt(opts.ydocUpdateId);
    } catch {
      ydocUpdateId = null;
    }
  }
  // PLAN.md §13q — the client's own version, converted. Tried before the tail
  // because the two answer different questions: this one is "what was the
  // annotator looking at", the tail is "what does the server hold now", and
  // they diverge exactly when somebody else is editing — which is the case
  // the stamp exists for.
  //
  // Only for an anchor into the doc. A reply's anchor targets its parent
  // annotation's ydoc, which the client has no live connection to (an
  // annotation body renders from its proseJson cache, not a tap), so there is
  // no version to capture and the tail is used. That is not a gap: nothing
  // edits a posted annotation body today, so the tail *is* what the reader
  // saw. It stops being true the day bodies become mutable (COLLAB.md's
  // 2026-08-13 entry), which is when this branch needs a client-side capture
  // of its own rather than a different server-side rule.
  if (ydocUpdateId === null && opts.atVersion && anchorRequested && parentId === null) {
    try {
      const headDoc = await materializeYdocAt(anchorYdocId, (await ydocStore.maxUpdateId(anchorYdocId))!);
      const resolved = await resolveUpdateIdForSnapshot(
        anchorYdocId,
        Buffer.from(opts.atVersion, "base64"),
        headDoc,
      );
      headDoc.destroy();
      ydocUpdateId = resolved.updateId;
      if (resolved.walked > 200) {
        console.info(
          `[annotations] resolved a version ${resolved.walked} rows back in ${anchorYdocId} — ` +
            `checkpointing is one debounce behind head, so this means the annotator was frozen for a while`,
        );
      }
    } catch (err) {
      // A malformed or undecodable snapshot, or a store failure. Falls to the
      // tail below, which is exactly the behaviour before this existed — the
      // anchor stays self-consistent with whatever gets stamped either way
      // (captureAnnotationAnchor re-derives against it), so this degrades
      // rather than fails.
      console.error(`[annotations] couldn't resolve the client's version for ${anchorYdocId}:`, err);
    }
  }
  if (ydocUpdateId === null) {
    ydocUpdateId = await ydocStore.maxUpdateId(
      anchorRequested ? anchorYdocId : ydocIdForDoc(annotation.docId),
    );
  }

  // Resolved *before* the status write, unlike the mark below, because it is
  // part of the row rather than a separate document edit: one update, no
  // window in which a LIVE annotation exists without the anchor it was
  // posted with.
  let capturedAnchor: { from: number; to: number; quotedText: string } | null = null;
  if (anchorRequested && anchorMode === "columns" && ydocUpdateId !== null) {
    capturedAnchor = await captureAnnotationAnchor({
      ydocId: anchorYdocId,
      throughUpdateId: ydocUpdateId,
      // The two targets are different documents with different schemas —
      // decoding a doc body with the annotation schema would silently drop
      // every annotation mark in it, and decoding an annotation body with the
      // doc schema would register a mark that body can never contain.
      extensions: parentId !== null ? annotationContentExtensions : docContentExtensions,
      schema: parentId !== null ? pmAnnotationContentSchema : pmDocContentSchema,
      from: opts.anchorFrom!,
      to: opts.anchorTo!,
      quotedText: opts.quotedText!,
    });
  }

  await prisma.annotation.update({
    where: { id: annotation.id },
    data: {
      ...(opts.raise ? { status: "RAISED", raisedAt: new Date() } : { status: "LIVE" }),
      ydocUpdateId,
      ...(capturedAnchor
        ? { anchorFrom: capturedAnchor.from, anchorTo: capturedAnchor.to, quotedText: capturedAnchor.quotedText }
        : {}),
    },
  });

  // Unreachable for a reply — `anchorMode` was forced to "columns" above —
  // which is what makes this branch's use of `docId` safe without a second
  // root check of its own.
  if (anchorRequested && anchorMode === "mark") {
    await applyAnnotationMark({
      docId: annotation.docId,
      userId: session.user.id,
      role: session.user.role,
      annotationId: annotation.id,
      from: opts.anchorFrom!,
      to: opts.anchorTo!,
      quotedText: opts.quotedText!,
    });
    // No branch on the result — same reasoning as submitAnnotation above:
    // whether or not the mark landed, LIVE is already correct either way.
  }

  if (opts.raise) {
    const doc = await prisma.doc.findUnique({
      where: { id: annotation.docId },
      select: { title: true, slug: true, authors: { select: { user: { select: { email: true } } } } },
    });
    if (doc) {
      const raisedBy = session.user.name ?? session.user.email ?? "Someone";
      const subject = `${raisedBy} raised an annotation on "${docTitleOrFallback(doc.title)}"`;
      const text = `${bodyText}\n\n${appUrl(`/doc/${doc.slug}`)}`;
      // One recipient per byline author, not a single multi-recipient
      // message — same reasoning src/app/actions/forgot-password.ts's own
      // one-off sendMail call has no need to weigh, but real here: nothing
      // ties these authors together as a group the way a Cc/To list would
      // otherwise imply.
      await Promise.all(doc.authors.map((a) => sendMail({ to: a.user.email, subject, text })));
    }
  }

  revalidatePath(`/doc/${annotation.docId}`);
  return {};
}

// "Keep private" (PLAN.md §13d) — the row is already DRAFT by default
// (createDraftAnnotation), so there's no status to change; this just
// forces the same flush postAnnotation does, so what was typed is actually
// saved rather than left at whatever the last debounce happened to catch.
export async function saveDraftAnnotation(annotationId: string): Promise<{ error?: string }> {
  const session = await auth();
  if (!session?.user) {
    return { error: "Unauthorized." };
  }
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { userId: true, status: true, docId: true },
  });
  if (!annotation) {
    return { error: "Annotation not found." };
  }
  if (annotation.userId !== session.user.id) {
    return { error: "You don't have permission to save this annotation." };
  }
  if (annotation.status !== "DRAFT") {
    return { error: "This annotation has already been posted." };
  }

  await flushAnnotationCache({ userId: session.user.id, role: session.user.role, annotationId });
  revalidatePath(`/doc/${annotation.docId}`);
  return {};
}

// Cancel on a not-yet-posted composer — discards the row and its ydoc
// outright rather than leaving an empty (or abandoned-mid-thought) DRAFT
// behind forever. Silently no-ops on a row that's already gone (e.g. a
// second Cancel click racing the first) rather than erroring.
export async function discardDraftAnnotation(annotationId: string): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { userId: true, status: true, docId: true },
  });
  if (!annotation) {
    return;
  }
  if (annotation.userId !== session.user.id) {
    throw new Error("You don't have permission to discard this draft.");
  }
  if (annotation.status !== "DRAFT") {
    throw new Error("This annotation has already been posted.");
  }
  await prisma.annotation.delete({ where: { id: annotationId } });
  await prisma.ydoc.deleteMany({ where: { id: ydocIdForAnnotation(annotationId) } });
  revalidatePath(`/doc/${annotation.docId}`);
}

async function requireOwnOrAdmin(annotationId: string) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { userId: true, docId: true, status: true },
  });
  if (!annotation) {
    throw new Error("Annotation not found.");
  }
  const isOwn = annotation.userId === session.user.id;
  if (!isAdmin(session.user.role) && !isOwn) {
    throw new Error("You don't have permission to modify this annotation.");
  }
  return { session, annotation };
}

export async function deleteAnnotation(annotationId: string): Promise<void> {
  const { session, annotation } = await requireOwnOrAdmin(annotationId);
  await prisma.annotation.update({
    where: { id: annotationId },
    data: { deletedByUserId: session.user.id, deletedAt: new Date() },
  });
  // A DRAFT never had a mark applied (§13d), so there's nothing to remove —
  // skip the round trip for the common "deleting my own private note" case.
  if (annotation.status !== "DRAFT") {
    await removeAnnotationMark({
      docId: annotation.docId,
      userId: session.user.id,
      role: session.user.role,
      annotationId,
    });
  }
  revalidatePath(`/doc/${annotation.docId}`);
  revalidatePath("/annotations");
}

export async function restoreAnnotation(annotationId: string): Promise<void> {
  const { annotation } = await requireOwnOrAdmin(annotationId);
  await prisma.annotation.update({
    where: { id: annotationId },
    data: { deletedByUserId: null, deletedAt: null },
  });
  revalidatePath(`/doc/${annotation.docId}`);
  revalidatePath("/annotations");
}

// Bulk delete/restore (PLAN.md §16g) — see bulkDeletePosts for why these are
// per-row rather than one transaction.
export async function bulkDeleteAnnotations(annotationIds: string[]): Promise<BulkResult> {
  return settleBulk(annotationIds, (id) => deleteAnnotation(id));
}

export async function bulkRestoreAnnotations(annotationIds: string[]): Promise<BulkResult> {
  return settleBulk(annotationIds, (id) => restoreAnnotation(id));
}
