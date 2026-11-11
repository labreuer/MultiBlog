// Verifies that every PDF fragment link still finds its passage
// (docs/PDF_FRAGMENT_LINKS.md §9).
//
// A fragment link (`/pdf/<slug>#page=<n>&text=<words>`, or `#p=<label>&…` by
// printed page) has no row: it lives in the href of whatever text holds it,
// and the viewer finds its passage again on every open. So nothing else
// notices one going wrong. A link written against the wrong page, a quote
// with a word the PDF spells differently, or a pdfjs bump that changes which
// letters a page extracts shows only when someone follows the link. This is
// the thing that notices. A page link (`#page=<n>` or `#p=<label>` and no
// `text`) is checked for its page.
//
// What it reads: link marks in docs' `proseJson`, posts' `proseJson`, comment
// bodies and annotation bodies, none of them deleted. `Doc.proseJson` lags the
// live doc by a store debounce, which is fine for a check that positions
// nothing. An absolute href counts when it is on this instance's own origin
// (`APP_URL`).
//
// And a citation's passage (docs/CITATIONS.md, "Its checks"): every citation
// in a doc, a note or a comment whose link points at one, by the link it
// renders, `/references/<key>/p/<page>?…`, and every such link a post froze
// at publish. A quotation is placed on the cited page as the cited-page
// route places it (src/lib/cited-passage.ts); a `/pdf/` referent's passages
// are checked as the fragment link they make in the work's PDF, and the
// referent itself must name that PDF. What is checked is what the link
// carries, not the prose's quotation whole.
//
// What it reports:
//   ERROR  a passage that isn't on its page (with where it stops matching, and
//          the page it is on when that is unambiguous), a page past the end, a
//          label no page carries, an unknown or deleted file, a `text`
//          parameter that doesn't parse
//   warn   a passage its page holds more than once (the link points at the
//          first), a link naming a file's past slug (it still works, through
//          the slug-history redirect), and a `p=` on a file without usable
//          page labels, where it is a sheet number (with its `page=` form)
//
// And for a citation's passage:
//   ERROR  a quotation the cited page doesn't hold, a cited page no sheet
//          carries, a `/pdf/` referent naming a PDF other than its work's, a
//          work nothing has the key of, a query that doesn't parse
//   warn   a `quote:*` citation with no quotation beside it (it links to its
//          page), a passage whose work has no PDF (it is never shown), and a
//          quotation its page holds more than once
//
// Read-only, and it reads as the operator (src/lib/pdf-fragment-check.ts).
// Run it after `upgrade-pdf-text-version.ts` on a pdfjs bump (docs/PDF.md §10),
// and after importing a doc that carries fragment links.
//
// Usage:
//   npx tsx scripts/integrity/check-pdf-fragment-links.ts [--doc <idOrSlug>] [--verbose]

import "dotenv/config";
import { prisma } from "../../src/lib/prisma";
import { FragmentChecker } from "../../src/lib/pdf-fragment-check";
import { linkHrefsIn, parseFragmentLinkHref, type FragmentLinkFinding } from "../../src/lib/pdf-fragment-findings";
import { formatFragmentPassages, formatPassageText, type FragmentPassage } from "../../src/lib/pdf-fragment";
import type { PageName } from "../../src/lib/pdf-open-params";
import { checkCitedHref } from "../../src/lib/cited-passage";
import { parseCitedHref } from "../../src/lib/cited-passage-query";
import { chipInputsForBody } from "../../src/lib/entity-chips/context";
import { CITATION, referentKind } from "../../src/lib/entity-chips/kinds/citation";
import { chipRenderings, chipsInJSON } from "../../src/lib/entity-chips/renderings";
import { resolveFileParam } from "../../src/lib/file-slug";
import { parseFragmentLinkHref as fragmentOf } from "../../src/lib/pdf-fragment-findings";
import { referenceByKey } from "../../src/lib/reference-data";

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

/** One body that may hold links: what it is, for the report, its JSON, and whether it holds chips (a post holds none). */
type Body = { where: string; json: unknown; chips: boolean };

async function bodies(docArg: string | undefined): Promise<Body[]> {
  if (docArg) {
    const doc = await prisma.doc.findFirst({
      where: { OR: [{ id: docArg }, { slug: docArg }], deletedByUserId: null },
      select: { id: true, slug: true, proseJson: true },
    });
    if (!doc) throw new Error(`No doc with id or slug "${docArg}".`);
    return [{ where: `doc ${doc.slug}`, json: doc.proseJson, chips: true }];
  }
  const [docs, posts, comments, annotations] = await Promise.all([
    prisma.doc.findMany({ where: { deletedByUserId: null }, select: { slug: true, proseJson: true } }),
    prisma.post.findMany({ where: { deletedByUserId: null }, select: { slug: true, proseJson: true } }),
    prisma.comment.findMany({ where: { deletedByUserId: null }, select: { id: true, body: true } }),
    prisma.annotation.findMany({ where: { deletedByUserId: null }, select: { id: true, proseJson: true } }),
  ]);
  return [
    ...docs.map((doc) => ({ where: `doc ${doc.slug}`, json: doc.proseJson, chips: true })),
    ...posts.map((post) => ({ where: `post ${post.slug}`, json: post.proseJson, chips: false })),
    ...comments.map((comment) => ({ where: `comment ${comment.id}`, json: comment.body, chips: true })),
    ...annotations.map((annotation) => ({ where: `annotation ${annotation.id}`, json: annotation.proseJson, chips: true })),
  ];
}

/** A page as a report names it: its sheet, or its label as the link wrote it. */
function pageText(page: PageName): string {
  return "sheet" in page ? `page ${page.sheet}` : `p=${page.label}`;
}

/** A passage as a report names it: its page, then its `text` as a writer formats it. */
function passageText(passage: FragmentPassage): string {
  return `${pageText(passage.page)}, ${formatFragmentPassages([passage]).replace(/^[^&]*&/, "")}`;
}

/** The warning for a `p=` on a file without usable labels, where it is the sheet number it names. */
function unlabelled(where: string, page: PageName, sheet: number, usableLabels: boolean | null): void {
  if ("label" in page && usableLabels === false) {
    report("warn", where, "unlabelled-p", `p=${page.label}: the file has no page labels, so this is a sheet number; write page=${sheet}`);
  }
}

/** `page` is a page link's page, and null for a fragment link. */
function reportFinding(where: string, href: string, page: PageName | null, finding: FragmentLinkFinding): void {
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
  if (finding.page && page) {
    const label = pageText(page);
    if (finding.page.kind === "ok") {
      unlabelled(where, page, finding.page.sheet, finding.usableLabels);
      note(`ok  ${label}: a page link to page ${finding.page.sheet}`);
    } else if (finding.page.kind === "page-out-of-range") {
      report("error", where, "page-out-of-range", `${label}: the file has ${finding.page.pageCount} pages: ${href}`);
    } else {
      report("error", where, "no-such-label", `${label}: no page of the file carries that label: ${href}`);
    }
  }
  for (const passage of finding.passages) {
    const label = passageText(passage.passage);
    if (passage.kind === "ok") {
      if (passage.occurrences > 1) {
        report("warn", where, "repeats", `${label} occurs ${passage.occurrences} times on its page; the link points at the first`);
      }
      unlabelled(where, passage.passage.page, passage.sheet, finding.usableLabels);
      note(`ok  ${label}: "${passage.text}"`);
    } else if (passage.kind === "page-out-of-range") {
      report("error", where, "page-out-of-range", `${label}: the file has ${passage.pageCount} pages`);
    } else if (passage.kind === "no-such-label") {
      const instead = passage.foundOnPage !== null ? ` The passage is on page ${passage.foundOnPage}.` : "";
      report("error", where, "no-such-label", `${label}: no page of the file carries that label.${instead}`);
    } else {
      const stop =
        passage.matchedUpTo !== null
          ? ` It matches up to "…${passage.matchedUpTo}", where the page has "${passage.pageHasThere}…".`
          : " The page has none of it.";
      const instead = passage.foundOnPage !== null ? ` It is on page ${passage.foundOnPage}.` : "";
      const on = passage.sheets.length > 1 ? `any of the pages carrying its label (${passage.sheets.join(", ")})` : "its page";
      report("error", where, "no-match", `${label} isn't on ${on}.${stop}${instead}`);
    }
  }
}

let citations = 0;

/**
 * The links a body's citations render for a passage, `/references/<key>/p/<page>?…`,
 * with what each points at; and a warning for each `quote:*` citation with
 * no quotation beside it, which links to its page.
 */
async function citationLinks(body: Body): Promise<{ href: string; referent: string }[]> {
  if (!body.chips || !body.json || typeof body.json !== "object") return [];
  const chips = chipsInJSON(body.json as object);
  if (!chips.some((chip) => chip.kind === CITATION && typeof chip.data.referent === "string")) return [];
  const inputs = await chipInputsForBody(body.json as object);
  const renderings = chipRenderings(chips, inputs.styles, inputs.context);
  const found: { href: string; referent: string }[] = [];
  chips.forEach((chip, index) => {
    const referent = chip.data.referent;
    if (chip.kind !== CITATION || typeof referent !== "string") return;
    const href = renderings[index].href;
    if (referentKind(referent) === "quote" && chip.quotation === null) {
      citations++;
      report("warn", body.where, "no-quotation", `a citation pointing at ${referent} has no quotation there, so it links to its page`);
    } else if (href && parseCitedHref(href, null)) found.push({ href, referent });
  });
  return found;
}

/** A citation's passage, as the cited-page route would place it, reported. `referent` is what the citation's own link said, for a doc's; null for a post's frozen link. */
async function checkCitation(where: string, href: string, referent: string | null, checker: FragmentChecker, origin: string | null): Promise<void> {
  const cited = parseCitedHref(href, origin);
  if (!cited) return;
  citations++;
  const finding = await checkCitedHref(checker, cited);
  const shown = `${href.length > 160 ? `${href.slice(0, 157)}…` : href}`;
  switch (finding.kind) {
    case "unknown-work":
      report("error", where, "unknown-work", `no reference has the key "${finding.key}": ${shown}`);
      return;
    case "no-pdf":
      report("warn", where, "no-pdf", `${finding.key} has no PDF, so its passage is never shown: ${shown}`);
      return;
    case "unreadable-pdf":
    case "none":
      return;
    case "unreadable-query":
      report("error", where, "unreadable", `its passage doesn't parse: ${shown}`);
      return;
    case "no-such-page":
      report("error", where, "no-such-page", `no page of ${finding.key}'s PDF carries page ${finding.page}: ${shown}`);
      return;
    case "fragment":
      reportFinding(where, `/pdf/${finding.slug}#…, from ${shown}`, null, finding.finding);
      break;
    case "placed":
      for (const piece of finding.passages) {
        if (piece.occurrences > 1) {
          report("warn", where, "repeats", `${finding.key}, sheet ${piece.sheet}: ${formatPassageText(piece.passage)} occurs ${piece.occurrences} times on its page; the link points at the first`);
        }
        note(`ok  ${finding.key}, sheet ${piece.sheet}: "${piece.text}"`);
      }
      break;
    case "missed": {
      const stop =
        finding.matchedUpTo !== null ? ` It matches up to "…${finding.matchedUpTo}", where the page has "${finding.pageHasThere}…".` : " The page has none of it.";
      const instead = finding.foundOnPage !== null ? ` It is on page ${finding.foundOnPage}.` : "";
      report("error", where, "no-match", `${finding.key}: its quotation isn't on p. ${cited.page} (sheet ${finding.sheet}).${stop}${instead} ${shown}`);
      break;
    }
  }
  // A `/pdf/` referent names a PDF; the route sends a reader to the work's, so the two must be one.
  if (referent && referentKind(referent) === "pdf") {
    const slug = fragmentOf(referent, null)?.slug ?? decodeURIComponent(referent.replace(/^\/pdf\/([^/#?]+).*$/, "$1"));
    const [named, work] = await Promise.all([resolveFileParam(slug, { id: true }), referenceByKey(finding.key)]);
    if (named && work?.fileId && named.file.id !== work.fileId) {
      report("error", where, "another-file", `${referent.slice(0, 120)} names a PDF other than ${finding.key}'s own, where the link looks for its passage`);
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
      if (!link) {
        // A post's citations are frozen links (docs/CITATIONS.md, "Its checks").
        await checkCitation(body.where, href, null, checker, origin);
        continue;
      }
      links++;
      reportFinding(body.where, href, link.page, await checker.check(link));
    }
    for (const citation of await citationLinks(body)) await checkCitation(body.where, citation.href, citation.referent, checker, origin);
  }

  console.log(`\n${links} fragment and page link(s) and ${citations} citation passage(s) checked: ${errors} error(s), ${warnings} warning(s).`);
  process.exitCode = errors > 0 ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
