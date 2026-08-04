"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted, type TransactionClient } from "@/lib/prisma";
import { uniquePostSlug, changePostSlug, revertPostSlug as revertPostSlugInDb } from "@/lib/post-slug";
import { canUserEditPost } from "@/lib/authz";
import { canUserEditDoc } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { remapThreadsToEvent } from "@/lib/anchor-remap";
import { postContentFromYdoc } from "@/lib/post-content";
import { ensureYdocSnapshotAt } from "@/lib/ydoc-snapshot";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { derivePostStatus } from "@/lib/post-status";
import { Prisma } from "@/generated/prisma/client";
import { ModerationPolicy } from "@/generated/prisma/enums";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

// Publish/unpublish change what publishedPostWhere() returns, which is what
// the home page, author pages, and the post's own page are built from — all
// three need revalidating, not just the admin-facing /posts list.
async function revalidatePublicPaths(postId: string, slug: string) {
  const authors = await prisma.postAuthor.findMany({
    where: { postId },
    select: { user: { select: { slug: true } } },
  });
  revalidatePath("/");
  revalidatePath(`/${slug}`);
  for (const { user } of authors) {
    revalidatePath(`/authors/${user.slug}`);
  }
}

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

// PLAN.md §15d — a post can be created from any doc its creator can edit,
// either from the /posts/new picker or a "Publish as blog post" button on
// /doc/[slug]. Seeds the post's authors as a copy of the doc's byline at
// creation time (post_author.createdUserId records who added each row) —
// from then on the two author lists are edited independently.
export async function createPostFromDoc(docId: string): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!(await canUserEditDoc(session.user.id, session.user.role, docId))) {
    throw new Error("You don't have permission to create a post from this doc.");
  }

  const doc = await prisma.doc.findUnique({
    where: { id: docId },
    select: {
      title: true,
      authors: { select: { userId: true, bylineOrder: true }, orderBy: { bylineOrder: "asc" } },
    },
  });
  if (!doc) {
    throw new Error("Doc not found.");
  }

  const title = docTitleOrFallback(doc.title);
  const slug = await uniquePostSlug(title);

  const post = await prisma.post.create({
    data: {
      slug,
      title,
      docId,
      authors: {
        create: doc.authors.map((a) => ({
          userId: a.userId,
          bylineOrder: a.bylineOrder,
          createdUserId: session.user.id,
        })),
      },
    },
  });

  revalidatePath("/posts");
  redirect(`/posts/${post.id}/edit`);
}

export type CreatePostFromDocState = { error?: string };

// FormData wrapper around createPostFromDoc for useActionState — deliberately
// does not try/catch the call: createPostFromDoc's redirect() at the end
// throws Next's own signal, which must propagate to useActionState untouched
// rather than being reported as a validation error (see createPostAction's
// old equivalent, same shape). A permission/not-found throw from an editable
// doc a stale picker somehow still listed is defense in depth, not a path a
// correct UI should ever actually hit.
export async function createPostFromDocAction(
  _prevState: CreatePostFromDocState,
  formData: FormData,
): Promise<CreatePostFromDocState> {
  const docId = formData.get("docId");
  if (typeof docId !== "string" || !docId) {
    return { error: "Choose a doc." };
  }
  await createPostFromDoc(docId);
  return {};
}

type PublishFromDocOpts = {
  docId: string;
  title?: string;
  // A string, not bigint: server action arguments cross the RSC boundary
  // through React's flight serialization, which doesn't carry bigint. The
  // client reads this straight off a PreparedUpdate.id.toString() (YdocDebug.tsx).
  throughUpdateId: string;
};

// Resolves (find-or-create) a ydoc_snapshot at throughUpdateId, derives the
// post's content from it (stripping the two marks a doc's ydoc carries that
// no post-side reader knows about), and returns everything a publish/schedule
// transaction needs to write. Shared by publishPostFromDoc/schedulePostFromDoc
// — PLAN.md §15b/§15d.
async function resolvePublishContent(opts: PublishFromDocOpts, userId: string) {
  const { snapshotId, doc } = await ensureYdocSnapshotAt({
    ydocId: ydocIdForDoc(opts.docId),
    throughUpdateId: BigInt(opts.throughUpdateId),
    userId,
  });
  const { proseJson, title: docTitle } = postContentFromYdoc(doc);
  doc.destroy();

  const title = opts.title?.trim() || docTitle || "Untitled";
  return { snapshotId, proseJson: proseJson as Prisma.InputJsonValue, title };
}

export async function publishPostFromDoc(postId: string, opts: PublishFromDocOpts): Promise<{ eventId: string }> {
  const { session, post } = await requireEditableSession(postId);
  if (!(await canUserEditDoc(session.user.id, session.user.role, opts.docId))) {
    throw new Error("You don't have permission to publish from this doc.");
  }

  const { snapshotId, proseJson, title } = await resolvePublishContent(opts, session.user.id);
  const now = new Date();
  // Preserve the original go-live date across an unpublish/republish with no
  // reschedule in between (post.publishedAt already in the past); otherwise
  // (never published, or currently sitting on a future scheduled date being
  // overridden) it goes live now.
  const publishedAt = post.publishedAt && post.publishedAt <= now ? post.publishedAt : now;

  const event = await prisma.$transaction(async (tx: TransactionClient) => {
    const created = await tx.postPublicationEvent.create({
      data: {
        postId,
        type: "PUBLISHED",
        docId: opts.docId,
        ydocSnapshotId: snapshotId,
        title,
        proseJson,
        actorId: session.user.id,
      },
    });
    await tx.post.update({
      where: { id: postId },
      data: { docId: opts.docId, title, proseJson, publishEventId: created.id, publishedAt },
    });
    return created;
  });

  await remapThreadsToEvent(postId, event.id);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  await revalidatePublicPaths(postId, post.slug);
  return { eventId: event.id };
}

// Scheduling is only disallowed while the post is actually *live* right now
// (derivePostStatus === "published") — a live post's currently-served
// content must never go dark while a future edit is pending. It's fine from
// draft or from an already-scheduled post (a reschedule): publishEventId is
// set immediately either way, and publishedAt (now/future) alone decides
// what's actually visible — see PLAN.md §10/§15.
export async function schedulePostFromDoc(
  postId: string,
  opts: PublishFromDocOpts & { scheduledFor: Date },
): Promise<{ eventId: string }> {
  const { session, post } = await requireEditableSession(postId);
  if (!(await canUserEditDoc(session.user.id, session.user.role, opts.docId))) {
    throw new Error("You don't have permission to publish from this doc.");
  }
  if (derivePostStatus(post) === "published") {
    throw new Error("Unpublish this post before scheduling a new version of it.");
  }
  if (opts.scheduledFor.getTime() <= Date.now()) {
    throw new Error("Scheduled time must be in the future.");
  }

  const { snapshotId, proseJson, title } = await resolvePublishContent(opts, session.user.id);

  const event = await prisma.$transaction(async (tx: TransactionClient) => {
    const created = await tx.postPublicationEvent.create({
      data: {
        postId,
        type: "SCHEDULED",
        docId: opts.docId,
        ydocSnapshotId: snapshotId,
        title,
        proseJson,
        scheduledFor: opts.scheduledFor,
        actorId: session.user.id,
      },
    });
    await tx.post.update({
      where: { id: postId },
      data: { docId: opts.docId, title, proseJson, publishEventId: created.id, publishedAt: opts.scheduledFor },
    });
    return created;
  });

  await remapThreadsToEvent(postId, event.id);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  return { eventId: event.id };
}

// Doubles as "cancel schedule": a post is published, scheduled, or draft,
// never more than one at once (derivePostStatus), so one action covers both
// non-draft starting states. publishedAt is left untouched — it's inert
// whenever publishEventId is null, so there's nothing to clean up. The
// UNPUBLISHED/SCHEDULE_CANCELED event carries none of docId/ydocSnapshotId/
// title/proseJson — it retires a version rather than introducing one.
export async function unpublishPost(postId: string): Promise<void> {
  const { session, post } = await requireEditableSession(postId);
  const status = derivePostStatus(post);
  if (status === "draft") {
    throw new Error("This post isn't published or scheduled.");
  }

  await prisma.$transaction([
    prisma.post.update({
      where: { id: postId },
      data: { publishEventId: null },
    }),
    prisma.postPublicationEvent.create({
      data: {
        postId,
        type: status === "scheduled" ? "SCHEDULE_CANCELED" : "UNPUBLISHED",
        actorId: session.user.id,
      },
    }),
  ]);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  await revalidatePublicPaths(postId, post.slug);
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
  revalidatePath(`/posts/${postId}/slug`);
  revalidatePath("/posts");
  revalidatePath(`/${oldSlug}`);
  revalidatePath(`/${slug}`);
  return { slug };
}

// Deleted by its slug value (globally unique) rather than a history row id —
// scoped to postId too so a delete call can't remove another post's entry
// even by guessing/reusing a slug string.
export async function deletePostSlugHistory(postId: string, slug: string): Promise<void> {
  await requireEditableSession(postId);
  await prisma.postSlugHistory.deleteMany({ where: { postId, slug } });
  revalidatePath(`/posts/${postId}/slug`);
}

export async function revertPostSlug(postId: string): Promise<{ slug: string }> {
  const { post } = await requireEditableSession(postId);
  const oldSlug = post.slug;
  const slug = await revertPostSlugInDb(postId);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/slug`);
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
  const { session } = await requireEditableSession(postId);

  if (included) {
    const existing = await prisma.postAuthor.findUnique({ where: { postId_userId: { postId, userId } } });
    if (existing) return;
    const maxOrder = await prisma.postAuthor.aggregate({ where: { postId }, _max: { bylineOrder: true } });
    await prisma.postAuthor.create({
      data: { postId, userId, bylineOrder: (maxOrder._max.bylineOrder ?? -1) + 1, createdUserId: session.user.id },
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

// Bulk delete/restore (PLAN.md §16g). Thin wrappers over the same per-row
// helper, so each row is authorized individually — a bulk action never gets a
// weaker check than the single-row one it batches. Rows the action doesn't
// apply to are filtered out client-side before the call (the BulkToolbar's
// `applicableTo`), which is what "silently skip a mixed selection" means in
// practice; anything that reaches here is expected to be actionable.
//
// Not a transaction, matching bulkModerateComments: a partial application on
// an authorization failure mid-batch is visible and re-runnable, and wrapping
// N independent soft-deletes in one just turns "9 of 10 worked" into "none
// did" without making the caller any better informed.
export async function bulkDeletePosts(postIds: string[]): Promise<BulkResult> {
  return settleBulk(postIds, (id) => setPostDeleted(id, true));
}

export async function bulkRestorePosts(postIds: string[]): Promise<BulkResult> {
  return settleBulk(postIds, (id) => setPostDeleted(id, false));
}
