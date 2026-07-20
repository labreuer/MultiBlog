// Create or delete throwaway posts for manual testing (e.g. exercising
// publish/unpublish/schedule, or performance/stress testing per CLAUDE.md's
// "copy content into a throwaway post rather than editing the real one"
// note). Only ever touches posts authored solely by @example.com throwaway
// accounts (see test-admin.ts) — delete refuses a post with any other
// author, so it can't touch real content even by mistake.
//
// Usage:
//   npx tsx scripts/test-post.ts create <authorEmail> [title]
//   npx tsx scripts/test-post.ts delete <slugOrId>
// authorEmail must be an existing @example.com user — create one first with
// scripts/test-admin.ts create. title defaults to "Test post <timestamp>".
// Delete posts before deleting their author with test-admin.ts delete —
// once a post's only author is gone, "no authors" is indistinguishable from
// a real post that lost its author some other way, so delete refuses it.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { uniqueSlug } from "../src/lib/slug";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

async function create(authorEmail: string, title: string) {
  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) {
    console.error(`${authorEmail} does not exist. Create it first with: npx tsx scripts/test-admin.ts create ${authorEmail}`);
    process.exitCode = 1;
    return;
  }

  const slug = await uniqueSlug(title);
  const post = await prisma.post.create({
    data: {
      slug,
      title,
      authors: { create: { userId: author.id, bylineOrder: 0 } },
      revisions: {
        create: {
          revisionNumber: 1,
          title,
          doc: EMPTY_DOC,
          editorId: author.id,
        },
      },
    },
  });
  console.log(`Created post "${post.title}" (id=${post.id}, slug=${post.slug}) by ${authorEmail}`);
  console.log(`Edit: http://localhost:3000/posts/${post.id}/edit`);
}

async function del(slugOrId: string) {
  const post = await prisma.post.findFirst({
    where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
    include: { authors: { include: { user: true } } },
  });
  if (!post) {
    console.log(`${slugOrId} does not exist, nothing to do.`);
    return;
  }

  const unsafeAuthors = post.authors.filter((a) => !SAFE_EMAIL.test(a.user.email));
  if (post.authors.length === 0 || unsafeAuthors.length > 0) {
    console.error(
      `Refusing to delete "${post.title}" (id=${post.id}) — it has ${
        post.authors.length === 0 ? "no authors" : `a non-@example.com author (${unsafeAuthors[0].user.email})`
      }.`,
    );
    process.exitCode = 1;
    return;
  }

  await prisma.post.delete({ where: { id: post.id } });
  console.log(`Deleted post "${post.title}" (id=${post.id}, slug=${post.slug}).`);
}

async function main() {
  const [cmd, arg2, ...rest] = process.argv.slice(2);

  if (cmd === "create") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-post.ts create <authorEmail> [title]");
      process.exitCode = 1;
      return;
    }
    if (!SAFE_EMAIL.test(arg2)) {
      console.error(`Refusing to author a post as "${arg2}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    const title = rest.join(" ").trim() || `Test post ${new Date().toISOString()}`;
    await create(arg2, title);
  } else if (cmd === "delete") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-post.ts delete <slugOrId>");
      process.exitCode = 1;
      return;
    }
    await del(arg2);
  } else {
    console.error("Usage: npx tsx scripts/test-post.ts <create|delete> ...");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
