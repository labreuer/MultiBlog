import type { JSONContent } from "@tiptap/core";
import { checkCitedHref } from "@/lib/cited-passage";
import { parseCitedHref } from "@/lib/cited-passage-query";
import { chipInputsForBody } from "@/lib/entity-chips/context";
import { CITATION, referentKind } from "@/lib/entity-chips/kinds/citation";
import { chipMarkdowns, chipRenderings, chipsInJSON } from "@/lib/entity-chips/renderings";
import { canUserReadFile } from "@/lib/file-authz";
import { prismaIncludingDeleted } from "@/lib/prisma";
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
// only when someone follows it. A page link (`#sheet=<n>` or `#p=<label>` and
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
  return "sheet" in page ? `sheet ${page.sheet}` : `page ${page.label}`;
}

const NO_SUCH_LABEL = "which no sheet of the PDF carries (a sheet with no label of its own is named by sheet=, never p=)";

/** The warning for a `p=` on a file without usable labels, where it is the sheet number it names. */
function unlabelled(href: string, page: PageName, sheet: number, usableLabels: boolean | null): string[] {
  return "label" in page && usableLabels === false
    ? [`${href}: this PDF has no page labels, so p=${page.label} is a sheet number; write sheet=${sheet}.`]
    : [];
}

/**
 * Checks each fragment link and page link in `bodies`, and each citation's
 * passage (docs/CITATIONS.md, "Its checks"); refuses a miss, and answers
 * warnings for a passage its page repeats and for a `p=` on a PDF without
 * labels. A `/pdf/` referent is checked as the fragment link it is.
 */
export async function checkFragmentLinks(actor: Actor, bodies: unknown[]): Promise<string[]> {
  const citations = await citationsIn(bodies);
  const hrefs = [...new Set([...bodies.flatMap((body) => linkHrefsIn(body)), ...citations.flatMap((citation) => (citation.kind === "pdf" ? [citation.referent] : []))])];
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
        throw new ApiError("no_match", `The page link ${href} names ${pageText(link.page)}, past the PDF's ${finding.page.pageCount} sheets.`, { link: href });
      }
      if (finding.page.kind === "no-such-label") {
        throw new ApiError("no_match", `The page link ${href} names the label ${"label" in link.page ? link.page.label : ""}, ${NO_SUCH_LABEL}.`, { link: href });
      }
      warnings.push(...unlabelled(href, link.page, finding.page.sheet, finding.usableLabels));
    }
    for (const passage of finding.passages) {
      const page = passage.passage.page;
      const named = { ...("sheet" in page ? { sheet: page.sheet } : { page: page.label }), ...passageWords(passage.passage) };
      if (passage.kind === "page-out-of-range") {
        throw new ApiError("no_match", `The fragment link ${href} names ${pageText(page)}, past the PDF's ${passage.pageCount} sheets.`, {
          link: href,
          passage: named,
        });
      }
      if (passage.kind === "no-such-label") {
        throw new ApiError("no_match", `The fragment link ${href} names the label ${"label" in page ? page.label : ""}, ${NO_SUCH_LABEL}.`, {
          link: href,
          passage: named,
          ...(passage.foundOnPage !== null ? { foundOnSheet: passage.foundOnPage } : {}),
        });
      }
      if (passage.kind === "no-match") {
        throw new ApiError("no_match", `The fragment link ${href} doesn't find its passage on ${pageText(page)}.`, {
          link: href,
          passage: named,
          matchedUpTo: passage.matchedUpTo,
          pageHasThere: passage.pageHasThere,
          ...(passage.foundOnPage !== null ? { foundOnSheet: passage.foundOnPage } : {}),
        });
      }
      if (passage.occurrences > 1) {
        warnings.push(`${href}: its passage occurs ${passage.occurrences} times on sheet ${passage.sheet}; the link points at the first.`);
      }
      warnings.push(...unlabelled(href, page, passage.sheet, finding.usableLabels));
    }
  }
  warnings.push(...(await checkCitations(actor, checker, citations)));
  return warnings;
}

/** A citation in a body that points at a passage: what it said, the link it renders, its quotation's absence, and its work. */
type CitationToCheck = { kind: "quote" | "pdf"; referent: string; markdown: string; href: string | null; quotationFound: boolean; refId: string };

/** Every citation in `bodies` whose referent is a quotation or a `/pdf/` passage, with the link its rendering gives it. */
async function citationsIn(bodies: unknown[]): Promise<CitationToCheck[]> {
  const found: CitationToCheck[] = [];
  for (const body of bodies) {
    if (!body || typeof body !== "object") continue;
    const json = body as JSONContent;
    const chips = chipsInJSON(json);
    if (!chips.some((chip) => chip.kind === CITATION && typeof chip.data.referent === "string")) continue;
    const inputs = await chipInputsForBody(json);
    const renderings = chipRenderings(chips, inputs.styles, inputs.context);
    const markdown = chipMarkdowns(chips, inputs.styles, inputs.context);
    chips.forEach((chip, index) => {
      const referent = chip.data.referent;
      const kind = chip.kind === CITATION && typeof referent === "string" ? referentKind(referent) : null;
      if (!kind || kind === "elsewhere" || typeof referent !== "string") return;
      found.push({
        kind,
        referent,
        markdown: markdown.get(chip.iid) ?? referent,
        href: renderings[index].href,
        quotationFound: chip.quotation !== null,
        refId: String((chip.data.items as { refId?: unknown }[] | undefined)?.[0]?.refId ?? ""),
      });
    });
  }
  return found;
}

/**
 * Each citation's passage against its work's PDF, as the cited-page route
 * would place it: a quotation the cited page doesn't hold, and a `/pdf/`
 * referent naming another work's PDF, are refused as `no_match`. A PDF the
 * actor can't read is not asked about, and one the work hasn't got only
 * warns, since its passage is never shown.
 */
async function checkCitations(actor: Actor, checker: FragmentChecker, citations: readonly CitationToCheck[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const citation of citations) {
    if (citation.kind === "quote" && !citation.quotationFound) {
      warnings.push(`${citation.markdown}: no quotation is ${citation.referent === "quote:prev" ? "right before" : "after"} it, so it links to its page.`);
      continue;
    }
    if (citation.kind === "pdf") {
      const reference = await prismaIncludingDeleted.reference.findUnique({ where: { id: citation.refId }, select: { fileId: true } });
      const link = parseFragmentLinkHref(citation.referent, appOrigin());
      const named = link ? await resolveFileParam(link.slug, { id: true }) : null;
      if (!reference?.fileId) {
        warnings.push(`${citation.markdown}: its work has no PDF, so its passage is never shown.`);
        continue;
      }
      if (named && named.file.id !== reference.fileId) {
        throw new ApiError("no_match", `${citation.markdown} names a PDF other than its work's own, which is where its passage is looked for.`, { link: citation.referent });
      }
      // Its passages were checked as the fragment link it is, above.
      continue;
    }
    const cited = citation.href ? parseCitedHref(citation.href, null) : null;
    if (!cited) continue;
    const finding = await checkCitedHref(checker, cited, { canRead: (file) => canUserReadFile(actor.userId, actor.role, file) });
    if (finding.kind === "no-pdf") warnings.push(`${citation.markdown}: its work has no PDF, so its quotation is never shown.`);
    else if (finding.kind === "unreadable-query") throw invalid(`${citation.markdown}: its quotation makes no passage.`);
    else if (finding.kind === "no-such-page") {
      throw new ApiError("no_match", `${citation.markdown} cites page ${finding.page}, ${NO_SUCH_LABEL}.`, { link: citation.href });
    } else if (finding.kind === "missed") {
      throw new ApiError("no_match", `${citation.markdown}: its quotation isn't on p. ${cited.page}, the page it cites (sheet ${finding.sheet} of the PDF).`, {
        link: citation.href,
        matchedUpTo: finding.matchedUpTo,
        pageHasThere: finding.pageHasThere,
        ...(finding.foundOnPage !== null ? { foundOnPage: finding.foundOnPage } : {}),
      });
    } else if (finding.kind === "placed") {
      for (const piece of finding.passages) {
        if (piece.occurrences > 1) warnings.push(`${citation.markdown}: its quotation occurs ${piece.occurrences} times on page ${piece.sheet}; the link points at the first.`);
      }
    }
  }
  return warnings;
}
