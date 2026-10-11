"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canCurateTags } from "@/lib/role-checks";
import { canUserTagTarget } from "@/lib/tag-authz";
import { changeTagSlug, tagNameInUse } from "@/lib/tag-slug";
import { tagsForTarget, listTagOptions, type TagChip, type TagOption } from "@/lib/tag-data";
import { parseAnchorTargetKind, type AnchorTarget } from "@/lib/anchors";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import { actorFromSessionUser } from "@/lib/actor";
import {
  MAX_TAG_DESCRIPTION_LENGTH,
  applyTags,
  mintTag,
  normalizeTagName,
  removeTagAssignment,
} from "@/lib/tag-write";

// PLAN.md §20d — mutations on the tag vocabulary and on individual acts of
// tagging. Shaped like src/app/actions/files.ts, with one structural
// difference: there are **two** subjects here, not one. A *term* is shared
// vocabulary that ADMIN/EDITOR curate; an *assignment* is one person's act of
// tagging, which they own. Every export below belongs to exactly one of those
// and takes its gate from the matching half of src/lib/tag-authz.ts.
//
// Minting, applying and retracting are src/lib/tag-write.ts's, which the MCP
// server's tag tools share; curating the vocabulary is here alone.

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

/** Mints a term, or returns the existing one that already holds this name (`mintTag`). */
export async function createTag(nameInput: string, descriptionInput?: string): Promise<{ id: string; slug: string; name: string }> {
  const session = await requireTagger();
  const { id, slug, name } = await mintTag(actorFromSessionUser(session.user), nameInput, descriptionInput);
  return { id, slug, name };
}

/**
 * Applies `tagId` to one whole object, as one act of tagging.
 *
 * Throws when the term has gone — unlike `tagObjectMany`, which skips it.
 * A single deliberate click is a question about *that* term, so "it isn't
 * there any more" is the answer to it; the bulk path is a question about
 * whatever is still available, where one binned term must not fail the rest.
 */
export async function tagObject(tagId: string, targetKind: string, targetId: string): Promise<void> {
  const session = await requireTagger();
  const target = toTarget(targetKind, targetId);

  const actor = actorFromSessionUser(session.user);
  if (!(await canUserTagTarget(actor.userId, actor.role, target))) {
    throw new Error("You don't have permission to tag this.");
  }

  const tag = await prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } });
  if (!tag) {
    throw new Error("Tag not found.");
  }

  await applyTags(actor, target, [tagId]);
}

/**
 * Applies several terms to one object in a single gesture — PLAN.md §20m's
 * "Add all", and each individual chip in that offer.
 *
 * **One gate, one transaction, one revalidation.** The alternative — the
 * client calling `tagObject` n times — is n round trips, n permission
 * queries, and a half-applied strip if the fourth one fails.
 *
 * **A term that has vanished is skipped, not thrown on.** The offer this backs
 * is rendered from a server snapshot, so a term soft-deleted in between is an
 * ordinary race rather than an error; failing the whole gesture over one of
 * them would be the wrong answer to "add the rest". What actually landed is
 * visible immediately, because the caller refreshes.
 */
export async function tagObjectMany(tagIds: string[], targetKind: string, targetId: string): Promise<void> {
  const session = await requireTagger();
  const target = toTarget(targetKind, targetId);

  const actor = actorFromSessionUser(session.user);
  if (!(await canUserTagTarget(actor.userId, actor.role, target))) {
    throw new Error("You don't have permission to tag this.");
  }

  const wanted = [...new Set(tagIds)].filter((id) => typeof id === "string" && id !== "");
  if (wanted.length === 0) return;

  const terms = await prisma.tag.findMany({ where: { id: { in: wanted } }, select: { id: true } });
  if (terms.length === 0) return;

  await applyTags(actor, target, terms.map((t) => t.id));
}

/** Retracts one act of tagging: one's own, or anyone's as ADMIN/EDITOR (`removeTagAssignment`). */
export async function untagObject(assignmentId: string): Promise<void> {
  const session = await requireTagger();
  await removeTagAssignment(actorFromSessionUser(session.user), assignmentId);
}

/**
 * Renames a term, and its description with it.
 *
 * ADMIN/EDITOR only: this rewrites every chip site-wide. **The slug does not
 * follow the name**: changing a term's URL is a deliberate separate act
 * (`updateTagSlug`) rather than a side effect of fixing a typo.
 */
export async function renameTag(tagId: string, nameInput: string, descriptionInput?: string): Promise<void> {
  await requireCurator();

  const name = normalizeTagName(nameInput);
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
        : { description: descriptionInput.trim().slice(0, MAX_TAG_DESCRIPTION_LENGTH) || null }),
    },
  });
  revalidatePath("/tags");
}

/**
 * Changes a term's URL. The old one goes into `tag_slug_history`, which
 * /tag/[slug] follows, so inbound links keep landing (docs/MCP.md §11).
 */
export async function updateTagSlug(tagId: string, slugInput: string): Promise<{ slug: string }> {
  await requireCurator();
  const slug = await changeTagSlug(tagId, slugInput);
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
