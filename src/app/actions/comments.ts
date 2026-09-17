"use server";

import { revalidatePath } from "next/cache";
import { revalidatePostPage } from "@/lib/revalidate-post";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserEditPost, isAdmin } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import { getSiteSettings } from "@/lib/site-settings";
import { resolveCommentStatus } from "@/lib/moderation";
import { getClientIp } from "@/lib/request-ip";
import { isCommentEditRateLimited, isCommentRateLimited } from "@/lib/rate-limit";
import { checkSpam } from "@/lib/spam-check";
import { visibleVersions, withSupersededAt } from "@/lib/edit-grace";
import type { CommentStatus, Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { JSONContent } from "@tiptap/core";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import { commentBodyTextFromJSON, isCommentBodyError } from "@/lib/comment-body";
import { resolveCommentBody } from "@/lib/comment-body-resolve";
import type { CommentBodyInput } from "@/lib/comment-body-value";
import { commentContentToMarkdown } from "@/lib/markdown-import";
import { docsEqual } from "@/lib/diff";

export type SubmitCommentState = { error?: string; status?: CommentStatus };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitComment(
  _prevState: SubmitCommentState,
  formData: FormData,
): Promise<SubmitCommentState> {
  const postId = formData.get("postId");
  const parentCommentId = formData.get("parentCommentId");
  const body = formData.get("body");
  const bodyFormat = formData.get("bodyFormat");
  const anchorFromRaw = formData.get("anchorFrom");
  const anchorToRaw = formData.get("anchorTo");
  const quotedText = formData.get("quotedText");

  if (typeof postId !== "string" || !postId) {
    return { error: "Missing post." };
  }
  if (typeof body !== "string") {
    return { error: "Comment can't be empty." };
  }
  // PLAN.md §23m — two front doors, one validated document. Anything but an
  // explicit "rich" is read as Markdown, which is also what a form with no
  // JavaScript at all submits.
  const parsedBody = resolveCommentBody({ format: bodyFormat === "rich" ? "rich" : "markdown", content: body });
  if (isCommentBodyError(parsedBody)) {
    return { error: parsedBody.error };
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
  if (!post || !post.publishEventId || derivePostStatus(post) !== "published") {
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
          anchoredEventId: post.publishEventId,
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
          anchoredEventId: post.publishEventId,
          anchorFrom: 0,
          anchorTo: 0,
          quotedText: "",
        },
      }));
  }

  const commenterIsAdmin = !!session?.user && isAdmin(session.user.role);
  const isSpam = !commenterIsAdmin && (await checkSpam({ body: parsedBody.text, displayName, email, ipAddress }));

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

  // PLAN.md §22c — the comment and its revision 1 in one transaction, which
  // is what makes `Comment.body`'s "cache of the newest revision" invariant
  // hold from the row's first instant rather than from its first edit. A
  // nested create rather than two statements: same atomicity, one round trip,
  // and the revision cannot be given the wrong `commentId`.
  await prisma.comment.create({
    data: {
      threadId: thread.id,
      parentCommentId: parentId,
      commenterId: commenter.id,
      body: parsedBody.json as Prisma.InputJsonValue,
      bodyText: parsedBody.text,
      status,
      ipAddress,
      revisions: {
        create: {
          revisionNo: 1,
          body: parsedBody.json as Prisma.InputJsonValue,
          // The commenter's user when they are signed in, null when they are
          // not — an anonymous original is the one version with nobody to
          // name, and `commenter.userId` is already exactly that distinction.
          authorUserId: commenter.userId,
        },
      },
    },
  });

  if (status === "APPROVED") {
    await prisma.commenter.update({
      where: { id: commenter.id },
      data: { approvedCount: { increment: 1 } },
    });
  }

  revalidatePostPage(post);
  return { status };
}

async function moderateOne(userId: string, role: Role, commentId: string, action: "approve" | "spam" | "pend") {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { thread: { include: { post: { select: { id: true, slug: true, publishedAt: true } } } } },
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
      thread: { select: { post: { select: { id: true, slug: true, publishedAt: true } } } },
    },
  });
  if (!comment) {
    throw new Error("Comment not found.");
  }

  const isOwnComment = comment.commenter.userId === userId;
  if (!isAdmin(role) && !isOwnComment) {
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
    include: { thread: { select: { post: { select: { id: true, slug: true, publishedAt: true } } } } },
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

// PLAN.md §22c — editing a posted comment.
//
// Three things about the shape are decisions rather than plumbing:
//
// 1. **The gate is the moderation gate**, `canUserEditPost`, plus "it's
//    mine". Whoever may approve, spam and delete a comment may also fix it;
//    inventing a narrower predicate would mean a moderator who can destroy a
//    comment outright cannot correct its spelling. §22f has the table.
// 2. **An anonymous commenter cannot edit**, because there is nothing to
//    prove they are the same person. The honest self-service path is an
//    emailed edit link, deferred with the rest of docs/EMAIL.md's list. The
//    moderation gate covers fixing their typo on request.
// 3. **A no-op edit writes nothing at all.** Not an optimization: a revision
//    row stamped `now` would close §22b's grace window (it supersedes the
//    previous version at the moment of the click), so a Save with nothing
//    changed could silently cost the author their quiet-correction window.
//
// Moderation state survives an edit except when the spam check trips, in which
// case the edit is still recorded — a moderator reversing the status should be
// able to see what was actually written. Re-running the full cascade and
// sending an untrusted commenter's edit back to PENDING is the stricter
// policy, and needs per-revision status to avoid the comment vanishing
// mid-conversation; §22h defers it with that prerequisite named.
export type EditCommentResult = {
  error?: string;
  status?: CommentStatus;
  /** The stored body after a successful save, so the card can render it before the refresh lands. */
  body?: JSONContent;
  bodyText?: string;
};

export async function editComment(commentId: string, input: CommentBodyInput): Promise<EditCommentResult> {
  const session = await auth();
  if (!session?.user) {
    return { error: "You must be signed in to edit a comment." };
  }
  const { id: userId, role } = session.user;

  const parsedBody = resolveCommentBody(input);
  if (isCommentBodyError(parsedBody)) {
    return { error: parsedBody.error };
  }

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: {
      commenter: { select: { id: true, userId: true, displayName: true, email: true } },
      thread: { select: { post: { select: { id: true, slug: true, publishedAt: true } } } },
      // The tail alone, not the whole history: all an edit needs is the
      // number to follow and the text to compare against.
      revisions: { orderBy: { revisionNo: "desc" }, take: 1, select: { revisionNo: true, body: true } },
    },
  });
  if (!comment) {
    return { error: "Comment not found." };
  }
  if (comment.deletedAt) {
    return { error: "This comment has been deleted." };
  }

  const isOwnComment = comment.commenter.userId === userId;
  const canModerate = await canUserEditPost(userId, role, comment.thread.post.id);
  if (!isOwnComment && !canModerate) {
    return { error: "You don't have permission to edit this comment." };
  }

  // docsEqual rather than string equality: jsonb does not preserve key order
  // on read-back, so a byte comparison would call every unchanged save a
  // change. Deliberately not an error: nothing is wrong, and nothing happened.
  if (docsEqual(parsedBody.json, comment.body)) {
    return {};
  }

  if (await isCommentEditRateLimited(userId)) {
    return { error: "You're editing comments too quickly. Please wait a few minutes and try again." };
  }

  const isSpam =
    !isAdmin(role) &&
    (await checkSpam({
      body: parsedBody.text,
      displayName: comment.commenter.displayName,
      email: comment.commenter.email,
      ipAddress: comment.ipAddress,
    }));

  // `revisions[0]` is absent only for a row predating the §22c backfill, which
  // cannot exist — the migration covered every comment, including soft-deleted
  // ones. Falling back to the comment's own count keeps the numbering dense
  // rather than throwing if that ever stops being true.
  const nextRevisionNo = (comment.revisions[0]?.revisionNo ?? 0) + 1;

  await prisma.$transaction([
    prisma.commentRevision.create({
      data: {
        commentId,
        revisionNo: nextRevisionNo,
        body: parsedBody.json as Prisma.InputJsonValue,
        // Who wrote *this version* — the moderator when a moderator edited it,
        // which is why this is the acting user and not `commenter.userId`.
        authorUserId: userId,
      },
    }),
    prisma.comment.update({
      where: { id: commentId },
      data: {
        body: parsedBody.json as Prisma.InputJsonValue,
        bodyText: parsedBody.text,
        editedAt: new Date(),
        ...(isSpam ? { status: "SPAM" as CommentStatus, statusChangedById: userId, statusChangedAt: new Date() } : {}),
      },
    }),
  ]);

  revalidateTouchedPosts([comment.thread.post]);
  return { status: isSpam ? "SPAM" : comment.status, body: parsedBody.json, bodyText: parsedBody.text };
}

// Whether this viewer may read a comment at all — the rule getCommentHistory
// states: an APPROVED, undeleted comment is public; anything else is its own
// author's and its post's moderators'. Shared with getCommentMarkdown, which
// hands the same body back in a different form.
async function canViewerReadComment(comment: {
  status: CommentStatus;
  deletedAt: Date | null;
  commenter: { userId: string | null };
  thread: { post: { id: string } };
}): Promise<boolean> {
  if (comment.status === "APPROVED" && comment.deletedAt === null) return true;
  const session = await auth();
  if (!session?.user) return false;
  if (comment.commenter.userId === session.user.id) return true;
  return canUserEditPost(session.user.id, session.user.role, comment.thread.post.id);
}

// PLAN.md §23m — the stored body serialized back to Markdown, for the edit
// box in Markdown mode. On demand rather than stored: a second stored form of
// one body is exactly the two-copies-that-can-disagree problem §23f's rewrite
// exists to avoid, and the round trip is a few microseconds.
export async function getCommentMarkdown(commentId: string): Promise<{ markdown: string } | { error: string }> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { commenter: { select: { userId: true } }, thread: { select: { post: { select: { id: true } } } } },
  });
  if (!comment || !(await canViewerReadComment(comment))) {
    return { error: "Comment not found." };
  }
  return { markdown: commentContentToMarkdown(comment.body as JSONContent) };
}

// PLAN.md §23m — switching the composer's mode with content in it. Both
// directions go through the server, so the browser never runs the Markdown
// parser: parsed there, an HTML token becomes a real node, the opposite of
// what the server does with the same text. Pure — no row is read or
// written, and the result is what a submit of the same content would store.
export async function convertCommentBody(
  input: CommentBodyInput,
  to: "markdown" | "rich",
): Promise<{ markdown: string } | { json: JSONContent } | { error: string }> {
  const parsedBody = resolveCommentBody(input);
  if (isCommentBodyError(parsedBody)) {
    return { error: parsedBody.error };
  }
  return to === "markdown" ? { markdown: commentContentToMarkdown(parsedBody.json) } : { json: parsedBody.json };
}

// PLAN.md §22c — the history one comment's "edited" marker opens.
//
// **The silence rule is applied here, on the server**, so a silent version
// never reaches the browser at all. The alternative — shipping every revision
// and hiding some in the client — would put the text of an edit nobody is
// meant to know about into a payload anyone can read.
//
// Fetched on open rather than rendered into the page for the reason
// `TagChips` is: the post page is statically generated (§21), and a dynamic
// read there throws at build (§12f).
export type CommentVersion = {
  revisionNo: number;
  body: JSONContent;
  bodyText: string;
  createdAt: string;
  authorName: string | null;
  /** The text currently on screen, i.e. the newest version. */
  current: boolean;
};

export async function getCommentHistory(commentId: string): Promise<CommentVersion[]> {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: {
      commenter: { select: { userId: true } },
      thread: { select: { post: { select: { id: true } } } },
      revisions: {
        orderBy: { revisionNo: "asc" },
        include: { author: { select: { name: true, email: true } }, quotedBy: { select: { id: true }, take: 1 } },
      },
    },
  });
  if (!comment) {
    return [];
  }

  // Who may see it: the same people who may see the comment. An APPROVED,
  // undeleted comment is public, so its history is too — that is the whole
  // point of a visible edit. Anything else (pending, spam, deleted) is
  // withheld from everyone but its own author and whoever moderates the post,
  // matching what the reading views already show of the comment itself.
  if (!(await canViewerReadComment(comment))) {
    return [];
  }

  // §22b's other clause: a version a comment_quote_anchor pins is never
  // silent, so the reader of the quote has something to find.
  const versions = withSupersededAt(comment.revisions, (revision) => revision.quotedBy.length > 0);
  const visible = visibleVersions(versions, comment.createdAt);
  const newestNo = versions[versions.length - 1]?.revisionNo;

  return visible
    .map((revision) => ({
      revisionNo: revision.revisionNo,
      body: revision.body as JSONContent,
      bodyText: commentBodyTextFromJSON(revision.body),
      createdAt: revision.createdAt.toISOString(),
      authorName: revision.author?.name ?? revision.author?.email ?? null,
      current: revision.revisionNo === newestNo,
    }))
    .reverse();
}

// Revalidates the public post page (comment visibility) and its per-post
// moderation queue for every distinct post touched by a batch — a bulk
// action can span comments from several posts at once.
function revalidateTouchedPosts(posts: { id: string; slug: string; publishedAt: Date | null }[]) {
  const seen = new Set<string>();
  for (const post of posts) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);
    revalidatePostPage(post);
    revalidatePath(`/post/${post.id}/comments`);
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

// The three below report per-id outcomes (settleBulk, src/lib/bulk-result.ts)
// rather than throwing on the first failure, so /comments can paint each row's
// own border. Note `fulfilled` in place of the old `Promise.all` result: only
// the comments that actually moved should revalidate their post, or a failed
// moderation would bust a public page's cache for a change that never landed.
//
// The session check still throws. It is not per row — if the caller isn't
// signed in, no id in the batch was ever going to work, and reporting that as
// N identical per-row failures would be noise.
export async function bulkModerateComments(
  commentIds: string[],
  action: "approve" | "spam" | "pend",
): Promise<BulkResult> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const { id: userId, role } = session.user;
  const { failed, fulfilled } = await settleBulk(commentIds, (id) => moderateOne(userId, role, id, action));
  revalidateTouchedPosts(fulfilled);
  return { failed };
}

export async function bulkDeleteComments(commentIds: string[]): Promise<BulkResult> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const { id: userId, role } = session.user;
  const { failed, fulfilled } = await settleBulk(commentIds, (id) => deleteOne(userId, role, id));
  revalidateTouchedPosts(fulfilled);
  return { failed };
}

export async function bulkRestoreComments(commentIds: string[]): Promise<BulkResult> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const { id: userId, role } = session.user;
  const { failed, fulfilled } = await settleBulk(commentIds, (id) => restoreOne(userId, role, id));
  revalidateTouchedPosts(fulfilled);
  return { failed };
}
