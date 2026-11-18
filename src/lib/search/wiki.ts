// docs/WIKI.md, "Listing wiki pages" — searching wiki pages: docs whose
// `wikiName` is set, under the same read rule and filters as the docs kind,
// through a query of their own (docs.ts holds the halves both share). A hit
// shows the page's title, which is its name, and links to its address.
//
// Signed out the section is empty, as the docs section is: searching PUBLIC
// pages signed out would take the wiki read rule beyond the wiki's routes.

import { docHits, matchDocs } from "./docs";
import type { KindSearch } from "./context";
import type { DocHit } from "./types";

export const wikiSearch: KindSearch<DocHit> = {
  match: (ctx, query) => matchDocs(ctx, query, ["wiki"]),
  hits: docHits,
};

/**
 * Docs and wiki pages as one kind, ranked together: what the docs kind was
 * before the split, for a caller that knows no `wiki` kind (the MCP server's
 * search, through `search()`'s `wikiInDocs`). Each side's ids still come
 * through its own query.
 */
export const docsAndWikiSearch: KindSearch<DocHit> = {
  match: (ctx, query) => matchDocs(ctx, query, ["docs", "wiki"]),
  hits: docHits,
};
