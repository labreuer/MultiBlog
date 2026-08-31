import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import {
  parseSelector,
  targetFromColumns,
  targetKey,
  type AnchorSelector,
  type AnchorTarget,
} from "@/lib/anchors";

// docs/ANCHORED_LINKS.md — the follow path's one read: what a `?sel=` page
// may show *this viewer* of the link it names. Server-only (Prisma), the
// `tag-browse.ts` of this feature.
//
// **Per-target filtering, not a conjunctive gate** — a deliberate, recorded
// deviation from §20i's "visible only if every target is" default. §14c's
// precedent protects a surface that jointly renders two documents; a link's
// groups are independent pointers, each wearing its own target's existing
// read predicate, like /tag/[slug]'s three per-type queries. A group whose
// target is unreadable, soft-deleted, or of a kind the v1 writer never
// produces (post, annotation) is **silently omitted** — no placeholder, no
// count — which leaks nothing: the viewer cannot distinguish "references
// something I can't see" from "references nothing else". No group surviving
// returns null, and callers behave as if `?sel=` were absent.
//
// The returned view is **BigInt-free by design** (`ydocUpdateId` stays out):
// it crosses into client props on both surfaces, and a BigInt would throw in
// serialization long after this file looked done.

export type AnchoredLinkPart = {
  anchorId: string;
  partOrder: number;
  quotedText: string;
  /** DOC_RANGE offsets; null on a PDF_TEXT part (the quads live in `selector`). */
  from: number | null;
  to: number | null;
  selector: AnchorSelector | null;
};

export type AnchoredLinkTargetGroup = {
  target: AnchorTarget;
  /** The target's title, for the banner's group rows. */
  label: string;
  /** Carries `?sel=` already — doc by id (rename-proof; docs have no slug history), file by slug. */
  href: string;
  parts: AnchoredLinkPart[];
};

export type AnchoredLinkView = {
  id: string;
  groups: AnchoredLinkTargetGroup[];
};

/**
 * The link `linkId` as `viewer` may see it, or null when there is nothing to
 * show: no such row, soft-deleted, someone else's unminted draft, or no
 * group left after the per-target filter. Anchors keep their stored order
 * (`[partOrder, id]` — gaps from removals are fine); groups keep the order
 * their first part appears in.
 */
export async function anchoredLinkForViewer(
  linkId: string,
  viewer: { id: string; role: Role },
): Promise<AnchoredLinkView | null> {
  // AnchoredLink is deliberately outside prisma.ts's soft-delete $extends
  // (read through anchor includes elsewhere, which the extension cannot
  // reach — the TagAssignment reasoning), so deletedAt is filtered by hand.
  const link = await prisma.anchoredLink.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      createdById: true,
      mintedAt: true,
      deletedAt: true,
      anchors: {
        orderBy: [{ partOrder: "asc" }, { id: "asc" }],
        select: {
          id: true,
          partOrder: true,
          quotedText: true,
          anchorFrom: true,
          anchorTo: true,
          selectorKind: true,
          selector: true,
          docId: true,
          postId: true,
          fileId: true,
          targetAnnotationId: true,
        },
      },
    },
  });
  if (!link || link.deletedAt) return null;
  // An unminted draft is its creator's working set and nobody else's.
  if (!link.mintedAt && link.createdById !== viewer.id) return null;

  const byTarget = new Map<string, { target: AnchorTarget; parts: AnchoredLinkPart[] }>();
  for (const anchor of link.anchors) {
    const target = targetFromColumns(anchor);
    if (!target) continue;
    if (target.kind !== "doc" && target.kind !== "file") continue;
    let group = byTarget.get(targetKey(target));
    if (!group) {
      group = { target, parts: [] };
      byTarget.set(targetKey(target), group);
    }
    group.parts.push({
      anchorId: anchor.id,
      partOrder: anchor.partOrder,
      quotedText: anchor.quotedText,
      from: anchor.anchorFrom,
      to: anchor.anchorTo,
      // Never a cast: a blob an older writer produced is as untrusted as one
      // a client sent. An unparseable selector degrades to null, and the
      // part still lists in the banner (painted nowhere).
      selector: parseSelector(anchor.selectorKind, anchor.selector),
    });
  }

  const sel = `?sel=${encodeURIComponent(link.id)}`;
  const groups = (
    await Promise.all(
      [...byTarget.values()].map(async ({ target, parts }): Promise<AnchoredLinkTargetGroup | null> => {
        if (target.kind === "doc") {
          // prisma.doc/storedFile reads are soft-delete-filtered by the
          // $extends, so a deleted target simply comes back null here.
          const doc = await prisma.doc.findUnique({
            where: { id: target.id },
            select: { id: true, title: true, visibility: true },
          });
          if (!doc || !(await canUserReadDoc(viewer.id, viewer.role, doc))) return null;
          return { target, label: doc.title, href: `/doc/${doc.id}${sel}`, parts };
        }
        const file = await prisma.storedFile.findUnique({
          where: { id: target.id },
          select: { id: true, title: true, slug: true, visibility: true },
        });
        if (!file || !(await canUserReadFile(viewer.id, viewer.role, file))) return null;
        return { target, label: file.title, href: `/pdf/${file.slug}${sel}`, parts };
      }),
    )
  ).filter((group) => group !== null);

  return groups.length > 0 ? { id: link.id, groups } : null;
}
