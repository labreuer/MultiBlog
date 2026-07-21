// Inspect comments on a post for manual testing — e.g. confirming a
// moderation-cascade or spam-check change actually changed a comment's
// resulting status, without a one-off `psql SELECT`.
//
// Usage:
//   npx tsx scripts/test-comment.ts list <slugOrId>

import "dotenv/config";
import { prisma } from "../src/lib/prisma";

async function list(slugOrId: string) {
  const post = await prisma.post.findFirst({ where: { OR: [{ id: slugOrId }, { slug: slugOrId }] } });
  if (!post) {
    console.log(`${slugOrId} does not exist, nothing to do.`);
    return;
  }

  const comments = await prisma.comment.findMany({
    where: { thread: { postId: post.id } },
    include: { commenter: true },
    orderBy: { createdAt: "asc" },
  });

  if (comments.length === 0) {
    console.log(`No comments on "${post.title}" (id=${post.id}).`);
    return;
  }

  console.log(`Comments on "${post.title}" (id=${post.id}):`);
  for (const comment of comments) {
    const text = (comment.body as { text?: string } | null)?.text ?? "";
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const deletedNote = comment.deletedAt ? " [deleted]" : "";
    console.log(
      `- ${comment.status}${deletedNote} | ${comment.commenter.displayName} <${comment.commenter.email}> | ${comment.createdAt.toISOString()} | id=${comment.id}`,
    );
    console.log(`  "${preview}"`);
  }
}

async function main() {
  const [cmd, arg2] = process.argv.slice(2);

  if (cmd === "list") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-comment.ts list <slugOrId>");
      process.exitCode = 1;
      return;
    }
    await list(arg2);
  } else {
    console.error("Usage: npx tsx scripts/test-comment.ts list <slugOrId>");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
