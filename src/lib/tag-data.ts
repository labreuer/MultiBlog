import { prisma } from "@/lib/prisma";
import { targetToColumns, type AnchorTarget } from "@/lib/anchors";

// PLAN.md §20d — the reads behind tag chips.
//
// **One indexed `tag_anchor` lookup per object page**, by the arc column
// that object's kind uses, joined through live assignments to live terms. That
// is the whole cost the doc/post/PDF pages pay for chips: a constant query
// count, no N+1, on tables sized like `annotation` (§20g).
//
// **These do no permission work of their own, on purpose.** Each caller has
// already passed its page's own access check before it gets here — the doc
// page through canUserReadDoc, the PDF page through canUserReadFile, the post
// page through publishedPostWhere — so a PRIVATE doc's chips are as private as
// the doc, by construction rather than by a second gate that could disagree
// with the first. The one thing that would break that is calling these from a
// surface that *hasn't* gated yet, which is why they take a resolved
// `AnchorTarget` rather than a slug.

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
