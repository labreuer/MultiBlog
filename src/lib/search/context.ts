// What every kind's search is handed (docs/FULLTEXT.md §4): who is asking,
// under whose rules, and the filters already resolved — and the two halves
// each kind implements.

import type { InstantRange } from "./dates";
import type { TsQuery } from "./sql";
import type { SearchActor, SearchScope } from "./types";

export type KindContext = {
  actor: SearchActor;
  scope: SearchScope;
  /** User ids from the author picker; empty means no author filter. */
  authorIds: string[];
  created: InstantRange | null;
  updated: InstantRange | null;
  /** A post to leave out, with its comments: the quote picker's own host post (§8). */
  excludePostId: string | null;
  /**
   * Tag ids: each kind keeps only what carries any of them (docs/MCP.md §11).
   * Empty means no tag filter. The ids are the caller's, resolved from slugs
   * through the soft-delete filter, so a deleted term narrows to nothing.
   */
  tagIds: string[];
  /**
   * One search's memo. A kind's readable candidates — §4's step 1 — are read
   * once however many queries then run over them, and typo correction runs
   * a dozen small ones (§5).
   */
  memo: Map<string, Promise<unknown>>;
};

/**
 * "Carries any of these terms" as a relation filter on a kind's `tagAnchors`:
 * a live assignment of a live term. Both deletions are spelled out, since a
 * relation filter goes around prisma.ts's soft-delete `$extends`, and
 * `tagAssignment` isn't in it at all (tag-data.ts).
 */
export function taggedWhere(tagIds: string[]) {
  return tagIds.length > 0
    ? { tagAnchors: { some: { assignment: { tagId: { in: tagIds }, deletedAt: null, tag: { deletedAt: null } } } } }
    : {};
}

/** `load()` once per search, under `key`. */
export function remember<T>(ctx: KindContext, key: string, load: () => Promise<T>): Promise<T> {
  let pending = ctx.memo.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load();
    ctx.memo.set(key, pending);
  }
  return pending;
}

/**
 * One kind's search, in §4's steps.
 *
 * `match` is steps 1 and 2: the readable ids under the filters, matched and
 * ranked inside — or, with no query, newest first — after every filter,
 * including the ones applied in JS. Its length is the section's count, and
 * typo correction counts hits with it.
 *
 * `hits` is steps 3 and 4 for the ids on screen: snippets, and what the page
 * shows. It reads nothing the ids weren't already admitted to.
 */
export type KindSearch<H> = {
  match(ctx: KindContext, query: TsQuery | null): Promise<string[]>;
  hits(ctx: KindContext, ids: string[], query: TsQuery | null): Promise<H[]>;
};
