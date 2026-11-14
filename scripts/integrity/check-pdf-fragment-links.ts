// Verifies that every PDF fragment link still finds its passage
// (docs/PDF_FRAGMENT_LINKS.md §9).
//
// A fragment link (`/pdf/<slug>#sheet=<n>&text=<words>`, or `#p=<label>&…` by
// printed page) has no row: it lives in the href of whatever text holds it,
// and the viewer finds its passage again on every open. So nothing else
// notices one going wrong. A link written against the wrong page, a quote
// with a word the PDF spells differently, or a pdfjs bump that changes which
// letters a page extracts shows only when someone follows the link. This is
// the thing that notices. A page link (`#sheet=<n>` or `#p=<label>` and no
// `text`) is checked for its page.
//
// **A link is read as the viewer reads it** (docs/PDF.md §13, "Links into the
// file"): each page on the version it names, its `v=`, or without one the
// version its own address names (`/pdf/<slug>/v/<n>`), or the file's first,
// and then wherever the viewer would take it. Where page maps join the
// version a link names to the one its address shows, the link is carried
// and checked where it lands. One the viewer can't carry is checked on the
// version it names, which is the one it opens: words that are gone from the
// latest version are no fault in it, since a revised text stands between.
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
//          and a `v=` naming a version the file never had
//   warn   a passage its page holds more than once (the link points at the
//          first), a link naming a file's past slug (it still works, through
//          the slug-history redirect), a `p=` on a file without usable
//          page labels, where it is a sheet number (with its `sheet=` form),
//          a link naming an abandoned version that it can't be carried
//          off (nothing can confirm it), a link on a version's own address
//          that names another version and can't be carried there (the
//          viewer stays, and offers the passage on the version named), **a
//          link carried to a sheet that doesn't hold its words** (a better
//          copy corrected them, and every reader is told "Not found"), and
//          **a link without `v=` written after its file's second version was
//          uploaded**, which only a hand can have typed and whose writer
//          most likely meant the latest. The check dates a link by the
//          update log (src/lib/pdf-link-dating.ts), which the viewer can't.
//
// A link that names a version other than the latest, and lands with its
// words found, is no fault: every link written before a file's second
// version is one. `--verbose` lists it, with its form for the version it
// was carried to.
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
import { linkHrefsIn, parseFragmentLinkHref, type FragmentLinkFinding, type VersionFault } from "../../src/lib/pdf-fragment-findings";
import { formatFragmentPassages, formatPassageText, type FragmentPassage } from "../../src/lib/pdf-fragment";
import { formatPageName, type PageName } from "../../src/lib/pdf-open-params";
import { LinkDater, pdfHrefsIn, type LinkHolder } from "../../src/lib/pdf-link-dating";
import { checkCitedHref } from "../../src/lib/cited-passage";
import { parseCitedHref } from "../../src/lib/cited-passage-query";
import { chipInputsForBody } from "../../src/lib/entity-chips/context";
import { CITATION, pdfReferentPath, referentKind } from "../../src/lib/entity-chips/kinds/citation";
import { chipRenderings, chipsInJSON } from "../../src/lib/entity-chips/renderings";
import { resolveFileParam } from "../../src/lib/file-slug";
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

/** One body that may hold links: what it is, for the report, its JSON, whether it holds chips (a post holds none), and what dates its links. */
type Body = { where: string; json: unknown; chips: boolean; holder: LinkHolder };

async function bodies(docArg: string | undefined): Promise<Body[]> {
  if (docArg) {
    const doc = await prisma.doc.findFirst({
      where: { OR: [{ id: docArg }, { slug: docArg }], deletedByUserId: null },
      select: { id: true, slug: true, proseJson: true },
    });
    if (!doc) throw new Error(`No doc with id or slug "${docArg}".`);
    return [{ where: `doc ${doc.slug}`, json: doc.proseJson, chips: true, holder: { kind: "doc", id: doc.id } }];
  }
  const [docs, posts, comments, annotations] = await Promise.all([
    prisma.doc.findMany({ where: { deletedByUserId: null }, select: { id: true, slug: true, proseJson: true } }),
    prisma.post.findMany({ where: { deletedByUserId: null }, select: { id: true, slug: true, proseJson: true } }),
    prisma.comment.findMany({ where: { deletedByUserId: null }, select: { id: true, body: true } }),
    prisma.annotation.findMany({ where: { deletedByUserId: null }, select: { id: true, proseJson: true } }),
  ]);
  return [
    ...docs.map((doc): Body => ({ where: `doc ${doc.slug}`, json: doc.proseJson, chips: true, holder: { kind: "doc", id: doc.id } })),
    ...posts.map((post): Body => ({ where: `post ${post.slug}`, json: post.proseJson, chips: false, holder: { kind: "post", id: post.id } })),
    ...comments.map((comment): Body => ({ where: `comment ${comment.id}`, json: comment.body, chips: true, holder: { kind: "comment", id: comment.id } })),
    ...annotations.map((annotation): Body => ({ where: `annotation ${annotation.id}`, json: annotation.proseJson, chips: true, holder: { kind: "annotation", id: annotation.id } })),
  ];
}

/** A page as a report names it: its sheet, or its label as the link wrote it, with its stamp where it has one. */
function pageText(page: PageName): string {
  return `${"sheet" in page ? `page ${page.sheet}` : `p=${page.label}`}${page.v !== undefined ? ` (v=${page.v})` : ""}`;
}

/** A passage as a report names it: its page, then its `text` as a writer formats it. */
function passageText(passage: FragmentPassage): string {
  return `${pageText(passage.page)}, text=${formatPassageText(passage)}`;
}

/** The warning for a `p=` on a file without usable labels, where it is the sheet number it names. The form it gives keeps the link's own stamp. */
function unlabelled(where: string, page: PageName, sheet: number, usableLabels: boolean | null): void {
  if ("label" in page && usableLabels === false) {
    report("warn", where, "unlabelled-p", `p=${page.label}: the file has no page labels, so this is a sheet number; write ${formatPageName({ sheet, stamp: page.v ?? "sole" })}`);
  }
}

type Checked = Extract<FragmentLinkFinding, { kind: "checked" }>;

/** What a page that names a version with nothing to read is reported as: a warning for an abandoned one, since nothing can confirm the link, and an error for one the file never had. */
function reportVersionFault(where: string, label: string, fault: VersionFault, finding: Checked, href: string): void {
  if (fault.kind === "abandoned-version") {
    const why = fault.mapped ? "was abandoned, and its sheet has no counterpart where the link lands" : "was abandoned, and no page maps carry the link off it";
    report("warn", where, "abandoned-version", `${label} names version ${fault.version}, which ${why}, so nothing can confirm the link: ${href}`);
  } else {
    report("error", where, "no-such-version", `${label} names version ${fault.version}, and the file has ${finding.versionCount}: ${href}`);
  }
}

/** What follows from the version a page was read on: a warning where the link's own address shows another, and a verbose line where it isn't the latest. */
function reportVersionRead(where: string, label: string, version: number, finding: Checked): void {
  if (finding.addressVersion !== null && version !== finding.addressVersion) {
    report(
      "warn",
      where,
      "another-version",
      `${label} names version ${version} on the address of version ${finding.addressVersion}: the viewer stays on version ${finding.addressVersion} and offers the passage on version ${version}`,
    );
  } else if (version !== finding.latestVersion) {
    note(`    ${label} is read on version ${version}; the latest is version ${finding.latestVersion}, and it isn't carried there`);
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
    if (finding.page.kind === "abandoned-version" || finding.page.kind === "no-such-version") {
      reportVersionFault(where, label, finding.page, finding, href);
      return;
    }
    reportVersionRead(where, label, finding.page.version, finding);
    if (finding.page.kind === "ok" && finding.page.carried) {
      const stamp = finding.versionCount > 1 ? finding.page.version : ("sole" as const);
      note(
        `ok  ${label}: names version ${finding.page.carried.from}, carried to sheet ${finding.page.sheet} of version ${finding.page.version}; there it is ${formatPageName({ sheet: finding.page.sheet, stamp })}`,
      );
    } else if (finding.page.kind === "ok") {
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
    if (passage.kind === "abandoned-version" || passage.kind === "no-such-version") {
      reportVersionFault(where, label, passage, finding, href);
      continue;
    }
    reportVersionRead(where, label, passage.version, finding);
    if (passage.kind === "ok") {
      if (passage.occurrences > 1) {
        report("warn", where, "repeats", `${label} occurs ${passage.occurrences} times on its page; the link points at the first`);
      }
      if (passage.carried) {
        const stamp = finding.versionCount > 1 ? passage.version : ("sole" as const);
        const there = formatFragmentPassages([{ ...passage.passage, page: { sheet: passage.sheet, stamp } }]);
        note(
          `ok  ${label}: names version ${passage.carried.from}, ${passage.carried.byWords ? "found by its words" : "carried"} on sheet ${passage.sheet} of version ${passage.version}; there it is #${there}: "${passage.text}"`,
        );
      } else {
        unlabelled(where, passage.passage.page, passage.sheet, finding.usableLabels);
        note(`ok  ${label}: "${passage.text}"`);
      }
    } else if (passage.kind === "no-match" && passage.carried) {
      // Every reader of the link is told "Not found on page n". A warning,
      // since the link was right when it was written: the bytes changed under it.
      const held = passage.carried.namedHolds ? ` Version ${passage.carried.from} holds them, so a better copy changed the words.` : "";
      const instead = passage.foundOnPage !== null ? ` They are on page ${passage.foundOnPage} of version ${passage.version}.` : "";
      report(
        "warn",
        where,
        "carried-miss",
        `${label} names version ${passage.carried.from} and is carried to sheet ${passage.sheets.join(", ")} of version ${passage.version}, which doesn't hold its words.${held}${instead}`,
      );
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

/**
 * The warning for a link without `v=` that was written after its file's
 * second version was uploaded (docs/PDF.md §13, "Links into the file"). The
 * viewer reads such a link as the first version's, since it can't tell when a
 * URL was written; the check can, and a link that postdates the second
 * version was typed by hand, most likely for the latest. A link on a
 * version's own address needs no stamp: the address says which.
 */
async function reportUnstamped(body: Body, href: string, checker: FragmentChecker, dater: LinkDater, origin: string | null): Promise<void> {
  const link = parseFragmentLinkHref(href, origin);
  if (!link || link.version !== null) return;
  const pages = [...link.passages.map((passage) => passage.page), ...(link.page ? [link.page] : [])];
  if (pages.every((page) => page.v !== undefined)) return;
  const mark = await checker.secondVersionMark(link.slug);
  if (!mark || !(await dater.writtenAfter(body.holder, href, mark))) return;
  report("warn", body.where, "unstamped", `written after its file's second version and without v=, so it is read as version 1's; say which version it names: ${href}`);
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
    const slug = pdfReferentPath(referent)?.slug ?? null;
    const [named, work] = await Promise.all([slug === null ? null : resolveFileParam(slug, { id: true }), referenceByKey(finding.key)]);
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
  const dater = new LinkDater();
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
    // Every link into a PDF the body holds, a citation's `/pdf/` referent included, once each.
    for (const href of new Set(pdfHrefsIn(body.json))) await reportUnstamped(body, href, checker, dater, origin);
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
