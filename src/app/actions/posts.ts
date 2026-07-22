"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import { uniquePostSlug, changePostSlug } from "@/lib/post-slug";
import { canManagePosts, canUserEditPost } from "@/lib/authz";
import { remapThreadsToRevision } from "@/lib/anchor-remap";
import { stripMarkFromDoc } from "@/lib/tiptap-schema";
import { docsEqual } from "@/lib/diff";
import { derivePostStatus } from "@/lib/post-status";
import { Prisma } from "@/generated/prisma/client";
import { ModerationPolicy } from "@/generated/prisma/enums";
import type { JSONContent } from "@tiptap/core";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

async function requireEditableSession(postId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    throw new Error("Post not found.");
  }

  if (!(await canUserEditPost(session.user.id, session.user.role, postId))) {
    throw new Error("You don't have permission to edit this post.");
  }

  return { session, post };
}

export type CreatePostState = { error?: string };

export async function createPostAction(
  _prevState: CreatePostState,
  formData: FormData,
): Promise<CreatePostState> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManagePosts(session.user.role)) {
    return { error: "You don't have permission to create posts." };
  }

  const title = formData.get("title");
  if (typeof title !== "string" || !title.trim()) {
    return { error: "Title is required." };
  }
  const trimmedTitle = title.trim();

  const slug = await uniquePostSlug(trimmedTitle);
  const post = await prisma.post.create({
    data: {
      slug,
      title: trimmedTitle,
      authors: { create: { userId: session.user.id, bylineOrder: 0 } },
      revisions: {
        create: {
          revisionNumber: 1,
          title: trimmedTitle,
          doc: EMPTY_DOC,
          editorId: session.user.id,
        },
      },
    },
  });

  redirect(`/posts/${post.id}/edit`);
}

// Creates a new revision unless title+doc are identical to the latest one
// (order-independent — see docsEqual), in which case the existing latest
// revision is reused untouched. Shared by saveDraft/publishPost/schedulePost
// so "save/publish/schedule with no real change" never grows the revision
// history. Must run inside the same transaction as any Post update that
// depends on the result, so it takes a transaction client rather than the
// module-level `prisma`.
async function resolveRevision(
  tx: TransactionClient,
  postId: string,
  title: string,
  doc: Prisma.InputJsonValue,
  editorId: string,
  changelog?: string,
): Promise<{ id: string; revisionNumber: number; created: boolean }> {
  const latest = await tx.revision.findFirst({ where: { postId }, orderBy: { revisionNumber: "desc" } });
  if (latest && latest.title === title && docsEqual(latest.doc, doc)) {
    return { id: latest.id, revisionNumber: latest.revisionNumber, created: false };
  }

  const revisionNumber = (latest?.revisionNumber ?? 0) + 1;
  const revision = await tx.revision.create({
    data: { postId, revisionNumber, title, doc, editorId, changelog: changelog?.trim() || undefined },
  });
  return { id: revision.id, revisionNumber, created: true };
}

export async function saveDraft(
  postId: string,
  title: string,
  doc: Prisma.InputJsonValue,
): Promise<{ revisionNumber: number; created: boolean }> {
  const { session } = await requireEditableSession(postId);
  const cleanDoc = stripMarkFromDoc(doc as JSONContent, "authorHighlight") as Prisma.InputJsonValue;

  const revision = await prisma.$transaction(async (tx) => {
    const result = await resolveRevision(tx, postId, title, cleanDoc, session.user.id);
    await tx.post.update({ where: { id: postId }, data: { title } });
    await tx.postCollabUpdate.deleteMany({ where: { postId } });
    return result;
  });

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  return { revisionNumber: revision.revisionNumber, created: revision.created };
}

export async function publishPost(
  postId: string,
  title: string,
  doc: Prisma.InputJsonValue,
  changelog?: string,
): Promise<{ revisionNumber: number; created: boolean }> {
  const { session, post } = await requireEditableSession(postId);
  const cleanDoc = stripMarkFromDoc(doc as JSONContent, "authorHighlight") as Prisma.InputJsonValue;
  const now = new Date();
  // Preserve the original go-live date across an unpublish/republish with no
  // reschedule in between (post.publishedAt already in the past); otherwise
  // (never published, or currently sitting on a future scheduled date being
  // overridden) it goes live now.
  const publishedAt = post.publishedAt && post.publishedAt <= now ? post.publishedAt : now;

  const revision = await prisma.$transaction(async (tx) => {
    const result = await resolveRevision(tx, postId, title, cleanDoc, session.user.id, changelog);
    await tx.post.update({
      where: { id: postId },
      data: { title, publishRevisionId: result.id, publishedAt },
    });
    await tx.postCollabUpdate.deleteMany({ where: { postId } });
    await tx.postPublicationEvent.create({
      data: { postId, type: "PUBLISHED", revisionId: result.id, actorId: session.user.id },
    });
    return result;
  });

  await remapThreadsToRevision(postId, revision.id);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  return { revisionNumber: revision.revisionNumber, created: revision.created };
}

// Scheduling is only disallowed while the post is actually *live* right now
// (derivePostStatus === "published") — a live post's currently-served
// content must never go dark while a future edit is pending. It's fine from
// draft or from an already-scheduled post (a reschedule): publishRevisionId
// is set immediately either way, and publishedAt (now/future) alone decides
// what's actually visible — see PLAN.md §10.
export async function schedulePost(
  postId: string,
  title: string,
  doc: Prisma.InputJsonValue,
  scheduledFor: Date,
  changelog?: string,
): Promise<{ revisionNumber: number; created: boolean }> {
  const { session, post } = await requireEditableSession(postId);
  if (derivePostStatus(post) === "published") {
    throw new Error("Unpublish this post before scheduling a new version of it.");
  }
  if (scheduledFor.getTime() <= Date.now()) {
    throw new Error("Scheduled time must be in the future.");
  }
  const cleanDoc = stripMarkFromDoc(doc as JSONContent, "authorHighlight") as Prisma.InputJsonValue;

  const revision = await prisma.$transaction(async (tx) => {
    const result = await resolveRevision(tx, postId, title, cleanDoc, session.user.id, changelog);
    await tx.post.update({
      where: { id: postId },
      data: { title, publishRevisionId: result.id, publishedAt: scheduledFor },
    });
    await tx.postCollabUpdate.deleteMany({ where: { postId } });
    await tx.postPublicationEvent.create({
      data: { postId, type: "SCHEDULED", revisionId: result.id, scheduledFor, actorId: session.user.id },
    });
    return result;
  });

  await remapThreadsToRevision(postId, revision.id);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  return { revisionNumber: revision.revisionNumber, created: revision.created };
}

// Doubles as "cancel schedule": a post is published, scheduled, or draft,
// never more than one at once (derivePostStatus), so one action covers both
// non-draft starting states. publishedAt is left untouched — it's inert
// whenever publishRevisionId is null, so there's nothing to clean up.
export async function unpublishPost(postId: string): Promise<void> {
  const { session, post } = await requireEditableSession(postId);
  const status = derivePostStatus(post);
  if (status === "draft") {
    throw new Error("This post isn't published or scheduled.");
  }

  await prisma.$transaction([
    prisma.post.update({
      where: { id: postId },
      data: { publishRevisionId: null },
    }),
    prisma.postPublicationEvent.create({
      data: {
        postId,
        type: status === "scheduled" ? "SCHEDULE_CANCELED" : "UNPUBLISHED",
        revisionId: post.publishRevisionId,
        actorId: session.user.id,
      },
    }),
  ]);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  revalidatePath(`/${post.slug}`);
}

// Soft delete/restore double as each other's undo — no confirmation dialog;
// the row stays visible in the admin table with the icon swapped, so a
// mis-click is one more click to reverse instead of a modal to dismiss.
// Reuses the same edit permission as the rest of the post actions rather
// than requireEditableSession, since that helper goes through the ordinary
// (soft-delete-filtered) `prisma` client and would make an already-deleted
// post unfindable, restore impossible. The existence check below
// deliberately uses `prismaIncludingDeleted` instead.
async function setPostDeleted(postId: string, deleted: boolean): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const post = await prismaIncludingDeleted.post.findUnique({ where: { id: postId } });
  if (!post) {
    throw new Error("Post not found.");
  }
  if (!(await canUserEditPost(session.user.id, session.user.role, postId))) {
    throw new Error("You don't have permission to delete this post.");
  }
  await prisma.post.update({
    where: { id: postId },
    data: deleted ? { deletedByUserId: session.user.id, deletedAt: new Date() } : { deletedByUserId: null, deletedAt: null },
  });
  revalidatePath("/posts");
}

export async function deletePost(postId: string): Promise<void> {
  await setPostDeleted(postId, true);
}

export async function restorePost(postId: string): Promise<void> {
  await setPostDeleted(postId, false);
}

export async function updatePostModerationPolicy(postId: string, moderationPolicy: ModerationPolicy): Promise<void> {
  await requireEditableSession(postId);
  if (!Object.values(ModerationPolicy).includes(moderationPolicy)) {
    throw new Error("Invalid moderation policy.");
  }
  await prisma.post.update({ where: { id: postId }, data: { moderationPolicy } });
  revalidatePath(`/posts/${postId}/edit`);
}

export async function updatePostSlug(postId: string, newSlug: string): Promise<{ slug: string }> {
  const { post } = await requireEditableSession(postId);
  const oldSlug = post.slug;
  const slug = await changePostSlug(postId, newSlug);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath("/posts");
  revalidatePath(`/${oldSlug}`);
  revalidatePath(`/${slug}`);
  return { slug };
}

// Adds/removes a single PostAuthor row rather than replacing the whole set,
// so toggling one checkbox can't clobber another editor's concurrent change
// to a different author. New rows go after the current max bylineOrder,
// preserving the existing byline order instead of reshuffling it.
export async function updatePostAuthor(postId: string, userId: string, included: boolean): Promise<void> {
  await requireEditableSession(postId);

  if (included) {
    const existing = await prisma.postAuthor.findUnique({ where: { postId_userId: { postId, userId } } });
    if (existing) return;
    const maxOrder = await prisma.postAuthor.aggregate({ where: { postId }, _max: { bylineOrder: true } });
    await prisma.postAuthor.create({
      data: { postId, userId, bylineOrder: (maxOrder._max.bylineOrder ?? -1) + 1 },
    });
  } else {
    const count = await prisma.postAuthor.count({ where: { postId } });
    if (count <= 1) {
      throw new Error("A post must have at least one author.");
    }
    await prisma.postAuthor.delete({ where: { postId_userId: { postId, userId } } }).catch(() => {});
  }

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath("/posts");
}

// Reassigns bylineOrder to match orderedUserIds' sequence (0-indexed), for
// drag-and-drop reordering in the settings panel. orderedUserIds must be
// exactly the post's current author set — a mismatch means the author list
// changed (e.g. another editor's concurrent toggle) since the drag started,
// so this bails rather than silently dropping/duplicating a row.
export async function updatePostAuthorOrder(postId: string, orderedUserIds: string[]): Promise<void> {
  await requireEditableSession(postId);

  const current = await prisma.postAuthor.findMany({ where: { postId }, select: { userId: true } });
  const currentIds = new Set(current.map((a) => a.userId));
  if (orderedUserIds.length !== currentIds.size || orderedUserIds.some((id) => !currentIds.has(id))) {
    throw new Error("Author list changed — please retry.");
  }

  await prisma.$transaction(
    orderedUserIds.map((userId, bylineOrder) =>
      prisma.postAuthor.update({ where: { postId_userId: { postId, userId } }, data: { bylineOrder } }),
    ),
  );

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath("/posts");
}

export async function restoreRevision(
  postId: string,
  revisionNumber: number,
): Promise<{ newRevisionNumber: number }> {
  const { session } = await requireEditableSession(postId);

  const source = await prisma.revision.findUnique({
    where: { postId_revisionNumber: { postId, revisionNumber } },
  });
  if (!source) {
    throw new Error("Revision not found.");
  }

  const latest = await prisma.revision.findFirst({
    where: { postId },
    orderBy: { revisionNumber: "desc" },
    select: { revisionNumber: true },
  });
  const newRevisionNumber = (latest?.revisionNumber ?? 0) + 1;

  await prisma.$transaction([
    prisma.revision.create({
      data: {
        postId,
        revisionNumber: newRevisionNumber,
        title: source.title,
        doc: source.doc as Prisma.InputJsonValue,
        editorId: session.user.id,
        changelog: `Restored from revision ${revisionNumber}`,
      },
    }),
    prisma.post.update({ where: { id: postId }, data: { title: source.title } }),
  ]);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  return { newRevisionNumber };
}
