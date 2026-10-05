// docs/FULLTEXT.md §6, "Author" — the picker, and what a picked slug means.
//
// **The picker lists only people this viewer can already see as authors**:
// whoever is on the byline of a doc or post they may read, or wrote an
// annotation they may read, found through those kinds' own read rules. Not
// "every eligible user" the way /docs' panel is: that list is an editorial
// surface's, and a signed-out reader on /search must learn no name from it
// that no page of theirs shows.
//
// - **Labels are names**, the way public bylines show them; AuthorByline
//   leaves out a user with no name, and so does this. Never an email, which
//   the admin tables fall back to (author-filter.ts).
// - **A slug in the URL counts only if it is on this list**, the way /docs
//   checks its own, so a URL can't filter by someone the viewer can't see.
// - **Two kinds take no author.** A comment's name is fixed when its
//   commenter row is made, so filtering by an account would tie an old name
//   to a new one; a PDF has owners rather than authors, and its page names
//   none. Neither contributes names here, and an author filter leaves both out.

import { prisma } from "@/lib/prisma";
import { readableDocsWhere } from "@/lib/doc-authz";
import { readableAnnotationsWhere } from "@/lib/annotation-authz";
import { publishedPostWhere, readablePostWhere } from "@/lib/post-status";
import type { SearchKind } from "./params";
import type { SearchActor, SearchAuthorOption, SearchScope } from "./types";

/** The kinds an author filter applies to; the rest drop out while one is set. */
export const AUTHORED_KINDS: readonly SearchKind[] = ["docs", "posts", "annotations"];

export type ResolvedAuthorOption = SearchAuthorOption & { id: string };

export async function searchAuthorOptions(actor: SearchActor, scope: SearchScope): Promise<ResolvedAuthorOption[]> {
  const viewer = scope === "viewer" ? actor : null;
  // `post` is reached through a relation here, which prisma.ts's soft-delete
  // $extends doesn't follow, so a deleted post's byline is excluded by hand.
  const postWhere = viewer ? readablePostWhere(viewer.userId, viewer.role) : publishedPostWhere();
  const docWhere = viewer ? readableDocsWhere(viewer.userId, viewer.role) : null;
  const annotationWhere = viewer ? readableAnnotationsWhere(viewer.userId, viewer.role) : null;

  const [postAuthors, docAuthors, writers] = await Promise.all([
    prisma.postAuthor.groupBy({ by: ["userId"], where: { post: { AND: [postWhere, { deletedByUserId: null }] } } }),
    docWhere ? prisma.docAuthor.groupBy({ by: ["userId"], where: { doc: docWhere } }) : [],
    annotationWhere
      ? prisma.annotation.groupBy({ by: ["userId"], where: { AND: [annotationWhere, { deletedByUserId: null }] } })
      : [],
  ]);
  const ids = [...new Set([...postAuthors, ...docAuthors, ...writers].map((row) => row.userId))];
  if (ids.length === 0) return [];

  // Through `prisma`, so a deleted account drops out as it does from /docs' panel.
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, name: { not: null } },
    select: { id: true, slug: true, name: true },
  });
  return users
    .map((user) => ({ id: user.id, slug: user.slug, name: user.name!.trim() }))
    .filter((user) => user.name !== "")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
