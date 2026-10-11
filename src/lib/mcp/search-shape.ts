import type { SearchResult, SearchSection } from "@/lib/search";
import { clip, bylineOf, dayOf, markedSnippet } from "./shape";

// docs/MCP.md §14 — a search result as the model reads it: one handle per hit
// (its `url`, or an annotation's id, since its card's fragment changes when
// its writer renames themselves), snippets as one string with matches in
// `**…**`, a byline as one string of names, dates as days, and nothing that
// only the search page uses — no author picker, no `readableKinds`, and no
// `params` as applied, since a parameter the parse would have changed is
// refused instead.
//
// Twenty doc hits with every field came to 3,463 tokens, 1,062 of them
// snippets; shaped this way, to about 2,200.

/** How much of an annotation's quoted passage a hit carries; a read of its thread has the rest. */
const QUOTE_CHARS = 200;

export function shapeSection(section: SearchSection): Record<string, unknown>[] {
  switch (section.kind) {
    case "docs":
      return section.hits.map((hit) => ({
        url: hit.href,
        title: markedSnippet(hit.title),
        byline: bylineOf(hit.byline),
        updated: dayOf(hit.updatedAt),
        chars: hit.chars,
        snippet: markedSnippet(hit.snippet),
      }));
    case "posts":
      return section.hits.map((hit) => ({
        url: hit.href,
        title: markedSnippet(hit.title),
        byline: bylineOf(hit.byline),
        ...(hit.status !== "published" ? { status: hit.status } : {}),
        ...(hit.publishedAt ? { published: dayOf(hit.publishedAt) } : {}),
        snippet: markedSnippet(hit.snippet),
      }));
    case "pdfs":
      return section.hits.map((hit) => ({
        url: hit.href,
        title: markedSnippet(hit.title),
        updated: dayOf(hit.updatedAt),
        ...(hit.pages.length > 0
          ? {
              pages: hit.pages.map((page) => ({
                page: page.page,
                ...(page.label ? { label: page.label } : {}),
                snippet: markedSnippet(page.snippet),
              })),
            }
          : {}),
        ...(hit.morePages > 0 ? { morePages: hit.morePages } : {}),
      }));
    case "annotations":
      return section.hits.map((hit) => {
        const quote = markedSnippet(hit.quote);
        return {
          id: hit.id,
          on: hit.container.href,
          title: hit.container.title,
          by: hit.writer,
          ...(hit.writerSlug ? { bySlug: hit.writerSlug } : {}),
          ...(hit.parentId ? { replyTo: hit.parentId } : {}),
          ...(hit.status === "RAISED" ? { status: "RAISED" } : {}),
          posted: dayOf(hit.postedAt),
          ...(hit.editedAt ? { edited: dayOf(hit.editedAt) } : {}),
          snippet: markedSnippet(hit.snippet),
          ...(quote ? { quote: clip(quote, QUOTE_CHARS) } : {}),
        };
      });
    case "comments":
      return section.hits.map((hit) => ({
        url: hit.href,
        by: hit.commenter,
        post: hit.postTitle,
        at: dayOf(hit.createdAt),
        ...(hit.editedAt ? { edited: dayOf(hit.editedAt) } : {}),
        snippet: markedSnippet(hit.snippet),
      }));
  }
}

/** The sections, each with its total, its hits and the cursor for its next page when it was paged. */
export function shapeSearch(result: SearchResult, nextFor?: (section: SearchSection) => string | undefined): Record<string, unknown> {
  if (result.status === "stop-words") {
    return { status: "stop-words", note: "Every word in q is too common to search for." };
  }
  return {
    ...(result.corrected ? { corrected: true } : {}),
    ...(result.withoutAuthors.length > 0 ? { withoutAuthors: result.withoutAuthors } : {}),
    sections: result.sections.map((section) => {
      const next = nextFor?.(section);
      return { kind: section.kind, total: section.total, hits: shapeSection(section), ...(next ? { next } : {}) };
    }),
  };
}
