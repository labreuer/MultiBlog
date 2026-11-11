// docs/ENTITY_CHIPS.md — the shapes every chip kind and every surface share.
// Browser-safe and dependency-free.

import type { InlineRun } from "../inline-markdown";

/** The node's name in every schema that has one. */
export const ENTITY_CHIP = "entityChip";

/**
 * A chip's anchor text, forever (docs/ENTITY_CHIPS.md, rule 3): the node's
 * `leafText`, so a stored quote holds this where a chip is and nothing a
 * label does can detach it.
 */
export const CHIP_ANCHOR_TEXT = "\uFFFC";

/** The node's three attributes. They never change; a chip kind's own fields live in `data`. */
export type ChipAttrs = {
  /** The chip kind: `mention`, `citation`. */
  kind: string;
  /** The instance id: unique within its doc, kept for the chip's life. */
  iid: string;
  /** The chip kind's fields, as its validator stores them. */
  data: Record<string, unknown>;
};

/**
 * - `live`: the label, linked.
 * - `deleted`: the same label struck through and unlinked; the target's row
 *   is soft-deleted, and restoring it clears this, since nothing is stored.
 * - `unknown`: the id resolves to nothing, and the label is the chip kind's
 *   placeholder, struck through.
 */
export type ChipStatus = "live" | "deleted" | "unknown";

/** What a chip shows: computed wherever it is shown, never stored in a ydoc. */
export type ChipRendering = {
  /** The text a chip shows, with no formatting: what every surface reading a chip as text takes. */
  label: string;
  /**
   * The label again as runs of formatted text, when any of it is formatted (a
   * citation's words before and after a work are inline Markdown): what the
   * surfaces that draw a chip draw, the editor, a static render and a post's
   * linked text. Absent, the label is the whole of it.
   */
  runs?: InlineRun[];
  /** Where the label links, in the doc's own views. Null unless `live`. */
  href: string | null;
  /**
   * Where a published post's reader is sent, which can differ: a post is
   * public, and what a doc's view links to may not be. Null unless `live`.
   */
  postHref: string | null;
  status: ChipStatus;
};

/**
 * The words a citation whose referent is `quote:prev` or `quote:next` points
 * at, as the prose holds them (quotations.ts), and where they stand in the
 * node the chip was collected from, when that node has positions.
 */
export type Quotation = { text: string; from: number | null; to: number | null };

/** One chip as the doc-order pass meets it. */
export type ChipOccurrence = ChipAttrs & {
  /** Its position in the node it was collected from. */
  pos: number;
  /**
   * The quotation beside it, for a chip that points at one: found in the body
   * the chip was collected from, null when none is there. Absent for any other
   * chip, and for one collected with no body around it (a stored anchor's
   * record), whose rendering then links as if it pointed at none.
   */
  quotation?: Quotation | null;
};

/** What a chip's rendering reads from beside the chip, in the body it was collected from: never the body itself (docs/ENTITY_CHIPS.md, rule 2). */
export type ChipBeside = { quotation?: string | null };

/**
 * A doc's choice of form per chip kind, keyed by chip kind. Each kind parses
 * its own entry and falls back to its default for anything it doesn't
 * recognise, so a style written by a newer build still renders.
 */
export type ChipStyles = Record<string, unknown>;

/** The styles of a doc that has set none: every chip kind's own default. */
export const DEFAULT_CHIP_STYLES: ChipStyles = {};

/**
 * The records a doc's renderings are computed from, keyed by chip kind. Each
 * kind owns the shape of its entry.
 */
export type ChipContext = Record<string, unknown>;

/** What a surface's renderings are computed from, beside the document itself. */
export type ChipInputs = {
  styles: ChipStyles;
  context: ChipContext;
  /**
   * Target ids a browser has asked the server about and not yet heard back
   * on, per chip kind. A chip naming one shows a neutral placeholder rather
   * than its kind's "unknown" form, which would be a claim nobody has checked.
   * Never set on a server, which loads a context whole.
   */
  pending?: Record<string, readonly string[]>;
};

export const NO_CHIP_INPUTS: ChipInputs = { styles: DEFAULT_CHIP_STYLES, context: {} };

/**
 * What a chip kind supplies (docs/ENTITY_CHIPS.md, "The kind contract"). This
 * is the browser-safe part: fields, identity, forms and rendering. A kind's
 * context loader, Markdown and insertion rule live beside it, where their
 * dependencies are.
 */
export type ChipKind<Data = unknown, Style = unknown, Context = unknown> = {
  name: string;
  /**
   * `data` as this kind stores it, or null when it isn't a chip of this kind.
   * Every way in runs it: paste, the Markdown parse, an MCP edit. It drops
   * fields it doesn't know, so what is stored is only what it names.
   */
  validate(data: unknown): Data | null;
  /**
   * What the chip points at, as a string. Two chips of this kind are the same
   * entity when their identities are equal: the anchors' identity check and
   * the MCP merge's alignment both read it.
   */
  identity(data: Data): string;
  /**
   * Whether a chip holding `next` continues one that held `prev`, when their
   * identities differ. The merge then keeps the old chip's instance id, and
   * an anchor that recorded `prev` stays on that instance (`chipContinues`).
   */
  continues(prev: Data, next: Data): boolean;
  /** The ids of the records this chip's rendering reads from the context. */
  targets(data: Data): string[];
  /**
   * A fragment of `data` that every chip of this kind pointing at `targetId`
   * contains, as jsonb containment reads it, and no chip pointing elsewhere
   * does. The refresh finds stored chip records by it (refresh.ts), where no
   * index table can: a record outlives its chip.
   */
  naming(targetId: string): Record<string, unknown>;
  /** This kind's style from a doc's raw entry, defaults filled in. */
  parseStyle(raw: unknown): Style;
  /** The context's entry for this kind, or an empty one when it is missing or malformed. */
  parseContext(raw: unknown): Context;
  /**
   * Every chip of this kind in the doc, in doc order, to its rendering, in
   * the same order. One call per doc, so a kind can number its chips or tell
   * apart two entities that would share a label. `beside` is what each chip's
   * occurrence carries from the text beside it, in the same order: a
   * citation's quotation, found by the one finder (quotations.ts).
   */
  render(chips: readonly Data[], style: Style, context: Context, beside?: readonly ChipBeside[]): ChipRendering[];
  /**
   * One chip as Markdown (the kind contract, item 7), given the rendering
   * `render` made for it. The syntax is this kind's own, and its parse keys on
   * the syntax, never on the label, so a chip reads back as the same chip
   * whatever style the doc shows it in. A chip whose target is gone is written
   * with its stored id where a slug or key would go, so a round trip keeps it.
   */
  markdown(data: Data, rendering: ChipRendering, context: Context): string;
  /**
   * Whether the server's Markdown parse reads this kind's syntax back as a
   * chip. Where it doesn't, an edit can't write the chip back, and refuses
   * to replace a passage that holds one rather than drop it
   * (`unknown_kind`), as for a kind the server doesn't know at all.
   */
  readsMarkdown: boolean;
};
