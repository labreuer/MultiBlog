import { loadMentionContext } from "./kinds/mention-context";
import { MENTION } from "./kinds/mention";
import type { JSONContent } from "@tiptap/core";
import { relabelChips } from "./materialize";
import { chipsInJSON, chipTargets } from "./renderings";
import { DEFAULT_CHIP_STYLES, type ChipContext, type ChipInputs, type ChipOccurrence, type ChipStyles } from "./types";

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

/**
 * The inputs for a body already loaded and already gated by its page: the
 * styles, and the context for exactly the chips the body holds.
 *
 * `styles` are the body's own (docs/ENTITY_CHIPS.md, "Styling"): a doc's,
 * from its ydoc (`chipStylesOf`) or its cache column. A caller with none to
 * give, which is every note's body, gets each chip kind's default.
 */
export async function chipInputsForBody(body: JSONContent | null | undefined, styles: ChipStyles = DEFAULT_CHIP_STYLES): Promise<ChipInputs> {
  const chips = body ? chipsInJSON(body) : [];
  return { styles, context: chips.length > 0 ? await loadChipContext(chips) : {} };
}

/**
 * The same for several bodies a page shows at once, such as every note in a
 * rail: one context, loaded in one pass, that each body's chips resolve
 * against. Each body is still its own document to the rendering pass.
 */
export async function chipInputsForBodies(bodies: readonly (JSONContent | null | undefined)[]): Promise<ChipInputs> {
  const chips = bodies.flatMap((body) => (body ? chipsInJSON(body) : []));
  return { styles: DEFAULT_CHIP_STYLES, context: chips.length > 0 ? await loadChipContext(chips) : {} };
}

/**
 * `doc` as a cache column holds it (materialize.ts): each chip labelled from its target's
 * current record, in `styles`, the doc's own. No query for a body with no chip, which is returned as it
 * came.
 */
export async function materializeChipLabels(doc: JSONContent, styles: ChipStyles = DEFAULT_CHIP_STYLES): Promise<JSONContent> {
  if (chipsInJSON(doc).length === 0) return doc;
  return relabelChips(doc, await chipInputsForBody(doc, styles));
}
