// Create or delete throwaway uploaded files for manual testing (PLAN.md §19).
// Same containment convention as test-doc.ts: only ever touches files owned
// solely by @example.com throwaway accounts, and `delete` refuses a file with
// any other owner, so it can't reach real content by mistake. (A file has
// owners, not authors — nobody listed on it wrote the PDF; prisma/schema.prisma's
// FileOwner.)
//
// Usage:
//   npx tsx scripts/test-file.ts create <ownerEmail> [--visibility=PRIVATE|SHARED] [--pages=N] [title]
//   npx tsx scripts/test-file.ts delete <slugOrId>
//   npx tsx scripts/test-file.ts list
//
// ownerEmail must be an existing @example.com user — create one first with
// scripts/test-user.ts create. title defaults to "Test file <timestamp>".
// --visibility defaults to PRIVATE. --pages defaults to 3.
//
// `create` **generates** its PDF rather than taking a path (see
// scripts/make-test-pdf.ts for why the fixture is code): it builds a document
// with known, greppable text on every page, stores it through the real
// file-storage path so the bytes land content-addressed exactly as an upload
// would, and extracts the page text through the real pdf-extract path so
// `file_page_text` is populated the way the upload route populates it. That
// means a file made here is indistinguishable from an uploaded one — which is
// the point; a fixture that skipped either step would test a path production
// never takes.
//
// `delete` removes the row (and cascades its owners, slug history and page
// text) and then removes the stored bytes **only if no other file
// still references them** — content addressing means two files can legitimately
// share one blob, and sweeping it would break the other one's downloads.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { prisma, prismaIncludingDeleted } from "../src/lib/prisma";
import { uniqueFileSlug } from "../src/lib/file-slug";
import { deleteBytesIfUnreferenced, storagePathFor, storeUploadStream } from "../src/lib/file-storage";
import { extractPdf } from "../src/lib/pdf-extract";
import { buildTestPdf } from "./make-test-pdf";
import { DocVisibility } from "../src/generated/prisma/enums";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const VISIBILITY_VALUES = Object.values(DocVisibility);

function parseCreateArgs(args: string[]): { title: string; visibility: DocVisibility; pages: number } {
  const titleWords: string[] = [];
  let visibility: DocVisibility = "PRIVATE";
  let pages = 3;

  for (const arg of args) {
    if (arg.startsWith("--visibility=")) {
      const value = arg.slice("--visibility=".length).toUpperCase();
      if (!VISIBILITY_VALUES.includes(value as DocVisibility)) {
        throw new Error(`Invalid --visibility value "${value}" — must be one of ${VISIBILITY_VALUES.join(", ")}.`);
      }
      visibility = value as DocVisibility;
    } else if (arg.startsWith("--pages=")) {
      const value = Number(arg.slice("--pages=".length));
      if (!Number.isInteger(value) || value < 1 || value > 200) {
        throw new Error(`Invalid --pages value "${arg}" — must be an integer between 1 and 200.`);
      }
      pages = value;
    } else {
      titleWords.push(arg);
    }
  }

  return { title: titleWords.join(" ").trim(), visibility, pages };
}

/** Text with a page number in it, so a manual test can tell at a glance which page it is looking at. */
function pagesFor(count: number): string[][] {
  return Array.from({ length: count }, (_, i) => [
    `Test page ${i + 1} of ${count}.`,
    `The quick brown fox jumps over the lazy dog on page ${i + 1}.`,
    `Distinctive phrase for page ${i + 1}: marker-${i + 1}-heliotrope.`,
  ]);
}

/** A ReadableStream over a byte array, so create() goes through the same code an HTTP upload does. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const end = Math.min(offset + 64 * 1024, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

async function create(ownerEmail: string, rest: string[]): Promise<void> {
  if (!SAFE_EMAIL.test(ownerEmail)) {
    throw new Error(`Refusing to create a file for "${ownerEmail}" — only @example.com accounts.`);
  }
  const owner = await prisma.user.findUnique({ where: { email: ownerEmail }, select: { id: true } });
  if (!owner) {
    throw new Error(`No user with email "${ownerEmail}" — create one with scripts/test-user.ts create.`);
  }

  const { title: titleArg, visibility, pages } = parseCreateArgs(rest);
  const title = titleArg || `Test file ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const filename = `${title.replace(/[^\w.-]+/g, "-")}.pdf`;

  const bytes = buildTestPdf(pagesFor(pages));
  const stored = await storeUploadStream(streamOf(bytes));
  const parsed = await extractPdf(await readFile(storagePathFor(stored.sha256)));

  const slug = await uniqueFileSlug(title);
  const file = await prisma.storedFile.create({
    data: {
      slug,
      title,
      filename,
      contentType: "application/pdf",
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      pageCount: parsed.pageCount,
      visibility,
      updatedByUserId: owner.id,
      owners: { create: { userId: owner.id, ownerOrder: 0 } },
    },
    select: { id: true, slug: true },
  });
  await prisma.filePageText.createMany({
    data: parsed.pages.map((text, pageIndex) => ({
      fileId: file.id,
      pageIndex,
      textVersion: parsed.textVersion,
      text,
    })),
  });

  console.log(`Created file ${file.id}`);
  console.log(`  title      ${title}`);
  console.log(`  url        /pdf/${file.slug}`);
  console.log(`  pages      ${parsed.pageCount}`);
  console.log(`  bytes      ${stored.byteSize}${stored.deduped ? " (deduped — identical bytes already stored)" : ""}`);
  console.log(`  sha256     ${stored.sha256}`);
  console.log(`  visibility ${visibility}`);
}

async function remove(slugOrId: string): Promise<void> {
  const file = await prismaIncludingDeleted.storedFile.findFirst({
    where: { OR: [{ id: slugOrId }, { slug: slugOrId }] },
    select: {
      id: true,
      slug: true,
      sha256: true,
      owners: { select: { user: { select: { email: true } } } },
    },
  });
  if (!file) {
    throw new Error(`No file with slug or id "${slugOrId}".`);
  }
  if (file.owners.length === 0) {
    throw new Error(
      `File "${file.slug}" has no owners — refusing to delete, since that's indistinguishable from a real file ` +
        `whose owner was removed. (Delete files before deleting their owner.)`,
    );
  }
  const unsafe = file.owners.filter((o) => !SAFE_EMAIL.test(o.user.email));
  if (unsafe.length > 0) {
    throw new Error(
      `File "${file.slug}" has non-throwaway owner(s): ${unsafe.map((o) => o.user.email).join(", ")}. Refusing.`,
    );
  }

  await prismaIncludingDeleted.storedFile.delete({ where: { id: file.id } });

  // Content addressing means another file may share these exact bytes. Counted
  // after the delete, so the count reflects what survives it.
  const remaining = await prismaIncludingDeleted.storedFile.count({ where: { sha256: file.sha256 } });
  await deleteBytesIfUnreferenced(file.sha256, remaining);

  console.log(`Deleted file ${file.id} (${file.slug})`);
  console.log(remaining > 0 ? `  bytes kept — ${remaining} other file(s) share them` : "  bytes removed from storage");
}

async function list(): Promise<void> {
  const files = await prismaIncludingDeleted.storedFile.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      title: true,
      visibility: true,
      pageCount: true,
      byteSize: true,
      deletedAt: true,
      owners: { select: { user: { select: { email: true } } } },
    },
  });
  if (files.length === 0) {
    console.log("No files.");
    return;
  }
  for (const file of files) {
    const owners = file.owners.map((o) => o.user.email).join(", ") || "(none)";
    const flags = [file.visibility, file.deletedAt ? "DELETED" : null].filter(Boolean).join(" ");
    console.log(
      `${file.id}  ${file.slug}\n` +
        `    "${file.title}"  ${flags}  ${file.pageCount ?? "?"}pp  ${file.byteSize}B\n` +
        `    owners: ${owners}`,
    );
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "create": {
      const [ownerEmail, ...rest] = args;
      if (!ownerEmail) throw new Error("Usage: npx tsx scripts/test-file.ts create <ownerEmail> [...]");
      await create(ownerEmail, rest);
      return;
    }
    case "delete": {
      const [slugOrId] = args;
      if (!slugOrId) throw new Error("Usage: npx tsx scripts/test-file.ts delete <slugOrId>");
      await remove(slugOrId);
      return;
    }
    case "list":
      await list();
      return;
    default:
      console.log("Usage:");
      console.log("  npx tsx scripts/test-file.ts create <ownerEmail> [--visibility=PRIVATE|SHARED] [--pages=N] [title]");
      console.log("  npx tsx scripts/test-file.ts delete <slugOrId>");
      console.log("  npx tsx scripts/test-file.ts list");
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
