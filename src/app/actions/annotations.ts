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
import { ydocIdForAnnotation } from "@/lib/ydoc-names";
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
// keeps proseJson/bodyText current), so this only changes visibility and,
// for a root annotation with a captured selection, applies the mark
// (row-first-mark-second, same ordering §12i's original submitAnnotation
// established — a mark naming a still-DRAFT row would be
// visible-but-unreadable to anyone who resolved it before this update
// commits).
export async function postAnnotation(opts: {
  annotationId: string;
  anchorFrom?: number;
  anchorTo?: number;
  quotedText?: string;
  // "Notify authors" (PLAN.md §13d) — RAISED is LIVE plus the doc's byline
  // authors emailed and raisedAt stamped; nothing else about visibility or
  // the mark differs from a plain LIVE post.
  raise?: boolean;
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

  await prisma.annotation.update({
    where: { id: annotation.id },
    data: opts.raise ? { status: "RAISED", raisedAt: new Date() } : { status: "LIVE" },
  });

  // Only a root annotation ever carries a mark — a reply is just a comment
  // in the thread, anchored nowhere of its own (PLAN.md §12i).
  if (
    annotation.parentAnnotationId === null &&
    typeof opts.anchorFrom === "number" &&
    typeof opts.anchorTo === "number" &&
    opts.quotedText &&
    opts.anchorTo > opts.anchorFrom
  ) {
    await applyAnnotationMark({
      docId: annotation.docId,
      userId: session.user.id,
      role: session.user.role,
      annotationId: annotation.id,
      from: opts.anchorFrom,
      to: opts.anchorTo,
      quotedText: opts.quotedText,
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
