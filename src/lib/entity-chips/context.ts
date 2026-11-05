import { loadMentionContext } from "./kinds/mention-context";
import { MENTION } from "./kinds/mention";
import { chipTargets } from "./renderings";
import type { ChipContext, ChipOccurrence } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 5 — the chip context, server-side: the
// records a set of chips' renderings are computed from, one query per chip
// kind. Server-only (Prisma); `index`-side code that runs in a browser takes
// a context as an argument and never loads one.

const LOADERS: Record<string, (ids: readonly string[]) => Promise<unknown>> = {
  [MENTION]: loadMentionContext,
};

/** The context for `chips`: each kind's records for the targets its chips name, deleted ones included. */
export async function loadChipContext(chips: readonly ChipOccurrence[]): Promise<ChipContext> {
  const entries = await Promise.all(
    Object.entries(chipTargets(chips))
      .filter(([kind]) => Object.hasOwn(LOADERS, kind))
      .map(async ([kind, ids]) => [kind, await LOADERS[kind](ids)] as const),
  );
  return Object.fromEntries(entries);
}
