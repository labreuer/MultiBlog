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
