// Inspect and manage PostSlugHistory/UserSlugHistory rows for manual testing
// of slug changes and the [slug]/authors/[slug] redirect fallback, without a
// one-off `psql SELECT`/`DELETE`. Same @example.com-only safety restriction
// as test-post.ts/test-user.ts — refuses to touch anything else even by
// mistake.
//
// Usage:
//   npx tsx scripts/test-slug.ts list <post|user> <slugOrIdOrEmail>
//   npx tsx scripts/test-slug.ts set <post|user> <slugOrIdOrEmail> <newSlug>
//   npx tsx scripts/test-slug.ts delete-history <post|user> <historySlug>
//
// <slugOrIdOrEmail> matches a post by id/slug, or a user by id/slug/email
// (email since that's how test-user.ts identifies users).
// list shows the entity's current slug plus every history row for it
// (slug, createdAt), oldest first.
// set changes the entity's current slug via changePostSlug/changeUserSlug
// (src/lib/post-slug.ts, src/lib/user-slug.ts) — the same path the real
// updatePostSlug/updateUserSlug actions use — recording the old slug in
// history. Supersedes test-post.ts's former standalone set-slug command
// (kept here instead so post and user slug changes share one script).
// delete-history removes a single history row by its slug value (globally
// unique across all posts, and separately across all users), freeing that
// slug up for reuse — mirrors the "delete a past slug" affordance sketched
// for the future slug-management UI (PLAN.md §4a).

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { changePostSlug } from "../src/lib/post-slug";
import { changeUserSlug } from "../src/lib/user-slug";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;

type EntityType = "post" | "user";

function parseEntityType(value: string | undefined): EntityType {
  if (value !== "post" && value !== "user") {
    throw new Error(`Entity type must be "post" or "user", got "${value ?? ""}".`);
  }
  return value;
}

async function findSafePost(slugOrId: string) {
  const post = await prisma.post.findFirst({
    where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
    include: { authors: { include: { user: true } } },
  });
  if (!post) {
    return null;
  }
  const unsafeAuthors = post.authors.filter((a) => !SAFE_EMAIL.test(a.user.email));
  if (post.authors.length === 0 || unsafeAuthors.length > 0) {
    throw new Error(
      `Refusing to touch "${post.title}" (id=${post.id}) — it has ${
        post.authors.length === 0 ? "no authors" : `a non-@example.com author (${unsafeAuthors[0].user.email})`
      }.`,
    );
  }
  return post;
}

async function findSafeUser(identifier: string) {
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: identifier }, { slug: identifier }, { email: identifier }] },
  });
  if (!user) {
    return null;
  }
  if (!SAFE_EMAIL.test(user.email)) {
    throw new Error(`Refusing to touch "${user.email}" — this script only operates on @example.com addresses.`);
  }
  return user;
}

async function list(type: EntityType, slugOrId: string) {
  if (type === "post") {
    const post = await findSafePost(slugOrId);
    if (!post) {
      console.log(`Post "${slugOrId}" does not exist, nothing to do.`);
      return;
    }
    console.log(`Post "${post.title}" (id=${post.id}) — current slug: ${post.slug}`);
    const history = await prisma.postSlugHistory.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" } });
    printHistory(history);
  } else {
    const user = await findSafeUser(slugOrId);
    if (!user) {
      console.log(`User "${slugOrId}" does not exist, nothing to do.`);
      return;
    }
    console.log(`User ${user.email} (id=${user.id}) — current slug: ${user.slug}`);
    const history = await prisma.userSlugHistory.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    printHistory(history);
  }
}

function printHistory(history: { slug: string; createdAt: Date }[]) {
  if (history.length === 0) {
    console.log("No past slugs.");
    return;
  }
  for (const h of history) {
    console.log(`  ${h.slug}  (${h.createdAt.toISOString()})`);
  }
}

async function setSlug(type: EntityType, slugOrId: string, newSlug: string) {
  if (type === "post") {
    const post = await findSafePost(slugOrId);
    if (!post) {
      console.error(`Post "${slugOrId}" does not exist.`);
      process.exitCode = 1;
      return;
    }
    const oldSlug = post.slug;
    const slug = await changePostSlug(post.id, newSlug);
    console.log(`Changed slug for post "${post.title}" (id=${post.id}) from "${oldSlug}" to "${slug}".`);
  } else {
    const user = await findSafeUser(slugOrId);
    if (!user) {
      console.error(`User "${slugOrId}" does not exist.`);
      process.exitCode = 1;
      return;
    }
    const oldSlug = user.slug;
    const slug = await changeUserSlug(user.id, newSlug);
    console.log(`Changed slug for user ${user.email} (id=${user.id}) from "${oldSlug}" to "${slug}".`);
  }
}

async function deleteHistory(type: EntityType, historySlug: string) {
  if (type === "post") {
    const entry = await prisma.postSlugHistory.findUnique({
      where: { slug: historySlug },
      include: { post: { include: { authors: { include: { user: true } } } } },
    });
    if (!entry) {
      console.log(`No PostSlugHistory row for "${historySlug}", nothing to do.`);
      return;
    }
    const unsafeAuthors = entry.post.authors.filter((a) => !SAFE_EMAIL.test(a.user.email));
    if (entry.post.authors.length === 0 || unsafeAuthors.length > 0) {
      console.error(`Refusing to touch history for "${entry.post.title}" — not solely @example.com-authored.`);
      process.exitCode = 1;
      return;
    }
    await prisma.postSlugHistory.delete({ where: { id: entry.id } });
    console.log(`Deleted history entry "${historySlug}" for post "${entry.post.title}" (id=${entry.post.id}).`);
  } else {
    const entry = await prisma.userSlugHistory.findUnique({ where: { slug: historySlug }, include: { user: true } });
    if (!entry) {
      console.log(`No UserSlugHistory row for "${historySlug}", nothing to do.`);
      return;
    }
    if (!SAFE_EMAIL.test(entry.user.email)) {
      console.error(`Refusing to touch history for "${entry.user.email}" — not an @example.com address.`);
      process.exitCode = 1;
      return;
    }
    await prisma.userSlugHistory.delete({ where: { id: entry.id } });
    console.log(`Deleted history entry "${historySlug}" for user ${entry.user.email} (id=${entry.user.id}).`);
  }
}

async function main() {
  const [cmd, typeArg, ...rest] = process.argv.slice(2);
  const usage =
    "Usage: npx tsx scripts/test-slug.ts list <post|user> <slugOrIdOrEmail>\n" +
    "       npx tsx scripts/test-slug.ts set <post|user> <slugOrIdOrEmail> <newSlug>\n" +
    "       npx tsx scripts/test-slug.ts delete-history <post|user> <historySlug>";

  if (cmd === "list") {
    const type = parseEntityType(typeArg);
    const [slugOrId] = rest;
    if (!slugOrId) {
      console.error(usage);
      process.exitCode = 1;
      return;
    }
    await list(type, slugOrId);
  } else if (cmd === "set") {
    const type = parseEntityType(typeArg);
    const [slugOrId, newSlug] = rest;
    if (!slugOrId || !newSlug) {
      console.error(usage);
      process.exitCode = 1;
      return;
    }
    await setSlug(type, slugOrId, newSlug);
  } else if (cmd === "delete-history") {
    const type = parseEntityType(typeArg);
    const [historySlug] = rest;
    if (!historySlug) {
      console.error(usage);
      process.exitCode = 1;
      return;
    }
    await deleteHistory(type, historySlug);
  } else {
    console.error(usage);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
