// Create, list, or delete throwaway doc links and their groups for manual
// testing (PLAN.md §14). Unlike an annotation's mark, a doc link's anchor
// (DocLink.mark) is a plain JSON blob computed against a doc's *current*
// prose_json — it needs no live collab connection to create, unlike
// test-annotation.ts's read-only stance for the same reason.
//
// Usage:
//   npx tsx scripts/test-doc-link.ts create <docSlugOrId> <authorEmail> <quotedText> [--group=<groupIdOrName>]
//   npx tsx scripts/test-doc-link.ts list <docSlugOrId>
//   npx tsx scripts/test-doc-link.ts delete <linkId>
//   npx tsx scripts/test-doc-link.ts delete-group <groupIdOrName>
//
// authorEmail must be an existing @example.com user (scripts/test-user.ts
// create). quotedText must occur exactly once in the doc's current
// prose_json — findQuoteOccurrences is the same search resolveAnchor uses at
// render time, so "exactly once" here is the same requirement a real
// selection would need to resolve cleanly. --group names or ids an existing
// group (owned by an @example.com user) to add the link to; omitted, a new
// group named after the quoted text is created, owned by the same author.
//
// delete/delete-group only ever touch links/groups owned by an @example.com
// user — same containment convention as test-doc.ts/test-user.ts. Deleting
// a group deletes its links in one transaction (a link with no group is
// meaningless, PLAN.md §14h); deleting a link never touches its group.

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { resolveDocParam } from "../src/lib/resolve-doc-param";
import { pmDocContentSchema } from "../src/lib/tiptap-schema";
import { findQuoteOccurrences } from "../src/lib/quote-occurrences";
import { captureAnchor } from "../src/lib/doc-link-anchor";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;

async function create(docSlugOrId: string, authorEmail: string, quotedText: string, groupArg?: string) {
  const author = await prisma.user.findUnique({ where: { email: authorEmail } });
  if (!author) {
    console.error(`${authorEmail} does not exist. Create it first with: npx tsx scripts/test-user.ts create ${authorEmail}`);
    process.exitCode = 1;
    return;
  }

  const doc = await resolveDocParam(docSlugOrId, { id: true, title: true, proseJson: true });
  if (!doc) {
    console.error(`Doc "${docSlugOrId}" does not exist.`);
    process.exitCode = 1;
    return;
  }
  if (!doc.proseJson) {
    console.error(`Doc "${docSlugOrId}" has no prose_json yet (never edited) — nothing to anchor a link to.`);
    process.exitCode = 1;
    return;
  }

  const node = pmDocContentSchema.nodeFromJSON(doc.proseJson);
  const occurrences = findQuoteOccurrences(node, quotedText);
  if (occurrences.length !== 1) {
    console.error(
      `"${quotedText}" occurs ${occurrences.length} time(s) in "${doc.title}" — need exactly one occurrence to anchor unambiguously.`,
    );
    process.exitCode = 1;
    return;
  }

  const mark = captureAnchor(node, occurrences[0].from, occurrences[0].to);

  let group = groupArg
    ? await prisma.docLinkGroup.findFirst({
        where: { deletedAt: null, OR: [{ id: groupArg }, { name: groupArg }] },
        include: { user: true },
      })
    : null;

  if (groupArg && !group) {
    console.error(`Group "${groupArg}" does not exist.`);
    process.exitCode = 1;
    return;
  }
  if (group && !SAFE_EMAIL.test(group.user.email)) {
    console.error(`Refusing to add a link to group "${group.id}" — it's owned by a non-@example.com user.`);
    process.exitCode = 1;
    return;
  }

  if (!group) {
    group = await prisma.docLinkGroup.create({
      data: { name: quotedText.slice(0, 60), userId: author.id },
      include: { user: true },
    });
  }

  const link = await prisma.docLink.create({
    data: {
      docId: doc.id,
      mark: mark as object,
      docLinkGroupId: group.id,
      userId: author.id,
    },
  });

  console.log(
    `Created doc link ${link.id} on "${doc.title}" (group="${group.name ?? group.id}") anchored to "${mark.text}" by ${authorEmail}`,
  );
}

async function list(docSlugOrId: string) {
  const doc = await resolveDocParam(docSlugOrId, { id: true, title: true });
  if (!doc) {
    console.log(`Doc "${docSlugOrId}" does not exist, nothing to do.`);
    return;
  }

  const links = await prisma.docLink.findMany({
    where: { docId: doc.id, deletedAt: null },
    include: { user: true, group: true },
    orderBy: { createdAt: "asc" },
  });

  if (links.length === 0) {
    console.log(`No doc links on "${doc.title}".`);
    return;
  }

  for (const link of links) {
    const mark = link.mark as { text?: string } | null;
    const quoted = mark?.text ? `"${mark.text}"` : "(inline mark, no external anchor)";
    console.log(`- id=${link.id} group="${link.group.name ?? link.group.id}" by=${link.user.email} ${quoted}`);
  }
}

async function del(linkId: string) {
  const link = await prisma.docLink.findUnique({ where: { id: linkId }, include: { user: true } });
  if (!link) {
    console.log(`Doc link ${linkId} does not exist, nothing to do.`);
    return;
  }
  if (!SAFE_EMAIL.test(link.user.email)) {
    console.error(`Refusing to delete doc link ${linkId} — owned by a non-@example.com user (${link.user.email}).`);
    process.exitCode = 1;
    return;
  }
  await prisma.docLink.delete({ where: { id: linkId } });
  console.log(`Deleted doc link ${linkId}.`);
}

async function delGroup(groupIdOrName: string) {
  const group = await prisma.docLinkGroup.findFirst({
    where: { OR: [{ id: groupIdOrName }, { name: groupIdOrName }] },
    include: { user: true, links: { include: { user: true } } },
  });
  if (!group) {
    console.log(`Group "${groupIdOrName}" does not exist, nothing to do.`);
    return;
  }
  const unsafe = [group.user, ...group.links.map((l) => l.user)].filter((u) => !SAFE_EMAIL.test(u.email));
  if (unsafe.length > 0) {
    console.error(`Refusing to delete group "${group.id}" — a non-@example.com user is involved (${unsafe[0].email}).`);
    process.exitCode = 1;
    return;
  }
  await prisma.$transaction([
    prisma.docLink.deleteMany({ where: { docLinkGroupId: group.id } }),
    prisma.docLinkGroup.delete({ where: { id: group.id } }),
  ]);
  console.log(`Deleted group "${group.name ?? group.id}" and its ${group.links.length} link(s).`);
}

async function main() {
  const [cmd, arg2, arg3, arg4, ...rest] = process.argv.slice(2);

  if (cmd === "create") {
    if (!arg2 || !arg3 || !arg4) {
      console.error("Usage: npx tsx scripts/test-doc-link.ts create <docSlugOrId> <authorEmail> <quotedText> [--group=<groupIdOrName>]");
      process.exitCode = 1;
      return;
    }
    if (!SAFE_EMAIL.test(arg3)) {
      console.error(`Refusing to author a doc link as "${arg3}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    const groupFlag = rest.find((a) => a.startsWith("--group="));
    await create(arg2, arg3, arg4, groupFlag?.slice("--group=".length));
  } else if (cmd === "list") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-doc-link.ts list <docSlugOrId>");
      process.exitCode = 1;
      return;
    }
    await list(arg2);
  } else if (cmd === "delete") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-doc-link.ts delete <linkId>");
      process.exitCode = 1;
      return;
    }
    await del(arg2);
  } else if (cmd === "delete-group") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-doc-link.ts delete-group <groupIdOrName>");
      process.exitCode = 1;
      return;
    }
    await delGroup(arg2);
  } else {
    console.error("Usage: npx tsx scripts/test-doc-link.ts <create|list|delete|delete-group> ...");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
