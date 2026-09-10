// Verifies that every PDF annotation's stored quote still describes the text
// its stored offsets name (PLAN.md §19).
//
// **The sibling of check-annotation-anchors.ts, and the odd one out for the
// same reason it is.** The other integrity checks recompute a derived value and
// compare: a ydoc blob against its update log, a length cache against the
// document it measures. This one verifies a *claim written down once* — "on
// page N, characters [a, b) of the normalised text read exactly this" — which
// nothing recomputes and nothing else would ever notice going wrong. A break
// here is silent by construction.
//
// It is a separate script rather than a branch inside check-annotation-anchors
// because the two verify different things against different substrates. A doc
// annotation's anchor is checked by replaying a ydoc to a stamped version; a
// file has no ydoc and no version to replay to — its bytes are immutable, which
// is exactly why its anchor is checked against stored page text instead.
//
// What it can and cannot see:
//
//   - It **can** catch a quote that disagrees with the page text at its own
//     offsets, a target whose textVersion has no matching extraction, and a
//     malformed target blob.
//   - It **cannot** check the quads. They are geometry, and verifying them
//     would mean rendering the PDF — which is the client's job and needs a
//     browser. The quads are also the anchor least likely to be wrong: they
//     were measured against bytes that cannot change.
//
// Usage:
//   npx tsx scripts/integrity/check-pdf-anchors.ts [--file <fileIdOrSlug>] [--verbose]

import "dotenv/config";
import { prisma, prismaIncludingDeleted } from "../../src/lib/prisma";
import { parsePdfTarget } from "../../src/lib/pdf-anchor";

type Severity = "error" | "warn";

let errors = 0;
let warnings = 0;
let verbose = false;

function report(severity: Severity, id: string, check: string, message: string): void {
  if (severity === "error") errors++;
  else warnings++;
  console.log(`${severity === "error" ? "ERROR" : "warn "}  ${id}  [${check}] ${message}`);
}

function note(message: string): void {
  if (verbose) console.log(`       ${message}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  verbose = args.includes("--verbose");
  const fileArgIndex = args.indexOf("--file");
  const fileArg = fileArgIndex >= 0 ? args[fileArgIndex + 1] : undefined;

  let fileId: string | undefined;
  if (fileArg) {
    const file = await prismaIncludingDeleted.storedFile.findFirst({
      where: { OR: [{ id: fileArg }, { slug: fileArg }] },
      select: { id: true },
    });
    if (!file) throw new Error(`No file with id or slug "${fileArg}".`);
    fileId = file.id;
  }

  const annotations = await prisma.annotation.findMany({
    where: {
      fileId: fileId ?? { not: null },
      // A DRAFT has never been through postAnnotation, so it carries no target
      // yet and there is nothing to verify.
      status: { not: "DRAFT" },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      fileId: true,
      parentAnnotationId: true,
      quotedText: true,
      pdfTarget: true,
      deletedAt: true,
      file: { select: { slug: true, pageCount: true } },
    },
  });

  console.log(`Checking ${annotations.length} file annotation(s)…\n`);

  // Page text is fetched per (file, page, textVersion) and cached: several
  // annotations routinely share a page, and this is the only query in the loop.
  const pageTextCache = new Map<string, string | null>();
  async function pageText(fileId: string, pageIndex: number, textVersion: string): Promise<string | null> {
    const key = `${fileId}:${pageIndex}:${textVersion}`;
    const hit = pageTextCache.get(key);
    if (hit !== undefined) return hit;
    const row = await prisma.filePageText.findUnique({
      where: { fileId_pageIndex_textVersion: { fileId, pageIndex, textVersion } },
      select: { text: true },
    });
    pageTextCache.set(key, row?.text ?? null);
    return row?.text ?? null;
  }

  let checked = 0;

  for (const a of annotations) {
    if (!a.fileId) continue;

    // A *reply* anchors into its parent annotation's body, not into the PDF
    // (§13p), so it legitimately has no target. That is the doc-side mechanism
    // and check-annotation-anchors.ts's business, not this one's.
    if (a.parentAnnotationId !== null) {
      note(`${a.id}: reply — anchored into its parent's body, not the file; skipped`);
      continue;
    }

    if (a.pdfTarget === null) {
      // Document-level: posted without a selection. Valid, and it should have
      // no quote either — a quote with no target is a genuine inconsistency,
      // since the quote is *derived from* the target.
      if (a.quotedText !== "") {
        report("error", a.id, "quote-without-target", `has quotedText "${truncate(a.quotedText)}" but no pdfTarget`);
      }
      continue;
    }

    const target = parsePdfTarget(a.pdfTarget);
    if (!target) {
      report("error", a.id, "target-malformed", "pdfTarget is present but doesn't parse as a Target");
      continue;
    }

    if (target.quads.length === 0) {
      report("error", a.id, "no-quads", "target has no quads — nothing anchors it");
    }

    const pageCount = a.file?.pageCount;
    if (pageCount !== null && pageCount !== undefined && target.pageIndex >= pageCount) {
      report(
        "error",
        a.id,
        "page-out-of-range",
        `pageIndex ${target.pageIndex} but the file has ${pageCount} page(s)`,
      );
      continue;
    }

    // A rectangle selection has no text to check — the quads are the whole
    // anchor, deliberately (docs/PDF.md §4's step 3 is the only path it has).
    if (!target.quote.exact && !target.position) {
      note(`${a.id}: region annotation on page ${target.pageIndex + 1} — no quote to verify`);
      continue;
    }

    const text = await pageText(a.fileId, target.pageIndex, target.textVersion);
    if (text === null) {
      // Not an error: a `textVersion` bump leaves older rows pointing at an
      // extraction that is still valid but no longer the newest, and
      // re-extraction is lazy by design (docs/PDF.md §3). It becomes a problem
      // only if the *old* extraction was deleted, which nothing does.
      report(
        "warn",
        a.id,
        "no-page-text",
        `no stored page text for page ${target.pageIndex + 1} at textVersion ${target.textVersion}`,
      );
      continue;
    }

    if (!target.position) {
      report("warn", a.id, "no-position", "has a quote but no position — the quote can't be located to verify");
      continue;
    }

    checked++;
    const slice = text.slice(target.position.start, target.position.end);
    if (slice !== target.quote.exact) {
      report(
        "error",
        a.id,
        "quote-mismatch",
        `page ${target.pageIndex + 1} [${target.position.start}, ${target.position.end}) reads ` +
          `"${truncate(slice)}" but the target claims "${truncate(target.quote.exact)}"`,
      );
      continue;
    }

    // The column and the blob hold the same string on purpose — the column is
    // the display copy, the blob is the anchor (schema.prisma) — so a
    // divergence means one was written without the other.
    if (a.deletedAt === null && a.quotedText !== target.quote.exact) {
      report(
        "error",
        a.id,
        "column-blob-divergence",
        `quotedText "${truncate(a.quotedText)}" != target.quote.exact "${truncate(target.quote.exact)}"`,
      );
      continue;
    }

    note(`${a.id}: page ${target.pageIndex + 1} "${truncate(target.quote.exact)}" ✓`);
  }

  // docs/ANCHORED_LINKS.md — the same claim, written by a different consumer:
  // an anchored-link part's `selector` is a whole PdfTarget blob (PDF_TEXT),
  // derived by the same capturePdfTextAnchor call an annotation's is, so it
  // is checked here rather than growing a replay branch it has no state for.
  // The page-text cache above is shared — link parts and annotations
  // routinely quote the same pages.
  const linkParts = await prisma.anchoredLinkAnchor.findMany({
    where: { selectorKind: "PDF_TEXT", ...(fileId ? { fileId } : {}) },
    orderBy: { id: "asc" },
    select: {
      id: true,
      fileId: true,
      selector: true,
      quotedText: true,
      file: { select: { pageCount: true } },
    },
  });

  console.log(`\nChecking ${linkParts.length} anchored-link PDF part(s)…\n`);
  let linkChecked = 0;

  for (const part of linkParts) {
    if (part.fileId === null) {
      // The selector-columns CHECK keeps the kind and blob together, but
      // nothing but its writer ties PDF_TEXT to the file arm — the mirror of
      // the DOC_RANGE-on-a-file finding in check-annotation-anchors.ts.
      report("error", part.id, "target-mechanism", "PDF_TEXT selector on a non-file target");
      continue;
    }
    const target = parsePdfTarget(part.selector);
    if (!target) {
      report("error", part.id, "target-malformed", "selector is present but doesn't parse as a Target");
      continue;
    }
    if (target.quads.length === 0) {
      report("error", part.id, "no-quads", "target has no quads — nothing anchors it");
    }
    const pageCount = part.file?.pageCount;
    if (pageCount !== null && pageCount !== undefined && target.pageIndex >= pageCount) {
      report("error", part.id, "page-out-of-range", `pageIndex ${target.pageIndex} but the file has ${pageCount} page(s)`);
      continue;
    }

    // The column and the blob hold the same string by construction —
    // capturePdfTextAnchor writes its own verified quote into both.
    if (part.quotedText !== target.quote.exact) {
      report(
        "error",
        part.id,
        "column-blob-divergence",
        `quotedText "${truncate(part.quotedText)}" != target.quote.exact "${truncate(target.quote.exact)}"`,
      );
      continue;
    }

    if (!target.quote.exact && !target.position) {
      note(`${part.id}: region part on page ${target.pageIndex + 1} — no quote to verify`);
      continue;
    }
    const text = await pageText(part.fileId, target.pageIndex, target.textVersion);
    if (text === null) {
      report(
        "warn",
        part.id,
        "no-page-text",
        `no stored page text for page ${target.pageIndex + 1} at textVersion ${target.textVersion}`,
      );
      continue;
    }
    if (!target.position) {
      report("warn", part.id, "no-position", "has a quote but no position — the quote can't be located to verify");
      continue;
    }

    linkChecked++;
    const slice = text.slice(target.position.start, target.position.end);
    if (slice !== target.quote.exact) {
      report(
        "error",
        part.id,
        "quote-mismatch",
        `page ${target.pageIndex + 1} [${target.position.start}, ${target.position.end}) reads ` +
          `"${truncate(slice)}" but the target claims "${truncate(target.quote.exact)}"`,
      );
      continue;
    }

    note(`${part.id}: page ${target.pageIndex + 1} "${truncate(target.quote.exact)}" ✓`);
  }

  console.log(
    `\n${checked} annotation quote(s) and ${linkChecked} anchored-link part(s) verified against stored page text. ` +
      `${errors} error(s), ${warnings} warning(s).`,
  );
  if (errors > 0) process.exitCode = 1;
}

function truncate(text: string, length = 60): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
