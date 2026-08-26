// Create, apply, list or delete throwaway tags for manual testing
// (PLAN.md §20). Same containment convention as test-doc.ts and test-file.ts:
// it only ever touches terms **created by an @example.com throwaway account**,
// and `delete` refuses a term any real account has since applied — because
// deleting a tag cascades its assignments, so a term a real user tagged
// something with is real data even though the term itself was throwaway.
//
// Usage:
//   npx tsx scripts/test-tag.ts create <creatorEmail> [--description=…] [name]
//   npx tsx scripts/test-tag.ts tag <tag> <doc|post|file|annotation> <target> <taggerEmail>
//   npx tsx scripts/test-tag.ts untag <tag> <doc|post|file|annotation> <target> <taggerEmail>
//   npx tsx scripts/test-tag.ts list [--deleted]
//   npx tsx scripts/test-tag.ts delete <slugOrId>
//
// creatorEmail and taggerEmail must be existing @example.com users — make one
// with scripts/test-user.ts create. `name` defaults to "Test tag <timestamp>".
// `<tag>` and `<target>` each take a slug or an id; an annotation has no
// slug, so that one is an id only.
//
// `tag` and `untag` write **whole-object anchors** — the only shape PR 1
// creates (§20h), and the one the tag_anchor_selector_columns_check keeps
// honest. They go through the same find-first dedup the server action does, so
// tagging twice is a no-op rather than a duplicate.
//
// This is the *fixture* path, not the action path: it writes rows directly
// rather than calling src/app/actions/tags.ts, because a script has no
// session to authorize against. That means it can create states the UI can't —
// which is the point of a fixture, and the reason the permission specs live in
// e2e/tags.spec.ts rather than here.
//
// `delete` is a **hard** delete (the row and its cascaded assignments and
// anchors), unlike the app's soft delete: throwaway data should leave nothing
// behind. Use the /tags table's own Delete button to exercise the soft path.

import "dotenv/config";
import { prisma, prismaIncludingDeleted } from "../src/lib/prisma";
import { uniqueTagSlug } from "../src/lib/tag-slug";
import { targetToColumns, parseAnchorTargetKind, type AnchorTarget } from "../src/lib/anchors";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;

function assertSafe(email: string) {
  if (!SAFE_EMAIL.test(email)) {
    throw new Error(`Refusing to touch "${email}" — this script only works with @example.com accounts.`);
  }
}

async function userByEmail(email: string) {
  assertSafe(email);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) throw new Error(`No such test user: ${email} — create one with scripts/test-user.ts create.`);
  return user;
}

async function tagByRef(ref: string) {
  const tag = await prismaIncludingDeleted.tag.findFirst({
    where: { OR: [{ id: ref }, { slug: ref }] },
    select: { id: true, slug: true, name: true, createdBy: { select: { email: true } } },
  });
  if (!tag) throw new Error(`No tag with id or slug "${ref}".`);
  return tag;
}

/** Resolves `<kind> <slugOrId>` to a real object, so a typo fails here rather than as a foreign-key error. */
async function resolveTarget(kindInput: string, ref: string): Promise<AnchorTarget> {
  const kind = parseAnchorTargetKind(kindInput);
  if (!kind) {
    throw new Error(`"${kindInput}" is not a target kind — use doc, post, file or annotation.`);
  }
  switch (kind) {
    case "doc": {
      const row = await prisma.doc.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] }, select: { id: true } });
      if (!row) throw new Error(`No doc with id or slug "${ref}".`);
      return { kind, id: row.id };
    }
    case "post": {
      const row = await prisma.post.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] }, select: { id: true } });
      if (!row) throw new Error(`No post with id or slug "${ref}".`);
      return { kind, id: row.id };
    }
    case "file": {
      const row = await prisma.storedFile.findFirst({
        where: { OR: [{ id: ref }, { slug: ref }] },
        select: { id: true },
      });
      if (!row) throw new Error(`No file with id or slug "${ref}".`);
      return { kind, id: row.id };
    }
    case "annotation": {
      // No slug to fall back on — an annotation is only ever addressed by id.
      const row = await prisma.annotation.findUnique({ where: { id: ref }, select: { id: true } });
      if (!row) throw new Error(`No annotation with id "${ref}".`);
      return { kind, id: row.id };
    }
  }
}

async function create(args: string[]) {
  const [creatorEmail, ...rest] = args;
  if (!creatorEmail) throw new Error("Usage: create <creatorEmail> [--description=…] [name]");
  const creator = await userByEmail(creatorEmail);

  let description: string | null = null;
  const words: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("--description=")) description = arg.slice("--description=".length);
    else words.push(arg);
  }
  const name = words.join(" ").trim() || `Test tag ${Date.now()}`;

  const tag = await prisma.tag.create({
    data: { slug: await uniqueTagSlug(name), name, description, createdById: creator.id },
    select: { id: true, slug: true, name: true },
  });
  console.log(`Created tag "${tag.name}"  id=${tag.id}  /tag/${tag.slug}`);
}

async function tag(args: string[]) {
  const [tagRef, kind, targetRef, taggerEmail] = args;
  if (!tagRef || !kind || !targetRef || !taggerEmail) {
    throw new Error("Usage: tag <tag> <doc|post|file|annotation> <target> <taggerEmail>");
  }
  const tag = await tagByRef(tagRef);
  const target = await resolveTarget(kind, targetRef);
  const tagger = await userByEmail(taggerEmail);
  const columns = targetToColumns(target);

  const already = await prisma.tagAnchor.findFirst({
    where: { ...columns, assignment: { tagId: tag.id, userId: tagger.id, deletedAt: null } },
    select: { id: true },
  });
  if (already) {
    console.log(`"${tag.name}" is already on that ${target.kind} from ${tagger.email} — nothing to do.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const assignment = await tx.tagAssignment.create({
      data: { tagId: tag.id, userId: tagger.id },
      select: { id: true },
    });
    await tx.tagAnchor.create({ data: { assignmentId: assignment.id, ...columns } });
  });
  console.log(`Tagged ${target.kind} ${target.id} with "${tag.name}" as ${tagger.email}.`);
}

async function untag(args: string[]) {
  const [tagRef, kind, targetRef, taggerEmail] = args;
  if (!tagRef || !kind || !targetRef || !taggerEmail) {
    throw new Error("Usage: untag <tag> <doc|post|file|annotation> <target> <taggerEmail>");
  }
  const tag = await tagByRef(tagRef);
  const target = await resolveTarget(kind, targetRef);
  const tagger = await userByEmail(taggerEmail);

  const anchor = await prisma.tagAnchor.findFirst({
    where: {
      ...targetToColumns(target),
      assignment: { tagId: tag.id, userId: tagger.id, deletedAt: null },
    },
    select: { assignmentId: true },
  });
  if (!anchor) {
    console.log(`"${tag.name}" isn't on that ${target.kind} from ${tagger.email}.`);
    return;
  }
  // Soft delete, matching untagObject — the fixture's job is to produce the
  // states the app produces, and "retracted tag" is one of them.
  await prisma.tagAssignment.update({
    where: { id: anchor.assignmentId },
    data: { deletedByUserId: tagger.id, deletedAt: new Date() },
  });
  console.log(`Removed "${tag.name}" from ${target.kind} ${target.id}.`);
}

async function list(args: string[]) {
  const includeDeleted = args.includes("--deleted");
  const tags = await prismaIncludingDeleted.tag.findMany({
    where: includeDeleted ? {} : { deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      deletedAt: true,
      createdBy: { select: { email: true } },
      metrics: { select: { assignmentCount: true, docCount: true, postCount: true, fileCount: true } },
    },
  });
  if (tags.length === 0) {
    console.log("No tags.");
    return;
  }
  for (const k of tags) {
    const m = k.metrics;
    const usage = m ? `${m.assignmentCount} tag(s): ${m.docCount}d ${m.postCount}p ${m.fileCount}f` : "unused";
    const flags = [k.deletedAt ? "DELETED" : null, SAFE_EMAIL.test(k.createdBy.email) ? null : "REAL"]
      .filter(Boolean)
      .join(" ");
    console.log(`${k.id}  ${k.name.padEnd(28)}  /tag/${k.slug.padEnd(24)}  ${usage.padEnd(28)} ${flags}`);
  }
}

async function remove(args: string[]) {
  const [ref] = args;
  if (!ref) throw new Error("Usage: delete <slugOrId>");
  const tag = await tagByRef(ref);

  // Containment, first half: the term itself must be throwaway.
  if (!SAFE_EMAIL.test(tag.createdBy.email)) {
    throw new Error(
      `Refusing to delete "${tag.name}" — it was created by ${tag.createdBy.email}, not an @example.com account.`,
    );
  }

  // Containment, second half, and the one that isn't obvious: deleting a
  // tag cascades its assignments, so a throwaway term that a *real*
  // account has since applied to something is no longer throwaway data. There
  // is no flag to widen this; retract the real tags first if you mean it.
  const foreign = await prismaIncludingDeleted.tagAssignment.findMany({
    where: { tagId: tag.id, deletedAt: null, user: { email: { not: { contains: "@example.com" } } } },
    select: { user: { select: { email: true } } },
    take: 5,
  });
  if (foreign.length > 0) {
    const who = [...new Set(foreign.map((a) => a.user.email))].join(", ");
    throw new Error(
      `Refusing to delete "${tag.name}" — it has live tags from ${who}. ` +
        `Deleting the term would cascade those away.`,
    );
  }

  await prismaIncludingDeleted.tag.delete({ where: { id: tag.id } });
  console.log(`Deleted tag "${tag.name}" and its assignments.`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "create":
      return create(args);
    case "tag":
      return tag(args);
    case "untag":
      return untag(args);
    case "list":
      return list(args);
    case "delete":
      return remove(args);
    default:
      console.error(
        "Usage:\n" +
          "  npx tsx scripts/test-tag.ts create <creatorEmail> [--description=…] [name]\n" +
          "  npx tsx scripts/test-tag.ts tag <tag> <doc|post|file|annotation> <target> <taggerEmail>\n" +
          "  npx tsx scripts/test-tag.ts untag <tag> <doc|post|file|annotation> <target> <taggerEmail>\n" +
          "  npx tsx scripts/test-tag.ts list [--deleted]\n" +
          "  npx tsx scripts/test-tag.ts delete <slugOrId>",
      );
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
