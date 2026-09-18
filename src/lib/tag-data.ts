import { prisma } from "@/lib/prisma";
import { targetToColumns, type AnchorTarget } from "@/lib/anchors";

// PLAN.md §20d — the reads behind tag chips.
//
// **One indexed `tag_anchor` lookup per object page**, by the arc column
// that object's kind uses, joined through live assignments to live terms. That
// is the whole cost a page pays for chips: a constant query count, no N+1, on
// tables sized like `annotation` (§20g).
//
// **These do no permission work of their own, on purpose.** Each caller has
// already passed its page's own access check before it gets here — so a
// PRIVATE doc's chips are as private as the doc, by construction rather than
// by a second gate that could disagree with the first. The one thing that
// would break that is calling these from a surface that *hasn't* gated yet,
// which is why they take a resolved `AnchorTarget` rather than a slug.

export type TagChip = {
  /** The tag, not the assignment — what the chip links to. */
  id: string;
  slug: string;
  name: string;
  /**
   * This viewer's own assignment on this object, if any — what makes the chip
   * removable without a second round trip. Null when the tag is someone else's
   * (or when no viewer was supplied).
   */
  ownAssignmentId: string | null;
  /** How many people have applied this term to this object. */
  taggerCount: number;
};

/**
 * Every live term applied to one object, alphabetically.
 *
 * Soft-deleted assignments are excluded **by hand**: `tagAssignment`
 * deliberately does not join src/lib/prisma.ts's `$extends` filter, because
 * that filter intercepts top-level operations only and this is a nested read
 * (§20c). Every query in this file that touches an assignment therefore says
 * `deletedAt: null` itself. Soft-deleted *tags* need no such clause — that
 * model does join the filter — but the nested `tag` relation here is
 * likewise out of the filter's reach, so it is stated too. Both are the kind
 * of thing that is invisible when wrong.
 */
export async function tagsForTarget(target: AnchorTarget, viewerId?: string): Promise<TagChip[]> {
  const columns = targetToColumns(target);
  const anchors = await prisma.tagAnchor.findMany({
    where: {
      // Exactly one of these is non-null, so this is the one indexed
      // equality plus three IS NULL tests — not a four-way OR.
      docId: columns.docId,
      postId: columns.postId,
      fileId: columns.fileId,
      targetAnnotationId: columns.targetAnnotationId,
      targetCommentId: columns.targetCommentId,
      assignment: {
        deletedAt: null,
        tag: { deletedAt: null },
      },
    },
    select: {
      assignment: {
        select: {
          id: true,
          userId: true,
          tag: { select: { id: true, slug: true, name: true } },
        },
      },
    },
  });

  // Collapsed in JS rather than with a `groupBy`: the result set is one row per
  // (term, tagger) on a single object — single digits in practice — and the
  // grouping has to produce a per-viewer field a SQL aggregate can't name.
  const byTag = new Map<string, TagChip>();
  for (const { assignment } of anchors) {
    const term = assignment.tag;
    const existing = byTag.get(term.id);
    if (existing) {
      existing.taggerCount += 1;
      if (viewerId && assignment.userId === viewerId) existing.ownAssignmentId = assignment.id;
      continue;
    }
    byTag.set(term.id, {
      id: term.id,
      slug: term.slug,
      name: term.name,
      ownAssignmentId: viewerId && assignment.userId === viewerId ? assignment.id : null,
      taggerCount: 1,
    });
  }

  return [...byTag.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type TagOption = { id: string; slug: string; name: string };

/**
 * The vocabulary a tagger's picker offers.
 *
 * Every live term, unfiltered by permission — deliberately. A *term* is not
 * content: it carries no visibility of its own, and knowing that "Epistemology"
 * exists reveals nothing about what has been tagged with it. What is gated is
 * the browse page behind each chip, per type, per row (§20d).
 */
export async function listTagOptions(): Promise<TagOption[]> {
  return prisma.tag.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** One term by its slug, or null. Soft-deleted terms read as absent (the `$extends` filter). */
export async function tagBySlug(slug: string) {
  return prisma.tag.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, description: true },
  });
}

/**
 * The terms on `source` that aren't on `target` yet — PLAN.md §20m, behind the
 * post editor's "From the doc" offer.
 *
 * **Returns `TagOption`, not `TagChip`, and that is the point.** A chip's
 * `ownAssignmentId` and `taggerCount` describe the *source* object, and
 * rendering either beside a control that writes to the *target* would be a
 * number answering a question nobody asked. What carries across is the term
 * and nothing else: applying one here is a fresh act of tagging by this
 * viewer, not a copy of someone else's.
 *
 * Subtracts every term already on the target, by anyone — not just this
 * viewer's. The same rule the tagger's picker wears when it disables an
 * option as "Already applied here": a chip appears once per object however
 * many people reached for it, so offering it again would offer to change
 * nothing visible.
 *
 * **It does no permission work**, like everything else in this file — but the
 * gate its caller owes is a *different* one from the usual. Every other read
 * here is called from the page of the object being read, so the page's own
 * check covers it. This one discloses one object's tags on another object's
 * page, so the caller must run the **source's** read gate as well
 * (`canUserReadDoc` in /post/[id]/edit's case) — docs/PERMISSIONS.md's Tags
 * section states it, and §20i's "cross-container visibility is conjunctive
 * when it comes up" is what it resolves.
 */
export async function tagsNotYetOn(source: AnchorTarget, target: AnchorTarget): Promise<TagOption[]> {
  const [onSource, onTarget] = await Promise.all([tagsForTarget(source), tagsForTarget(target)]);
  const here = new Set(onTarget.map((chip) => chip.id));
  return onSource.filter((chip) => !here.has(chip.id)).map(({ id, slug, name }) => ({ id, slug, name }));
}
