// Create, apply, list or delete throwaway keywords for manual testing
// (PLAN.md §20). Same containment convention as test-doc.ts and test-file.ts:
// it only ever touches terms **created by an @example.com throwaway account**,
// and `delete` refuses a term any real account has since applied — because
// deleting a keyword cascades its assignments, so a term a real user tagged
// something with is real data even though the term itself was throwaway.
//
// Usage:
//   npx tsx scripts/test-keyword.ts create <creatorEmail> [--description=…] [name]
//   npx tsx scripts/test-keyword.ts tag <keyword> <doc|post|file|annotation> <target> <taggerEmail>
//   npx tsx scripts/test-keyword.ts untag <keyword> <doc|post|file|annotation> <target> <taggerEmail>
//   npx tsx scripts/test-keyword.ts list [--deleted]
//   npx tsx scripts/test-keyword.ts delete <slugOrId>
//
// creatorEmail and taggerEmail must be existing @example.com users — make one
// with scripts/test-user.ts create. `name` defaults to "Test keyword <timestamp>".
// `<keyword>` and `<target>` each take a slug or an id; an annotation has no
// slug, so that one is an id only.
//
// `tag` and `untag` write **whole-object anchors** — the only shape PR 1
// creates (§20h), and the one the keyword_anchor_selector_columns_check keeps
// honest. They go through the same find-first dedup the server action does, so
// tagging twice is a no-op rather than a duplicate.
//
// This is the *fixture* path, not the action path: it writes rows directly
// rather than calling src/app/actions/keywords.ts, because a script has no
// session to authorize against. That means it can create states the UI can't —
// which is the point of a fixture, and the reason the permission specs live in
// e2e/keywords.spec.ts rather than here.
//
// `delete` is a **hard** delete (the row and its cascaded assignments and
// anchors), unlike the app's soft delete: throwaway data should leave nothing
// behind. Use the /keywords table's own Delete button to exercise the soft path.

import "dotenv/config";
import { prisma, prismaIncludingDeleted } from "../src/lib/prisma";
import { uniqueKeywordSlug } from "../src/lib/keyword-slug";
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

async function keywordByRef(ref: string) {
  const keyword = await prismaIncludingDeleted.keyword.findFirst({
    where: { OR: [{ id: ref }, { slug: ref }] },
    select: { id: true, slug: true, name: true, createdBy: { select: { email: true } } },
  });
  if (!keyword) throw new Error(`No keyword with id or slug "${ref}".`);
  return keyword;
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
  const name = words.join(" ").trim() || `Test keyword ${Date.now()}`;

  const keyword = await prisma.keyword.create({
    data: { slug: await uniqueKeywordSlug(name), name, description, createdById: creator.id },
    select: { id: true, slug: true, name: true },
  });
  console.log(`Created keyword "${keyword.name}"  id=${keyword.id}  /keyword/${keyword.slug}`);
}

async function tag(args: string[]) {
  const [keywordRef, kind, targetRef, taggerEmail] = args;
  if (!keywordRef || !kind || !targetRef || !taggerEmail) {
    throw new Error("Usage: tag <keyword> <doc|post|file|annotation> <target> <taggerEmail>");
  }
  const keyword = await keywordByRef(keywordRef);
  const target = await resolveTarget(kind, targetRef);
  const tagger = await userByEmail(taggerEmail);
  const columns = targetToColumns(target);

  const already = await prisma.keywordAnchor.findFirst({
    where: { ...columns, assignment: { keywordId: keyword.id, userId: tagger.id, deletedAt: null } },
    select: { id: true },
  });
  if (already) {
    console.log(`"${keyword.name}" is already on that ${target.kind} from ${tagger.email} — nothing to do.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    const assignment = await tx.keywordAssignment.create({
      data: { keywordId: keyword.id, userId: tagger.id },
      select: { id: true },
    });
    await tx.keywordAnchor.create({ data: { assignmentId: assignment.id, ...columns } });
  });
  console.log(`Tagged ${target.kind} ${target.id} with "${keyword.name}" as ${tagger.email}.`);
}

async function untag(args: string[]) {
  const [keywordRef, kind, targetRef, taggerEmail] = args;
  if (!keywordRef || !kind || !targetRef || !taggerEmail) {
    throw new Error("Usage: untag <keyword> <doc|post|file|annotation> <target> <taggerEmail>");
  }
  const keyword = await keywordByRef(keywordRef);
  const target = await resolveTarget(kind, targetRef);
  const tagger = await userByEmail(taggerEmail);

  const anchor = await prisma.keywordAnchor.findFirst({
    where: {
      ...targetToColumns(target),
      assignment: { keywordId: keyword.id, userId: tagger.id, deletedAt: null },
    },
    select: { assignmentId: true },
  });
  if (!anchor) {
    console.log(`"${keyword.name}" isn't on that ${target.kind} from ${tagger.email}.`);
    return;
  }
  // Soft delete, matching untagObject — the fixture's job is to produce the
  // states the app produces, and "retracted tag" is one of them.
  await prisma.keywordAssignment.update({
    where: { id: anchor.assignmentId },
    data: { deletedByUserId: tagger.id, deletedAt: new Date() },
  });
  console.log(`Removed "${keyword.name}" from ${target.kind} ${target.id}.`);
}

async function list(args: string[]) {
  const includeDeleted = args.includes("--deleted");
  const keywords = await prismaIncludingDeleted.keyword.findMany({
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
  if (keywords.length === 0) {
    console.log("No keywords.");
    return;
  }
  for (const k of keywords) {
    const m = k.metrics;
    const usage = m ? `${m.assignmentCount} tag(s): ${m.docCount}d ${m.postCount}p ${m.fileCount}f` : "unused";
    const flags = [k.deletedAt ? "DELETED" : null, SAFE_EMAIL.test(k.createdBy.email) ? null : "REAL"]
      .filter(Boolean)
      .join(" ");
    console.log(`${k.id}  ${k.name.padEnd(28)}  /keyword/${k.slug.padEnd(24)}  ${usage.padEnd(28)} ${flags}`);
  }
}

async function remove(args: string[]) {
  const [ref] = args;
  if (!ref) throw new Error("Usage: delete <slugOrId>");
  const keyword = await keywordByRef(ref);

  // Containment, first half: the term itself must be throwaway.
  if (!SAFE_EMAIL.test(keyword.createdBy.email)) {
    throw new Error(
      `Refusing to delete "${keyword.name}" — it was created by ${keyword.createdBy.email}, not an @example.com account.`,
    );
  }

  // Containment, second half, and the one that isn't obvious: deleting a
  // keyword cascades its assignments, so a throwaway term that a *real*
  // account has since applied to something is no longer throwaway data. There
  // is no flag to widen this; retract the real tags first if you mean it.
  const foreign = await prismaIncludingDeleted.keywordAssignment.findMany({
    where: { keywordId: keyword.id, deletedAt: null, user: { email: { not: { contains: "@example.com" } } } },
    select: { user: { select: { email: true } } },
    take: 5,
  });
  if (foreign.length > 0) {
    const who = [...new Set(foreign.map((a) => a.user.email))].join(", ");
    throw new Error(
      `Refusing to delete "${keyword.name}" — it has live tags from ${who}. ` +
        `Deleting the term would cascade those away.`,
    );
  }

  await prismaIncludingDeleted.keyword.delete({ where: { id: keyword.id } });
  console.log(`Deleted keyword "${keyword.name}" and its assignments.`);
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
          "  npx tsx scripts/test-keyword.ts create <creatorEmail> [--description=…] [name]\n" +
          "  npx tsx scripts/test-keyword.ts tag <keyword> <doc|post|file|annotation> <target> <taggerEmail>\n" +
          "  npx tsx scripts/test-keyword.ts untag <keyword> <doc|post|file|annotation> <target> <taggerEmail>\n" +
          "  npx tsx scripts/test-keyword.ts list [--deleted]\n" +
          "  npx tsx scripts/test-keyword.ts delete <slugOrId>",
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
