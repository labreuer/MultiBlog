import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { postPath } from "@/lib/post-path";
import { canApplyTags } from "@/lib/role-checks";
import { canUserRemoveAssignment, canUserTagTarget } from "@/lib/tag-authz";
import { tagNameInUse, uniqueTagSlug } from "@/lib/tag-slug";
import { targetFromColumns, targetToColumns, type AnchorTarget } from "@/lib/anchors";
import { ApiError, forbidden, invalid } from "@/lib/api/errors";
import type { Actor } from "@/lib/actor";

// PLAN.md §20d, docs/MCP.md §11 — minting a term, applying terms to a whole
// object, and retracting one act of tagging, as plain functions taking an
// explicit actor: the tag actions (src/app/actions/tags.ts) wrap them with
// the session, the MCP server's `tag` and `untag` with a token's user. Each
// refusal is an ApiError, whose message reads the same in either front door.
//
// PR 1 writes **whole-object anchors only** (§20h): one assignment, one
// anchor, all four part columns null. Nothing here takes a range, and the
// tag_anchor_selector_columns_check makes that structural rather than merely
// true today.

export const MAX_TAG_NAME_LENGTH = 80;
export const MAX_TAG_DESCRIPTION_LENGTH = 500;

/** A term's name as stored: trimmed, inner whitespace collapsed, capped. */
export function normalizeTagName(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_NAME_LENGTH);
}

/**
 * The page whose chips change when `target` is tagged — what
 * `revalidatePath` is pointed at (§20d's cache rule).
 *
 * `/tag/[slug]` deliberately gets no revalidation: it renders dynamic,
 * because it is permission-shaped per viewer and ISR would be wrong for it
 * whatever the freshness story. An annotation has no page of its own; its
 * container's is the closest thing, and PR 1 has no annotation chip UI anyway.
 */
async function pathForTarget(target: AnchorTarget): Promise<string | null> {
  switch (target.kind) {
    case "doc": {
      const doc = await prisma.doc.findUnique({ where: { id: target.id }, select: { slug: true } });
      return doc ? `/doc/${doc.slug}` : null;
    }
    case "post": {
      // A draft has no public page to revalidate (§21): null, same as a miss.
      const post = await prisma.post.findUnique({ where: { id: target.id }, select: { slug: true, publishedAt: true } });
      return post?.publishedAt ? postPath(post) : null;
    }
    case "file": {
      const file = await prisma.storedFile.findUnique({ where: { id: target.id }, select: { slug: true } });
      return file ? `/pdf/${file.slug}` : null;
    }
    case "annotation":
      return null;
    case "comment": {
      // A comment's page is its post's (PLAN.md §23c); no chip UI targets a
      // comment yet, so this is the arm the union demands, not a live path.
      const comment = await prisma.comment.findUnique({
        where: { id: target.id },
        select: { thread: { select: { post: { select: { slug: true, publishedAt: true } } } } },
      });
      return comment?.thread.post.publishedAt ? postPath(comment.thread.post) : null;
    }
  }
}

/**
 * Mints a term, or returns the existing one that already holds this name.
 *
 * Find-first rather than error-on-collision: from the tagger's side "add the
 * tag Epistemology" means the same thing whether or not somebody typed it
 * first, and making the second person handle an error for succeeding is
 * friction with nothing behind it. The *name* is what identifies a term
 * (case-insensitively, per `tag_name_lower_key`), not the slug. `created`
 * says which it was.
 */
export async function mintTag(
  actor: Actor,
  nameInput: string,
  descriptionInput?: string,
): Promise<{ id: string; slug: string; name: string; created: boolean }> {
  if (!canApplyTags(actor.role)) throw forbidden("Your account doesn't have permission to apply tags.");
  const name = normalizeTagName(nameInput);
  if (!name) throw invalid("A tag needs a name.");

  const existing = await prisma.tag.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, slug: true, name: true },
  });
  if (existing) return { ...existing, created: false };

  // A soft-deleted term still holds its name in the index, so a collision here
  // is real even though the term is invisible. Reporting it beats letting the
  // create die on a raw P2002 — and telling the user to ask an admin to
  // restore it beats silently resurrecting a term somebody deliberately binned.
  if (await tagNameInUse(name)) {
    throw new ApiError("conflict", `"${name}" already exists as a deleted tag — an admin or editor can restore it.`);
  }

  const description = descriptionInput?.trim().slice(0, MAX_TAG_DESCRIPTION_LENGTH) || null;
  const tag = await prisma.tag.create({
    data: { slug: await uniqueTagSlug(name), name, description, createdById: actor.userId },
    select: { id: true, slug: true, name: true },
  });
  revalidatePath("/tags");
  return { ...tag, created: true };
}

/**
 * Applies terms to one whole object as one act of tagging: the gate, then
 * the assignment+anchor pairs in one transaction — **the one writer of
 * whole-object anchors**, so the shape PR 1 may write (§20h: every part
 * column unset) is stated once.
 *
 * **Dedup is app-level find-first** (§20c): same tag, same object, same user
 * means no second assignment, and re-tagging is a no-op rather than an error.
 * The DB-enforced version needs `tag_id` denormalised onto the anchor for a
 * partial unique index, and is deferred until concurrent tagging of one object
 * by one person is a thing that happens (§20i) — today the losing race just
 * leaves a duplicate chip, which `tagsForTarget` collapses anyway.
 *
 * **One transaction for the whole gesture** (§20g), which is what makes "Add
 * all" all-or-nothing rather than a row-at-a-time bulk with a partial result
 * to report. Deliberately not `settleBulk`: that shape is for an admin table
 * acting on rows a user selected independently. Callers have checked the
 * terms exist. Returns the ids newly applied.
 */
export async function applyTags(actor: Actor, target: AnchorTarget, tagIds: readonly string[]): Promise<string[]> {
  if (!(await canUserTagTarget(actor.userId, actor.role, target))) {
    throw forbidden("You don't have permission to tag this.");
  }
  const columns = targetToColumns(target);
  const already = await prisma.tagAnchor.findMany({
    where: { ...columns, assignment: { tagId: { in: [...tagIds] }, userId: actor.userId, deletedAt: null } },
    select: { assignment: { select: { tagId: true } } },
  });
  const done = new Set(already.map((a) => a.assignment.tagId));
  const pending = [...new Set(tagIds)].filter((id) => !done.has(id));
  if (pending.length === 0) return [];

  await prisma.$transaction(async (tx) => {
    for (const tagId of pending) {
      const assignment = await tx.tagAssignment.create({ data: { tagId, userId: actor.userId }, select: { id: true } });
      // Every part column left unset — the whole-object row, the only shape PR 1 writes.
      await tx.tagAnchor.create({ data: { assignmentId: assignment.id, ...columns } });
    }
  });

  const path = await pathForTarget(target);
  if (path) revalidatePath(path);
  revalidatePath("/tags");
  return pending;
}

/**
 * Retracts one act of tagging: one's own, or anyone's as ADMIN/EDITOR.
 *
 * Soft-deletes the **assignment** and leaves its anchors alone: an anchor is
 * part of a record rather than a record, and has no soft delete of its own
 * (§20c).
 */
export async function removeTagAssignment(actor: Actor, assignmentId: string): Promise<void> {
  const assignment = await prisma.tagAssignment.findFirst({
    where: { id: assignmentId, deletedAt: null },
    select: {
      userId: true,
      anchors: {
        select: { docId: true, postId: true, fileId: true, targetAnnotationId: true, targetCommentId: true },
        take: 1,
      },
    },
  });
  if (!assignment) throw new ApiError("not_found", "Tag not found.");
  if (!canUserRemoveAssignment(actor.userId, actor.role, assignment.userId)) {
    throw forbidden("You can only remove your own tags.");
  }

  await prisma.tagAssignment.update({
    where: { id: assignmentId },
    data: { deletedByUserId: actor.userId, deletedAt: new Date() },
  });

  // One anchor is enough to find the page whose chips changed: PR 1 writes
  // exactly one per assignment. A multi-part act (PR 2) spans several targets
  // and will need every distinct page revalidated, not the first.
  const anchor = assignment.anchors[0];
  const target = anchor ? targetFromColumns(anchor) : null;
  if (target) {
    const path = await pathForTarget(target);
    if (path) revalidatePath(path);
  }
  revalidatePath("/tags");
}
