"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import { getSiteSettings } from "@/lib/site-settings";
import { resolveCommentStatus } from "@/lib/moderation";
import { getClientIp } from "@/lib/request-ip";
import { isCommentRateLimited } from "@/lib/rate-limit";
import { checkSpam } from "@/lib/spam-check";
import type { CommentStatus, Role } from "@/generated/prisma/enums";

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
  const anchorFromRaw = formData.get("anchorFrom");
  const anchorToRaw = formData.get("anchorTo");
  const quotedText = formData.get("quotedText");

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
  if (!post || !post.publishRevisionId || derivePostStatus(post) !== "published") {
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

  const ipAddress = await getClientIp();
  if (await isCommentRateLimited(ipAddress, commenter.id)) {
    return { error: "You're posting comments too quickly. Please wait a few minutes and try again." };
  }

  let parentId: string | null = null;
  let thread: { id: string };

  if (typeof parentCommentId === "string" && parentCommentId) {
    // A reply always belongs to its parent's existing thread — never
    // creates a new one, even if anchor fields were also submitted.
    const parent = await prisma.comment.findUnique({
      where: { id: parentCommentId },
      include: { thread: { select: { postId: true } } },
    });
    if (!parent || parent.thread.postId !== postId) {
      return { error: "Invalid reply target." };
    }
    parentId = parent.id;
    thread = { id: parent.threadId };
  } else if (typeof anchorFromRaw === "string" && typeof anchorToRaw === "string" && typeof quotedText === "string") {
    const anchorFrom = Number(anchorFromRaw);
    const anchorTo = Number(anchorToRaw);
    if (!Number.isInteger(anchorFrom) || !Number.isInteger(anchorTo) || anchorTo <= anchorFrom || !quotedText.trim()) {
      return { error: "Invalid quote selection." };
    }
    thread =
      (await prisma.commentThread.findFirst({ where: { postId, anchorFrom, anchorTo } })) ??
      (await prisma.commentThread.create({
        data: {
          postId,
          anchoredRevisionId: post.publishRevisionId,
          anchorFrom,
          anchorTo,
          quotedText: quotedText.trim(),
        },
      }));
  } else {
    // No parent, no anchor: falls back to the one general per-post thread,
    // created lazily on first use.
    thread =
      (await prisma.commentThread.findFirst({ where: { postId, quotedText: "" } })) ??
      (await prisma.commentThread.create({
        data: {
          postId,
          anchoredRevisionId: post.publishRevisionId,
          anchorFrom: 0,
          anchorTo: 0,
          quotedText: "",
        },
      }));
  }

  const trimmedBody = body.trim();
  const commenterIsAdmin = session?.user?.role === "ADMIN";
  const isSpam = !commenterIsAdmin && (await checkSpam({ body: trimmedBody, displayName, email, ipAddress }));

  const siteSettings = await getSiteSettings();
  const status: CommentStatus = isSpam
    ? "SPAM"
    : resolveCommentStatus({
        commenterIsAdmin,
        commenterForceModerate: commenter.forceModerate,
        commenterApprovedCount: commenter.approvedCount,
        trustThreshold: siteSettings.trustThreshold,
        postPolicy: post.moderationPolicy,
        authorPolicies: post.authors.map((a) => a.user.moderationPolicy),
        sitePolicy: siteSettings.defaultModerationPolicy === "AUTO" ? "AUTO" : "ALWAYS",
      });

  await prisma.comment.create({
    data: {
      threadId: thread.id,
      parentCommentId: parentId,
      commenterId: commenter.id,
      body: { text: trimmedBody },
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

async function moderateOne(userId: string, role: Role, commentId: string, action: "approve" | "spam" | "pend") {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { thread: { include: { post: { select: { id: true, slug: true } } } } },
  });
  if (!comment) {
    throw new Error("Comment not found.");
  }

  const allowed = await canUserEditPost(userId, role, comment.thread.post.id);
  if (!allowed) {
    throw new Error("You don't have permission to moderate this comment.");
  }

  const newStatus: CommentStatus = action === "approve" ? "APPROVED" : action === "spam" ? "SPAM" : "PENDING";
  await prisma.comment.update({
    where: { id: commentId },
    data: { status: newStatus, statusChangedById: userId, statusChangedAt: new Date() },
  });

  if (newStatus === "APPROVED" && comment.status !== "APPROVED") {
    await prisma.commenter.update({
      where: { id: comment.commenterId },
      data: { approvedCount: { increment: 1 } },
    });
  }

  return comment.thread.post;
}

async function deleteOne(userId: string, role: Role, commentId: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: {
      commenter: { select: { userId: true } },
      thread: { select: { post: { select: { id: true, slug: true } } } },
    },
  });
  if (!comment) {
    throw new Error("Comment not found.");
  }

  const isOwnComment = comment.commenter.userId === userId;
  if (role !== "ADMIN" && !isOwnComment) {
    throw new Error("You don't have permission to delete this comment.");
  }

  await prisma.comment.update({
    where: { id: commentId },
    data: { deletedByUserId: userId, deletedAt: new Date() },
  });

  return comment.thread.post;
}

async function restoreOne(userId: string, role: Role, commentId: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { thread: { select: { post: { select: { id: true, slug: true } } } } },
  });
  if (!comment) {
    throw new Error("Comment not found.");
  }

  const allowed = await canUserEditPost(userId, role, comment.thread.post.id);
  if (!allowed) {
    throw new Error("You don't have permission to restore this comment.");
  }

  await prisma.comment.update({
    where: { id: commentId },
    data: { deletedByUserId: null, deletedAt: null },
  });

  return comment.thread.post;
}

// Revalidates the public post page (comment visibility) and its per-post
// moderation queue for every distinct post touched by a batch — a bulk
// action can span comments from several posts at once.
function revalidateTouchedPosts(posts: { id: string; slug: string }[]) {
  const seen = new Set<string>();
  for (const post of posts) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    revalidatePath(`/${post.slug}`);
    revalidatePath(`/posts/${post.id}/comments`);
  }
  revalidatePath("/comments");
}

export async function moderateComment(commentId: string, action: "approve" | "spam" | "pend"): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const post = await moderateOne(session.user.id, session.user.role, commentId, action);
  revalidateTouchedPosts([post]);
}

export async function deleteComment(commentId: string): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const post = await deleteOne(session.user.id, session.user.role, commentId);
  revalidateTouchedPosts([post]);
}

export async function restoreComment(commentId: string): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const post = await restoreOne(session.user.id, session.user.role, commentId);
  revalidateTouchedPosts([post]);
}

export async function bulkModerateComments(commentIds: string[], action: "approve" | "spam" | "pend"): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const { id: userId, role } = session.user;
  const posts = await Promise.all(commentIds.map((id) => moderateOne(userId, role, id, action)));
  revalidateTouchedPosts(posts);
}

export async function bulkDeleteComments(commentIds: string[]): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const { id: userId, role } = session.user;
  const posts = await Promise.all(commentIds.map((id) => deleteOne(userId, role, id)));
  revalidateTouchedPosts(posts);
}

export async function bulkRestoreComments(commentIds: string[]): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const { id: userId, role } = session.user;
  const posts = await Promise.all(commentIds.map((id) => restoreOne(userId, role, id)));
  revalidateTouchedPosts(posts);
}
