// Inspect annotations on a doc for manual testing — the doc-side sibling of
// test-comment.ts, same "list, don't create" shape: a script-created
// annotation would have no mark (submitAnnotation's mark-application step
// needs a live collab connection a script doesn't have), so it would only
// ever be able to produce the document-level state, of limited value beyond
// what already exists. Showing whether each root annotation resolves to a
// real quote or has degraded to document-level (PLAN.md §12h) needs the
// same collectMarkAttrValues/extractMarkedText pass comment-data.ts's
// getDocAnnotationsAsThreads does — reading it here rather than a one-off
// `psql SELECT` is the whole point of this script.
//
// Usage:
//   npx tsx scripts/test-annotation.ts list <docSlugOrId>

import "dotenv/config";
import type { JSONContent } from "@tiptap/core";
import { prisma } from "../src/lib/prisma";
import { collectMarkAttrValues, extractMarkedText } from "../src/lib/tiptap-schema";

async function list(slugOrId: string) {
  const doc = await prisma.doc.findFirst({ where: { OR: [{ id: slugOrId }, { slug: slugOrId }] } });
  if (!doc) {
    console.log(`${slugOrId} does not exist, nothing to do.`);
    return;
  }

  const annotations = await prisma.annotation.findMany({
    where: { docId: doc.id },
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (annotations.length === 0) {
    console.log(`No annotations on "${doc.title}" (id=${doc.id}).`);
    return;
  }

  const proseJson = doc.proseJson as JSONContent | null;
  const markedIds = new Set(proseJson ? collectMarkAttrValues(proseJson, "annotation", "id") : []);

  console.log(`Annotations on "${doc.title}" (id=${doc.id}):`);
  for (const annotation of annotations) {
    const text = (annotation.body as { text?: string } | null)?.text ?? "";
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    const status = annotation.deletedAt ? "deleted" : "active";
    const replyNote = annotation.parentAnnotationId ? ` reply-to=${annotation.parentAnnotationId}` : "";
    const quoteNote =
      !annotation.parentAnnotationId && proseJson && markedIds.has(annotation.id)
        ? ` "${extractMarkedText(proseJson, "annotation", "id", annotation.id)}"`
        : !annotation.parentAnnotationId
          ? " [document-level]"
          : "";
    console.log(
      `- ${status}${replyNote} | ${annotation.user.name ?? annotation.user.email} | ${annotation.createdAt.toISOString()} | id=${annotation.id}${quoteNote}`,
    );
    console.log(`  "${preview}"`);
  }
}

async function main() {
  const [cmd, arg2] = process.argv.slice(2);

  if (cmd === "list") {
    if (!arg2) {
      console.error("Usage: npx tsx scripts/test-annotation.ts list <docSlugOrId>");
      process.exitCode = 1;
      return;
    }
    await list(arg2);
  } else {
    console.error("Usage: npx tsx scripts/test-annotation.ts list <docSlugOrId>");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
