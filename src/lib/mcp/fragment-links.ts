import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { FragmentChecker, linkHrefsIn, parseFragmentLinkHref } from "@/lib/pdf-fragment-check";
import type { Actor } from "@/lib/actor";
import { ApiError, invalid } from "@/lib/api/errors";
import { appOrigin } from "./resolve";

// docs/MCP.md §8 — every fragment link in what the MCP server writes is
// checked before anything is written: create_doc's body, edit_doc's
// replacements and appends, and the bodies annotate and edit_annotation
// write. An agent fixes the quote in the same turn, where otherwise a broken
// link shows only when someone follows it.
//
// The check is the integrity script's and the one-quote CLI's
// (`FragmentChecker`), which reads as the operator — so the file's own read
// gate runs first, and a file the actor can't read is `not_found`, the same
// as one that doesn't exist, so the check can't be asked what a PRIVATE file
// says. It never extracts, and nothing is rewritten: the href stored is the
// one sent.

/** Checks each fragment link in `bodies`; refuses a miss, and answers warnings for a passage its page repeats. */
export async function checkFragmentLinks(actor: Actor, bodies: unknown[]): Promise<string[]> {
  const hrefs = [...new Set(bodies.flatMap((body) => linkHrefsIn(body)))];
  const checker = new FragmentChecker();
  const warnings: string[] = [];
  for (const href of hrefs) {
    const link = parseFragmentLinkHref(href, appOrigin());
    if (!link) continue;
    if (link.unread > 0 || link.passages.length === 0) {
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
    for (const passage of finding.passages) {
      const named = { page: passage.passage.page, start: passage.passage.start, ...(passage.passage.end ? { end: passage.passage.end } : {}) };
      if (passage.kind === "page-out-of-range") {
        throw new ApiError("no_match", `The fragment link ${href} names page ${passage.passage.page}, past the PDF's ${passage.pageCount}.`, {
          link: href,
          passage: named,
        });
      }
      if (passage.kind === "no-match") {
        throw new ApiError("no_match", `The fragment link ${href} doesn't find its passage on page ${passage.passage.page}.`, {
          link: href,
          passage: named,
          matchedUpTo: passage.matchedUpTo,
          pageHasThere: passage.pageHasThere,
          ...(passage.foundOnPage !== null ? { foundOnPage: passage.foundOnPage } : {}),
        });
      }
      if (passage.occurrences > 1) {
        warnings.push(`${href}: its passage occurs ${passage.occurrences} times on page ${passage.passage.page}; the link points at the first.`);
      }
    }
  }
  return warnings;
}
