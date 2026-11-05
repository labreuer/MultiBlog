// docs/ENTITY_CHIPS.md — the shapes every chip kind and every surface share.
// Browser-safe and dependency-free.

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
  label: string;
  /** Where the label links, in the doc's own views. Null unless `live`. */
  href: string | null;
  /**
   * Where a published post's reader is sent, which can differ: a post is
   * public, and what a doc's view links to may not be. Null unless `live`.
   */
  postHref: string | null;
  status: ChipStatus;
};

/** One chip as the doc-order pass meets it. */
export type ChipOccurrence = ChipAttrs & {
  /** Its position in the node it was collected from. */
  pos: number;
};

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
   * identities differ: the merge then keeps the old chip's instance id.
   */
  continues(prev: Data, next: Data): boolean;
  /** The ids of the records this chip's rendering reads from the context. */
  targets(data: Data): string[];
  /** This kind's style from a doc's raw entry, defaults filled in. */
  parseStyle(raw: unknown): Style;
  /** The context's entry for this kind, or an empty one when it is missing or malformed. */
  parseContext(raw: unknown): Context;
  /**
   * Every chip of this kind in the doc, in doc order, to its rendering, in
   * the same order. One call per doc, so a kind can number its chips or tell
   * apart two entities that would share a label.
   */
  render(chips: readonly Data[], style: Style, context: Context): ChipRendering[];
};
