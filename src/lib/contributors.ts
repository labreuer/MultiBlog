import type { JSONContent } from "@tiptap/core";
import { prisma } from "./prisma";
import { resolveAvatarSrc } from "./avatar-url";

export type Contributor = {
  id: string;
  slug: string;
  name: string;
  /** Resolved avatar `src` — self-hosted upload, else the adapter's remote URL, else null (PLAN.md §17n). */
  avatarSrc: string | null;
  color: string;
  adminInitials: string;
  orcid: string | null;
  website: string | null;
  contributorBlurb: JSONContent | null;
};

// The landing page's contributor list (PLAN.md §17e). `isListedContributor`
// is the sole membership switch — see actions/contributor.ts and
// actions/users.ts for who may flip it and in which direction.
// `contributorOrder` is nullable, so `nulls: "last"` sends anyone who has
// never set it to the tail instead of tying everyone at the front; `name`
// is the secondary sort so that tail (and any other tie) is stable rather
// than arbitrary.
export async function getContributors(): Promise<Contributor[]> {
  const rows = await prisma.user.findMany({
    where: { isListedContributor: true, name: { not: null } },
    orderBy: [{ contributorOrder: { sort: "asc", nulls: "last" } }, { name: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      image: true,
      color: true,
      adminInitials: true,
      orcid: true,
      website: true,
      contributorBlurb: true,
      // Only the hash — never `bytes`. Pulling avatar blobs into this query
      // would put every contributor's image in the RSC payload of a page
      // that then asks the browser to fetch them again by URL (PLAN.md
      // §17n). The separate table is what makes forgetting this hard, but
      // the select still has to be deliberate.
      avatar: { select: { hash: true } },
    },
  });

  // The `where` clause above already guarantees `name` is non-null; this
  // filter/cast just recovers that at the type level, mirroring
  // AuthorByline's identical narrowing over an equally-filtered query.
  return rows
    .filter((row): row is typeof row & { name: string } => row.name !== null)
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      color: row.color,
      adminInitials: row.adminInitials,
      orcid: row.orcid,
      website: row.website,
      contributorBlurb: row.contributorBlurb as JSONContent | null,
      avatarSrc: resolveAvatarSrc({ userId: row.id, avatarHash: row.avatar?.hash, image: row.image }),
    }));
}
