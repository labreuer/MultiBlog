// Verifies that every PDF fragment link still finds its passage
// (docs/PDF_FRAGMENT_LINKS.md §9).
//
// A fragment link (`/pdf/<slug>#page=<n>&text=<words>`) has no row: it lives
// in the href of whatever text holds it, and the viewer finds its passage
// again on every open. So nothing else notices one going wrong. A link
// written against the wrong page, a quote with a word the PDF spells
// differently, or a pdfjs bump that changes which letters a page extracts
// shows only when someone follows the link. This is the thing that notices.
//
// What it reads: link marks in docs' `proseJson`, posts' `proseJson`, comment
// bodies and annotation bodies, none of them deleted. `Doc.proseJson` lags the
// live doc by a store debounce, which is fine for a check that positions
// nothing. An absolute href counts when it is on this instance's own origin
// (`APP_URL`).
//
// What it reports:
//   ERROR  a passage that isn't on its page (with where it stops matching, and
//          the page it is on when that is unambiguous), a page past the end, an
//          unknown or deleted file, a `text` parameter that doesn't parse
//   warn   a passage its page holds more than once (the link points at the
//          first), and a link naming a file's past slug (it still works,
//          through the slug-history redirect)
//
// Read-only, and it reads as the operator (src/lib/pdf-fragment-check.ts).
// Run it after `upgrade-pdf-text-version.ts` on a pdfjs bump (docs/PDF.md §10),
// and after importing a doc that carries fragment links.
//
// Usage:
//   npx tsx scripts/integrity/check-pdf-fragment-links.ts [--doc <idOrSlug>] [--verbose]

import "dotenv/config";
import { prisma } from "../../src/lib/prisma";
import {
  FragmentChecker,
  linkHrefsIn,
  parseFragmentLinkHref,
  type FragmentLinkFinding,
} from "../../src/lib/pdf-fragment-check";
import { formatFragmentPassages } from "../../src/lib/pdf-fragment";

type Severity = "error" | "warn";

let errors = 0;
let warnings = 0;
let links = 0;
let verbose = false;

function report(severity: Severity, where: string, check: string, message: string): void {
  if (severity === "error") errors++;
  else warnings++;
  console.log(`${severity === "error" ? "ERROR" : "warn "}  ${where}  [${check}] ${message}`);
}

function note(message: string): void {
  if (verbose) console.log(`       ${message}`);
}

/** One body that may hold links: what it is, for the report, and its JSON. */
type Body = { where: string; json: unknown };

async function bodies(docArg: string | undefined): Promise<Body[]> {
  if (docArg) {
    const doc = await prisma.doc.findFirst({
      where: { OR: [{ id: docArg }, { slug: docArg }], deletedByUserId: null },
      select: { id: true, slug: true, proseJson: true },
    });
    if (!doc) throw new Error(`No doc with id or slug "${docArg}".`);
    return [{ where: `doc ${doc.slug}`, json: doc.proseJson }];
  }
  const [docs, posts, comments, annotations] = await Promise.all([
    prisma.doc.findMany({ where: { deletedByUserId: null }, select: { slug: true, proseJson: true } }),
    prisma.post.findMany({ where: { deletedByUserId: null }, select: { slug: true, proseJson: true } }),
    prisma.comment.findMany({ where: { deletedByUserId: null }, select: { id: true, body: true } }),
    prisma.annotation.findMany({ where: { deletedByUserId: null }, select: { id: true, proseJson: true } }),
  ]);
  return [
    ...docs.map((doc) => ({ where: `doc ${doc.slug}`, json: doc.proseJson })),
    ...posts.map((post) => ({ where: `post ${post.slug}`, json: post.proseJson })),
    ...comments.map((comment) => ({ where: `comment ${comment.id}`, json: comment.body })),
    ...annotations.map((annotation) => ({ where: `annotation ${annotation.id}`, json: annotation.proseJson })),
  ];
}

function reportFinding(where: string, href: string, finding: FragmentLinkFinding): void {
  if (finding.kind === "unknown-file") {
    report("error", where, "unknown-file", `no live PDF has the slug "${finding.slug}": ${href}`);
    return;
  }
  if (finding.currentSlug !== finding.slug) {
    report("warn", where, "past-slug", `"${finding.slug}" is now "${finding.currentSlug}"; the link still works through the redirect`);
  }
  if (finding.unread > 0) {
    report("error", where, "unreadable", `${finding.unread} of its text parameters don't parse, name no page, or pass the limit: ${href}`);
  }
  for (const passage of finding.passages) {
    const label = `page ${passage.passage.page}, ${formatFragmentPassages([passage.passage]).replace(/^page=\d+&/, "")}`;
    if (passage.kind === "ok") {
      if (passage.occurrences > 1) {
        report("warn", where, "repeats", `${label} occurs ${passage.occurrences} times on its page; the link points at the first`);
      }
      note(`ok  ${label}: "${passage.text}"`);
    } else if (passage.kind === "page-out-of-range") {
      report("error", where, "page-out-of-range", `${label}: the file has ${passage.pageCount} pages`);
    } else {
      const stop =
        passage.matchedUpTo !== null
          ? ` It matches up to "…${passage.matchedUpTo}", where the page has "${passage.pageHasThere}…".`
          : " The page has none of it.";
      const instead = passage.foundOnPage !== null ? ` It is on page ${passage.foundOnPage}.` : "";
      report("error", where, "no-match", `${label} isn't on its page.${stop}${instead}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  verbose = args.includes("--verbose");
  const docIndex = args.indexOf("--doc");
  const docArg = docIndex >= 0 ? args[docIndex + 1] : undefined;
  const origin = process.env.APP_URL ?? null;

  const checker = new FragmentChecker();
  for (const body of await bodies(docArg)) {
    for (const href of linkHrefsIn(body.json)) {
      const link = parseFragmentLinkHref(href, origin);
      if (!link) continue;
      links++;
      reportFinding(body.where, href, await checker.check(link));
    }
  }

  console.log(`\n${links} fragment link(s) checked: ${errors} error(s), ${warnings} warning(s).`);
  process.exitCode = errors > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
