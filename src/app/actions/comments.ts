"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost } from "@/lib/authz";
import { getSiteSettings } from "@/lib/site-settings";
import { resolveCommentStatus } from "@/lib/moderation";
import { getClientIp } from "@/lib/request-ip";
import type { CommentStatus } from "@/generated/prisma/enums";

export type SubmitCommentState = { error?: string; status?: CommentStatus };

const MAX_BODY_LENGTH = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitComment(
  _prevState: SubmitCommentState,
  formData: FormData,
): Promise<SubmitCommentState> {
  const postId = formData.get("postId");
  const parentCommentId = formData.get("parentCommentId");
  const body = formData.get("body");

  if (typeof postId !== "string" || !postId) {
    return { error: "Missing post." };
  }
  if (typeof body !== "string" || !body.trim()) {
    return { error: "Comment can't be empty." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `Comment is too long (max ${MAX_BODY_LENGTH} characters).` };
  }

  const session = await auth();
  let userId: string | null = null;
  let email: string;
  let displayName: string;

  if (session?.user) {
    if (!session.user.email) {
      return { error: "Your account has no email on file." };
    }
    userId = session.user.id;
    email = session.user.email;
    displayName = session.user.name ?? session.user.email;
  } else {
    const name = formData.get("name");
    const rawEmail = formData.get("email");
    if (typeof name !== "string" || !name.trim()) {
      return { error: "Name is required." };
    }
    if (typeof rawEmail !== "string" || !EMAIL_RE.test(rawEmail)) {
      return { error: "A valid email is required." };
    }
    displayName = name.trim();
    email = rawEmail.trim().toLowerCase();
  }

  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: {
      authors: { include: { user: { select: { moderationPolicy: true } } } },
    },
  });
  if (!post || post.status !== "PUBLISHED" || !post.currentRevisionId) {
    return { error: "This post isn't open for comments." };
  }

  const commenter = userId
    ? await prisma.commenter.upsert({
        where: { userId },
        update: {},
        create: { userId, email, displayName },
      })
    : await prisma.commenter.upsert({
        where: { email },
        update: {},
        create: { email, displayName },
      });

  // Every comment in step 5 (no quote-anchoring yet, that's a later step)
  // attaches to one general per-post thread, created lazily on first use.
  let thread = await prisma.commentThread.findFirst({
    where: { postId, quotedText: "" },
  });
  if (!thread) {
    thread = await prisma.commentThread.create({
      data: {
        postId,
        anchoredRevisionId: post.currentRevisionId,
        anchorFrom: 0,
        anchorTo: 0,
        quotedText: "",
      },
    });
  }

  let parentId: string | null = null;
  if (typeof parentCommentId === "string" && parentCommentId) {
    const parent = await prisma.comment.findUnique({ where: { id: parentCommentId } });
    if (!parent || parent.threadId !== thread.id) {
      return { error: "Invalid reply target." };
    }
    parentId = parent.id;
  }

  const siteSettings = await getSiteSettings();
  const status = resolveCommentStatus({
    commenterForceModerate: commenter.forceModerate,
    commenterApprovedCount: commenter.approvedCount,
    trustThreshold: siteSettings.trustThreshold,
    postPolicy: post.moderationPolicy,
    authorPolicies: post.authors.map((a) => a.user.moderationPolicy),
    sitePolicy: siteSettings.defaultModerationPolicy === "AUTO" ? "AUTO" : "ALWAYS",
  });

  const ipAddress = await getClientIp();

  await prisma.comment.create({
    data: {
      threadId: thread.id,
      parentCommentId: parentId,
      commenterId: commenter.id,
      body: { text: body.trim() },
      status,
      ipAddress,
    },
  });

  if (status === "APPROVED") {
    await prisma.commenter.update({
      where: { id: commenter.id },
      data: { approvedCount: { increment: 1 } },
    });
  }

  revalidatePath(`/${post.slug}`);
  return { status };
}

export async function moderateComment(commentId: string, action: "approve" | "spam"): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { thread: { include: { post: { select: { id: true, slug: true } } } } },
  });
  if (!comment) {
    throw new Error("Comment not found.");
  }

  const allowed = await canUserEditPost(session.user.id, session.user.role, comment.thread.post.id);
  if (!allowed) {
    throw new Error("You don't have permission to moderate this comment.");
  }

  const newStatus: CommentStatus = action === "approve" ? "APPROVED" : "SPAM";
  await prisma.comment.update({
    where: { id: commentId },
    data: { status: newStatus, statusChangedById: session.user.id, statusChangedAt: new Date() },
  });

  if (newStatus === "APPROVED" && comment.status !== "APPROVED") {
    await prisma.commenter.update({
      where: { id: comment.commenterId },
      data: { approvedCount: { increment: 1 } },
    });
  }

  revalidatePath(`/${comment.thread.post.slug}`);
  revalidatePath(`/posts/${comment.thread.post.id}/comments`);
}
