// What every kind's search is handed (docs/FULLTEXT.md §4): who is asking,
// under whose rules, the query, the filters already resolved, and which slice
// of the ordered hits is on screen.

import type { InstantRange } from "./dates";
import type { TsQuery } from "./sql";
import type { SearchActor, SearchScope } from "./types";

export type KindContext = {
  actor: SearchActor;
  scope: SearchScope;
  /** Null when there is no text: the kind lists its readable rows, newest update first. */
  query: TsQuery | null;
  /** User ids from the author picker; empty means no author filter. */
  authorIds: string[];
  created: InstantRange | null;
  updated: InstantRange | null;
  window: { offset: number; limit: number };
};

export type KindResult<H> = { total: number; hits: H[] };

export const NO_HITS: KindResult<never> = { total: 0, hits: [] };
