// Create or delete throwaway posts for manual testing (e.g. exercising
// publish/unpublish/schedule, or performance/stress testing per CLAUDE.md's
// "copy content into a throwaway post rather than editing the real one"
// note). Only ever touches posts authored solely by @example.com throwaway
// accounts (see test-user.ts) — delete refuses a post with any other
// author, so it can't touch real content even by mistake.
//
// Usage:
//   npx tsx scripts/test-post.ts create <authorEmail> [--policy=INHERIT|AUTO|ALWAYS] [--publish] [title]
//   npx tsx scripts/test-post.ts delete <slugOrId>
// authorEmail must be an existing @example.com user — create one first with
// scripts/test-user.ts create. title defaults to "Test post <timestamp>".
// --policy overrides the default AUTO moderation policy (e.g. ALWAYS, to
// test that something else — an ADMIN commenter, a trust threshold — still
// overrides the cascade). --publish sets publishRevisionId/publishedAt at
// creation instead of leaving the post a draft, replacing the one-off
// "publish this throwaway post" scripts that otherwise get hand-written and
// deleted per session.
// Delete posts before deleting their author with test-user.ts delete —
// once a post's only author is gone, "no authors" is indistinguishable from
// a real post that lost its author some other way, so delete refuses it.
// To change a post's slug (or inspect/prune its PostSlugHistory), see
// scripts/test-slug.ts instead.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { uniquePostSlug } from "../src/lib/post-slug";
import { ModerationPolicy } from "../src/generated/prisma/enums";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
const POLICY_VALUES = Object.values(ModerationPolicy);

function parseCreateArgs(args: string[]): { title: string; policy: ModerationPolicy; publish: boolean } {
  const titleWords: string[] = [];
  let policy: ModerationPolicy = "AUTO";
  let publish = false;

  for (const arg of args) {
    if (arg === "--publish") {
      publish = true;
    } else if (arg.startsWith("--policy=")) {
      const value = arg.slice("--policy=".length).toUpperCase();
      if (!POLICY_VALUES.includes(value as ModerationPolicy)) {
        throw new Error(`Invalid --policy value "${value}" — must be one of ${POLICY_VALUES.join(", ")}.`);
      }
      policy = value as ModerationPolicy;
    } else {
      titleWords.push(arg);
    }
  }

  return { title: titleWords.join(" ").trim(), policy, publish };
}

async function create(authorEmail: string, title: string, policy: ModerationPolicy, publish: boolean) {
  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) {
    console.error(`${authorEmail} does not exist. Create it first with: npx tsx scripts/test-user.ts create ${authorEmail}`);
    process.exitCode = 1;
    return;
  }

  const slug = await uniquePostSlug(title);
  const now = new Date();
  const post = await prisma.post.create({
    data: {
      slug,
      title,
      moderationPolicy: policy,
      authors: { create: { userId: author.id, bylineOrder: 0 } },
      revisions: {
        create: {
          revisionNumber: 1,
          title,
          doc: EMPTY_DOC,
          editorId: author.id,
        },
      },
      ...(publish ? { publishedAt: now } : {}),
    },
    include: { revisions: true },
  });

  if (publish) {
    // publishRevisionId can't be set in the same nested create above — the
    // revision's id doesn't exist until after it's created.
    await prisma.post.update({
      where: { id: post.id },
      data: { publishRevisionId: post.revisions[0].id },
    });
  }

  console.log(
    `Created ${publish ? "published " : ""}post "${post.title}" (id=${post.id}, slug=${post.slug}) by ${authorEmail}, moderationPolicy=${policy}`,
  );
  console.log(publish ? `View: http://localhost:3000/${post.slug}` : `Edit: http://localhost:3000/posts/${post.id}/edit`);
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
      console.error("Usage: npx tsx scripts/test-post.ts create <authorEmail> [--policy=INHERIT|AUTO|ALWAYS] [--publish] [title]");
      process.exitCode = 1;
      return;
    }
    if (!SAFE_EMAIL.test(arg2)) {
      console.error(`Refusing to author a post as "${arg2}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    const { title, policy, publish } = parseCreateArgs(rest);
    await create(arg2, title || `Test post ${new Date().toISOString()}`, policy, publish);
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
