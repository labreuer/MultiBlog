// Create or delete throwaway posts for manual testing (e.g. exercising
// publish/unpublish/schedule, or performance/stress testing per CLAUDE.md's
// "copy content into a throwaway post rather than editing the real one"
// note). Only ever touches posts authored solely by @example.com throwaway
// accounts (see test-user.ts) — delete refuses a post with any other
// author, so it can't touch real content even by mistake.
//
// Usage:
//   npx tsx scripts/test-post.ts create <authorEmail> --doc=<docSlugOrId> [--policy=INHERIT|AUTO|ALWAYS] [--publish] [title]
//   npx tsx scripts/test-post.ts delete <slugOrId>
// authorEmail must be an existing @example.com user — create one first with
// scripts/test-user.ts create. --doc is required (PLAN.md §15 — a post is
// always a snapshot of some doc); create one first with scripts/test-doc.ts.
// title defaults to the doc's own title. --policy overrides the default AUTO
// moderation policy (e.g. ALWAYS, to test that something else — an ADMIN
// commenter, a trust threshold — still overrides the cascade). --publish
// snapshots the doc's current head and publishes at creation instead of
// leaving the post a draft, replacing the one-off "publish this throwaway
// post" scripts that otherwise get hand-written and deleted per session.
// Delete posts before deleting their author with test-user.ts delete —
// once a post's only author is gone, "no authors" is indistinguishable from
// a real post that lost its author some other way, so delete refuses it.
// Delete posts before deleting their doc with test-doc.ts delete, for the
// same reason — Post.docId has no ON DELETE CASCADE (PLAN.md §15).
// To change a post's slug (or inspect/prune its PostSlugHistory), see
// scripts/test-slug.ts instead.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { uniquePostSlug } from "../src/lib/post-slug";
import { docTitleOrFallback } from "../src/lib/doc-title";
import { postContentFromYdoc } from "../src/lib/post-content";
import { ensureYdocSnapshotAt } from "../src/lib/ydoc-snapshot";
import { ydocIdForDoc } from "../src/lib/ydoc-names";
import { ydocStore } from "../server/ydoc-store";
import { ModerationPolicy } from "../src/generated/prisma/enums";
import type { Prisma } from "../src/generated/prisma/client";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const POLICY_VALUES = Object.values(ModerationPolicy);

function parseCreateArgs(args: string[]): { title: string; policy: ModerationPolicy; publish: boolean; docRef: string | null } {
  const titleWords: string[] = [];
  let policy: ModerationPolicy = "AUTO";
  let publish = false;
  let docRef: string | null = null;

  for (const arg of args) {
    if (arg === "--publish") {
      publish = true;
    } else if (arg.startsWith("--policy=")) {
      const value = arg.slice("--policy=".length).toUpperCase();
      if (!POLICY_VALUES.includes(value as ModerationPolicy)) {
        throw new Error(`Invalid --policy value "${value}" — must be one of ${POLICY_VALUES.join(", ")}.`);
      }
      policy = value as ModerationPolicy;
    } else if (arg.startsWith("--doc=")) {
      docRef = arg.slice("--doc=".length);
    } else {
      titleWords.push(arg);
    }
  }

  return { title: titleWords.join(" ").trim(), policy, publish, docRef };
}

async function create(authorEmail: string, docRef: string | null, title: string, policy: ModerationPolicy, publish: boolean) {
  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) {
    console.error(`${authorEmail} does not exist. Create it first with: npx tsx scripts/test-user.ts create ${authorEmail}`);
    process.exitCode = 1;
    return;
  }

  if (!docRef) {
    console.error("Missing --doc=<slugOrId>. Create one first with: npx tsx scripts/test-doc.ts create <authorEmail>");
    process.exitCode = 1;
    return;
  }
  const doc = await prisma.doc.findFirst({ where: { OR: [{ id: docRef }, { slug: docRef }] } });
  if (!doc) {
    console.error(`Doc "${docRef}" does not exist.`);
    process.exitCode = 1;
    return;
  }

  const postTitle = title || docTitleOrFallback(doc.title);
  const slug = await uniquePostSlug(postTitle);
  const post = await prisma.post.create({
    data: {
      slug,
      title: postTitle,
      docId: doc.id,
      moderationPolicy: policy,
      authors: { create: { userId: author.id, bylineOrder: 0, createdUserId: author.id } },
    },
  });

  if (publish) {
    const throughUpdateId = await ydocStore.maxUpdateId(ydocIdForDoc(doc.id));
    if (throughUpdateId === null) {
      console.error(`Doc "${docRef}" has no edit history yet — nothing to publish. Edit it first, or omit --publish.`);
      process.exitCode = 1;
      return;
    }
    const { snapshotId, doc: materialized } = await ensureYdocSnapshotAt({
      ydocId: ydocIdForDoc(doc.id),
      throughUpdateId,
      userId: author.id,
    });
    const { proseJson, title: docContentTitle } = postContentFromYdoc(materialized);
    materialized.destroy();
    const publishedTitle = postTitle || docContentTitle || "Untitled";

    const event = await prisma.postPublicationEvent.create({
      data: {
        postId: post.id,
        type: "PUBLISHED",
        docId: doc.id,
        ydocSnapshotId: snapshotId,
        title: publishedTitle,
        proseJson: proseJson as Prisma.InputJsonValue,
        actorId: author.id,
      },
    });
    await prisma.post.update({
      where: { id: post.id },
      data: { title: publishedTitle, proseJson: proseJson as Prisma.InputJsonValue, publishEventId: event.id, publishedAt: new Date() },
    });
  }

  console.log(
    `Created ${publish ? "published " : ""}post "${postTitle}" (id=${post.id}, slug=${post.slug}) by ${authorEmail}, doc=${doc.id}, moderationPolicy=${policy}`,
  );
  console.log(publish ? `View: http://localhost:3000/${slug}` : `Edit: http://localhost:3000/posts/${post.id}/edit`);
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
      console.error("Usage: npx tsx scripts/test-post.ts create <authorEmail> --doc=<docSlugOrId> [--policy=INHERIT|AUTO|ALWAYS] [--publish] [title]");
      process.exitCode = 1;
      return;
    }
    if (!SAFE_EMAIL.test(arg2)) {
      console.error(`Refusing to author a post as "${arg2}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    const { title, policy, publish, docRef } = parseCreateArgs(rest);
    await create(arg2, docRef, title, policy, publish);
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
