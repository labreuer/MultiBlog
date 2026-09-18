import { prisma } from "./prisma";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_PER_COMMENTER = 5;

// PLAN.md §6: rate-limit by IP and by commenter. Reuses the ipAddress +
// createdAt that Comment already records for moderation, rather than a
// separate rate-limit table — a rolling count over the last WINDOW_MS is
// all a hobby-scale site needs.
export async function isCommentRateLimited(ipAddress: string | null, commenterId: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);

  const [ipCount, commenterCount] = await Promise.all([
    ipAddress
      ? prisma.comment.count({ where: { ipAddress, createdAt: { gte: since } } })
      : Promise.resolve(0),
    prisma.comment.count({ where: { commenterId, createdAt: { gte: since } } }),
  ]);

  return ipCount >= MAX_PER_IP || commenterCount >= MAX_PER_COMMENTER;
}

// PLAN.md §22c — the edit counterpart, and deliberately not a second call to
// the function above.
//
// That one counts `comment` rows, so it bounds *posting* and is blind to
// editing: a commenter who has posted nothing in ten minutes could rewrite an
// old comment without limit, which is the half of the abuse surface editing
// adds. Counting revisions instead bounds what editing actually produces, in
// the same window and at the same ceiling.
//
// Keyed on the *author of the edit* rather than on the comment's commenter,
// because a moderator editing other people's comments (§22f) is the one case
// where those differ, and it is the acting identity that a limit is about.
// There is no IP half: an anonymous commenter cannot edit at all (§22h), so
// every caller here is a signed-in user with a stabler key than an address.
export async function isCommentEditRateLimited(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS);
  const edits = await prisma.commentRevision.count({
    where: { authorUserId: userId, createdAt: { gte: since }, revisionNo: { gt: 1 } },
  });
  return edits >= MAX_PER_COMMENTER;
}
