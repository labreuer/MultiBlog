import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { passageWords } from "@/lib/pdf-fragment";
import { FragmentChecker } from "@/lib/pdf-fragment-check";
import { linkHrefsIn, parseFragmentLinkHref } from "@/lib/pdf-fragment-findings";
import type { Actor } from "@/lib/actor";
import { ApiError, invalid } from "@/lib/api/errors";
import type { PageName } from "@/lib/pdf-open-params";
import { appOrigin } from "./resolve";

// docs/MCP.md §8 — every fragment link in what the MCP server writes is
// checked before anything is written: create_doc's body, edit_doc's
// replacements and appends, and the bodies add_note and edit_note write. An
// agent fixes the quote in the same turn, where otherwise a broken link shows
// only when someone follows it. A page link (`#page=<n>` or `#p=<label>` and
// no `text`) is checked for its page.
//
// The check is the integrity script's and the one-quote CLI's
// (`FragmentChecker`), which reads as the operator — so the file's own read
// gate runs first, and a file the actor can't read is `not_found`, the same
// as one that doesn't exist, so the check can't be asked what a PRIVATE file
// says. It never extracts page text, and nothing is rewritten: the href
// stored is the one sent.

/** A page as an answer names it. */
function pageText(page: PageName): string {
  return "sheet" in page ? `page ${page.sheet}` : `the page labelled ${page.label}`;
}

const NO_SUCH_LABEL = "which no page of the PDF carries (a page with no label of its own is named by page=, never p=)";

/** The warning for a `p=` on a file without usable labels, where it is the sheet number it names. */
function unlabelled(href: string, page: PageName, sheet: number, usableLabels: boolean | null): string[] {
  return "label" in page && usableLabels === false
    ? [`${href}: this PDF has no page labels, so p=${page.label} is a sheet number; write page=${sheet}.`]
    : [];
}

/** Checks each fragment link and page link in `bodies`; refuses a miss, and answers warnings for a passage its page repeats and for a `p=` on a PDF without labels. */
export async function checkFragmentLinks(actor: Actor, bodies: unknown[]): Promise<string[]> {
  const hrefs = [...new Set(bodies.flatMap((body) => linkHrefsIn(body)))];
  const checker = new FragmentChecker();
  const warnings: string[] = [];
  for (const href of hrefs) {
    const link = parseFragmentLinkHref(href, appOrigin());
    if (!link) continue;
    if (link.unread > 0 || (link.passages.length === 0 && link.page === null)) {
      throw invalid(`The fragment link ${href} has text= parameters that don't parse.`);
    }
    const resolved = await resolveFileParam(link.slug, { id: true, visibility: true, deletedByUserId: true });
    const readable =
      resolved !== null &&
      resolved.file.deletedByUserId === null &&
      (await canUserReadFile(actor.userId, actor.role, resolved.file));
    const finding = readable ? await checker.check(link) : null;
    if (!finding || finding.kind === "unknown-file") {
      throw new ApiError("not_found", `The fragment link ${href} names a PDF that doesn't exist, or isn't yours to read.`);
    }
    if (finding.page && link.page) {
      if (finding.page.kind === "page-out-of-range") {
        throw new ApiError("no_match", `The page link ${href} names ${pageText(link.page)}, past the PDF's ${finding.page.pageCount}.`, { link: href });
      }
      if (finding.page.kind === "no-such-label") {
        throw new ApiError("no_match", `The page link ${href} names the label ${"label" in link.page ? link.page.label : ""}, ${NO_SUCH_LABEL}.`, { link: href });
      }
      warnings.push(...unlabelled(href, link.page, finding.page.sheet, finding.usableLabels));
    }
    for (const passage of finding.passages) {
      const page = passage.passage.page;
      const named = { ...("sheet" in page ? { page: page.sheet } : { label: page.label }), ...passageWords(passage.passage) };
      if (passage.kind === "page-out-of-range") {
        throw new ApiError("no_match", `The fragment link ${href} names ${pageText(page)}, past the PDF's ${passage.pageCount}.`, {
          link: href,
          passage: named,
        });
      }
      if (passage.kind === "no-such-label") {
        throw new ApiError("no_match", `The fragment link ${href} names the label ${"label" in page ? page.label : ""}, ${NO_SUCH_LABEL}.`, {
          link: href,
          passage: named,
          ...(passage.foundOnPage !== null ? { foundOnPage: passage.foundOnPage } : {}),
        });
      }
      if (passage.kind === "no-match") {
        throw new ApiError("no_match", `The fragment link ${href} doesn't find its passage on ${pageText(page)}.`, {
          link: href,
          passage: named,
          matchedUpTo: passage.matchedUpTo,
          pageHasThere: passage.pageHasThere,
          ...(passage.foundOnPage !== null ? { foundOnPage: passage.foundOnPage } : {}),
        });
      }
      if (passage.occurrences > 1) {
        warnings.push(`${href}: its passage occurs ${passage.occurrences} times on page ${passage.sheet}; the link points at the first.`);
      }
      warnings.push(...unlabelled(href, page, passage.sheet, finding.usableLabels));
    }
  }
  return warnings;
}
