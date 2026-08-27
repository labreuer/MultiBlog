"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canApplyTags, canCurateTags } from "@/lib/role-checks";
import { canUserRemoveAssignment, canUserTagTarget } from "@/lib/tag-authz";
import { tagNameInUse, uniqueTagSlug } from "@/lib/tag-slug";
import { tagsForTarget, listTagOptions, type TagChip, type TagOption } from "@/lib/tag-data";
import { targetToColumns, targetFromColumns, parseAnchorTargetKind, type AnchorTarget } from "@/lib/anchors";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

// PLAN.md §20d — mutations on the tag vocabulary and on individual acts of
// tagging. Shaped like src/app/actions/files.ts, with one structural
// difference: there are **two** subjects here, not one. A *term* is shared
// vocabulary that ADMIN/EDITOR curate; an *assignment* is one person's act of
// tagging, which they own. Every export below belongs to exactly one of those
// and takes its gate from the matching half of src/lib/tag-authz.ts.
//
// PR 1 writes **whole-object anchors only** (§20h): one assignment, one anchor,
// all four part columns null. Nothing here takes a range, and the
// tag_anchor_selector_columns_check makes that structural rather than
// merely true today.

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;

async function requireTagger() {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  return session;
}

async function requireCurator() {
  const session = await requireTagger();
  if (!canCurateTags(session.user.role)) {
    throw new Error("Only an admin or editor can manage tag terms.");
  }
  return session;
}

/**
 * Rebuilds an `AnchorTarget` from the two loose strings a client form can send.
 *
 * The kind goes through `parseAnchorTargetKind` rather than a cast — the
 * §20b convention that nothing untrusted reaches a column unparsed. The *id* is
 * not validated here on purpose: `canUserTagTarget` is about to look it up, and
 * an id naming nothing fails there as "you may not tag this", which is the
 * right answer and reveals nothing about what exists.
 */
function toTarget(kind: string, id: string): AnchorTarget {
  const parsed = parseAnchorTargetKind(kind);
  if (!parsed) {
    throw new Error(`"${kind}" is not something a tag can be attached to.`);
  }
  if (typeof id !== "string" || id === "") {
    throw new Error("Missing the object to tag.");
  }
  return { kind: parsed, id };
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
      const post = await prisma.post.findUnique({ where: { id: target.id }, select: { slug: true } });
      return post ? `/${post.slug}` : null;
    }
    case "file": {
      const file = await prisma.storedFile.findUnique({ where: { id: target.id }, select: { slug: true } });
      return file ? `/pdf/${file.slug}` : null;
    }
    case "annotation":
      return null;
  }
}

/**
 * Everything the tagger panel needs, in one round trip, fetched when someone
 * actually opens it.
 *
 * Not props on the page, deliberately. The vocabulary is the whole tag
 * table and `own` is a per-viewer read; paying for either on every doc, post
 * and PDF render — for a control most readers never touch — would be a query
 * nobody asked for. More importantly it keeps the page components free of
 * anything session-shaped, which is what lets the public post page stay
 * statically generated (PLAN.md §12f: a route with generateStaticParams that
 * also calls a dynamic API throws DYNAMIC_SERVER_USAGE at build).
 *
 * `canTag` is returned rather than thrown on, so the panel can say "you can't
 * tag this" instead of showing an error. It is not the security boundary —
 * `tagObject` and `untagObject` re-ask independently, and they are what a
 * client calling straight past this would hit.
 */
export type TaggerState = {
  canTag: boolean;
  options: TagOption[];
  /**
   * Every term on this object, by anyone, exactly as the chips render them —
   * `ownAssignmentId` included, which is what says whether this viewer may
   * retract it (§20c: an assignment is its author's). One array rather than an
   * id list plus a separate "yours" list; §20k has why.
   */
  applied: TagChip[];
};

export async function loadTaggerState(targetKind: string, targetId: string): Promise<TaggerState> {
  const session = await requireTagger();
  const target = toTarget(targetKind, targetId);

  if (!(await canUserTagTarget(session.user.id, session.user.role, target))) {
    return { canTag: false, options: [], applied: [] };
  }

  const [options, chips] = await Promise.all([
    listTagOptions(),
    tagsForTarget(target, session.user.id),
  ]);

  return { canTag: true, options, applied: chips };
}

/**
 * Mints a term, or returns the existing one that already holds this name.
 *
 * Find-first rather than error-on-collision: from the tagger's side "add the
 * tag Epistemology" means the same thing whether or not somebody typed it
 * first, and making the second person handle an error for succeeding is
 * friction with nothing behind it. The *name* is what identifies a term
 * (case-insensitively, per `tag_name_lower_key`), not the slug.
 */
export async function createTag(nameInput: string, descriptionInput?: string): Promise<{ id: string; slug: string; name: string }> {
  const session = await requireTagger();
  if (!canApplyTags(session.user.role)) {
    throw new Error("Your account doesn't have permission to apply tags.");
  }

  const name = nameInput.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  if (!name) {
    throw new Error("A tag needs a name.");
  }

  const existing = await prisma.tag.findFirst({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { id: true, slug: true, name: true },
  });
  if (existing) return existing;

  // A soft-deleted term still holds its name in the index, so a collision here
  // is real even though the term is invisible. Reporting it beats letting the
  // create die on a raw P2002 — and telling the user to ask an admin to
  // restore it beats silently resurrecting a term somebody deliberately binned.
  if (await tagNameInUse(name)) {
    throw new Error(`"${name}" already exists as a deleted tag — an admin or editor can restore it.`);
  }

  const description = descriptionInput?.trim().slice(0, MAX_DESCRIPTION_LENGTH) || null;
  const tag = await prisma.tag.create({
    data: { slug: await uniqueTagSlug(name), name, description, createdById: session.user.id },
    select: { id: true, slug: true, name: true },
  });
  revalidatePath("/tags");
  return tag;
}

/**
 * Applies `tagId` to one whole object, as one act of tagging.
 *
 * **Dedup is app-level find-first** (§20c): same tag, same object, same
 * user means no second assignment, and re-tagging is a no-op rather than an
 * error. The DB-enforced version needs `tag_id` denormalised onto the
 * anchor for a partial unique index, and is deferred until concurrent tagging
 * of one object by one person is a thing that happens (§20i) — today the
 * losing race just leaves a duplicate chip, which `tagsForTarget`
 * collapses anyway.
 *
 * The write is **one transaction**: owner row plus its anchors (§20g). One
 * anchor here; PR 2's part-tagging adds rows to the same transaction, not a
 * second concept.
 */
export async function tagObject(tagId: string, targetKind: string, targetId: string): Promise<void> {
  const session = await requireTagger();
  const target = toTarget(targetKind, targetId);

  if (!(await canUserTagTarget(session.user.id, session.user.role, target))) {
    throw new Error("You don't have permission to tag this.");
  }

  const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } });
  if (!tag) {
    throw new Error("Tag not found.");
  }

  const columns = targetToColumns(target);
  const already = await prisma.tagAnchor.findFirst({
    where: {
      ...columns,
      assignment: { tagId, userId: session.user.id, deletedAt: null },
    },
    select: { id: true },
  });
  if (already) return;

  await prisma.$transaction(async (tx) => {
    const assignment = await tx.tagAssignment.create({
      data: { tagId, userId: session.user.id },
      select: { id: true },
    });
    await tx.tagAnchor.create({
      // Every part column left unset — this is the whole-object row, and the
      // only shape PR 1 writes.
      data: { assignmentId: assignment.id, ...columns },
    });
  });

  const path = await pathForTarget(target);
  if (path) revalidatePath(path);
  revalidatePath("/tags");
}

/**
 * Retracts one act of tagging.
 *
 * Soft-deletes the **assignment** and leaves its anchors alone: an anchor is
 * part of a record rather than a record, and has no soft delete of its own
 * (§20c). Removing one *part* of a multi-part act deletes that anchor row —
 * PR 2's concern, and a different function when it arrives.
 */
export async function untagObject(assignmentId: string): Promise<void> {
  const session = await requireTagger();

  const assignment = await prisma.tagAssignment.findFirst({
    where: { id: assignmentId, deletedAt: null },
    select: {
      userId: true,
      anchors: { select: { docId: true, postId: true, fileId: true, targetAnnotationId: true }, take: 1 },
    },
  });
  if (!assignment) {
    throw new Error("Tag not found.");
  }
  if (!canUserRemoveAssignment(session.user.id, session.user.role, assignment.userId)) {
    throw new Error("You can only remove your own tags.");
  }

  await prisma.tagAssignment.update({
    where: { id: assignmentId },
    data: { deletedByUserId: session.user.id, deletedAt: new Date() },
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

/**
 * Renames a term, and its description with it.
 *
 * ADMIN/EDITOR only: this rewrites every chip site-wide. **The slug does not
 * follow the name** — there is no slug history table (§20c/§20i), so
 * re-slugging here would break every existing `/tag/…` link with nothing
 * to redirect them. Changing the URL is therefore a deliberate separate act
 * (`updateTagSlug`) rather than a side effect of fixing a typo.
 */
export async function renameTag(tagId: string, nameInput: string, descriptionInput?: string): Promise<void> {
  await requireCurator();

  const name = nameInput.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
  if (!name) {
    throw new Error("A tag needs a name.");
  }
  if (await tagNameInUse(name, tagId)) {
    throw new Error(`Another tag is already called "${name}".`);
  }

  await prismaIncludingDeleted.tag.update({
    where: { id: tagId },
    data: {
      name,
      ...(descriptionInput === undefined
        ? {}
        : { description: descriptionInput.trim().slice(0, MAX_DESCRIPTION_LENGTH) || null }),
    },
  });
  revalidatePath("/tags");
}

/**
 * Changes a term's URL, knowingly breaking inbound links to the old one.
 *
 * Separated from `renameTag` precisely so that cost is chosen rather than
 * incurred. The first time a tag URL is shared somewhere durable is the
 * trigger condition for building `tag_slug_history` (§20i), at which point
 * this becomes `changeDocSlug`'s twin and the warning goes away.
 */
export async function updateTagSlug(tagId: string, slugInput: string): Promise<{ slug: string }> {
  await requireCurator();
  const slug = await uniqueTagSlug(slugInput, tagId);
  await prismaIncludingDeleted.tag.update({ where: { id: tagId }, data: { slug } });
  revalidatePath("/tags");
  return { slug };
}

async function setTagDeleted(tagId: string, deleted: boolean): Promise<void> {
  const session = await requireCurator();
  // prismaIncludingDeleted, so restoring a deleted term can find it — the same
  // reason setFileDeleted and setDocDeleted use it.
  const tag = await prismaIncludingDeleted.tag.findUnique({
    where: { id: tagId },
    select: { id: true },
  });
  if (!tag) {
    throw new Error("Tag not found.");
  }
  await prismaIncludingDeleted.tag.update({
    where: { id: tagId },
    data: deleted
      ? { deletedByUserId: session.user.id, deletedAt: new Date() }
      : { deletedByUserId: null, deletedAt: null },
  });
  revalidatePath("/tags");
}

/**
 * Soft-deletes a term, retracting every chip it draws.
 *
 * Its assignments are deliberately left alone rather than cascaded or
 * soft-deleted alongside: they record who applied this term to what, and a
 * restore has to bring exactly that back. What hides the term is that every
 * *reader* filters on its own `deleted_at` — `tagsForTarget`'s nested
 * `tag: { deletedAt: null }`, and the `$extends` filter everywhere the
 * model is read top-level — so a deleted term draws no chips and answers no
 * `/tag/[slug]` while its history stays intact. That is the whole
 * difference between a soft delete and a hard one.
 *
 * Note `tag_metrics` does *not* filter on it, and needn't: the view is
 * keyed on tag_id and joined per row, so a deleted term's usage numbers
 * simply travel with the row `/tags` is already only showing under "show
 * deleted".
 */
export async function deleteTag(tagId: string): Promise<void> {
  await setTagDeleted(tagId, true);
}

export async function restoreTag(tagId: string): Promise<void> {
  await setTagDeleted(tagId, false);
}

// Per-row rather than one transaction — see bulkDeletePosts for the rationale.
export async function bulkDeleteTags(tagIds: string[]): Promise<BulkResult> {
  return settleBulk(tagIds, (id) => setTagDeleted(id, true));
}

export async function bulkRestoreTags(tagIds: string[]): Promise<BulkResult> {
  return settleBulk(tagIds, (id) => setTagDeleted(id, false));
}
