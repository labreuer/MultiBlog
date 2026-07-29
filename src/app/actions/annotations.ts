"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserReadDoc } from "@/lib/doc-authz";
import { applyAnnotationMark } from "@/lib/annotation-admin";
import type { SubmitCommentState } from "./comments";

const MAX_BODY_LENGTH = 5000;

// PLAN.md §12i — the sibling of submitComment (src/app/actions/comments.ts),
// sharing no path worth sharing once moderation, Commenter, rate limiting
// and spam checking are absent from this side. Returns the same
// SubmitCommentState shape CommentForm already branches on: an annotation
// is "inserted immediately visible" (the plan's own words), which is
// exactly what CommentForm's APPROVED case already means.
export async function submitAnnotation(
  _prevState: SubmitCommentState,
  formData: FormData,
): Promise<SubmitCommentState> {
  const docId = formData.get("docId");
  const parentAnnotationId = formData.get("parentCommentId");
  const body = formData.get("body");
  const fromRaw = formData.get("anchorFrom");
  const toRaw = formData.get("anchorTo");
  const quotedText = formData.get("quotedText");

  if (typeof docId !== "string" || !docId) {
    return { error: "Missing doc." };
  }
  if (typeof body !== "string" || !body.trim()) {
    return { error: "Annotation can't be empty." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `Annotation is too long (max ${MAX_BODY_LENGTH} characters).` };
  }

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
  if (typeof parentAnnotationId === "string" && parentAnnotationId) {
    const parent = await prisma.annotation.findUnique({ where: { id: parentAnnotationId }, select: { docId: true } });
    if (!parent || parent.docId !== docId) {
      return { error: "Invalid reply target." };
    }
    parentId = parentAnnotationId;
  }

  const trimmedBody = body.trim();
  const annotation = await prisma.annotation.create({
    data: { docId, parentAnnotationId: parentId, userId: session.user.id, body: { text: trimmedBody } },
  });

  // Only a root annotation ever carries a mark — a reply is just a comment
  // in the thread, anchored nowhere of its own (PLAN.md §12i).
  if (
    parentId === null &&
    typeof fromRaw === "string" &&
    typeof toRaw === "string" &&
    typeof quotedText === "string" &&
    quotedText.trim()
  ) {
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (Number.isInteger(from) && Number.isInteger(to) && to > from) {
      await applyAnnotationMark({
        docId,
        userId: session.user.id,
        role: session.user.role,
        annotationId: annotation.id,
        from,
        to,
        quotedText: quotedText.trim(),
      });
      // No branch on the result: whether or not the mark landed, the
      // annotation is already correctly visible either anchored or in the
      // doc's general discussion (§12i's "row first, mark second" — the
      // degraded state is not a corrupt one).
    }
  }

  revalidatePath(`/doc/${docId}`);
  return { status: "APPROVED" };
}

async function requireOwnOrAdmin(annotationId: string) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const annotation = await prisma.annotation.findUnique({ where: { id: annotationId }, select: { userId: true, docId: true } });
  if (!annotation) {
    throw new Error("Annotation not found.");
  }
  const isOwn = annotation.userId === session.user.id;
  if (session.user.role !== "ADMIN" && !isOwn) {
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
