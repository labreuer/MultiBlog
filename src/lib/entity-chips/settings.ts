import type * as Y from "yjs";
import { chipKinds } from "./registry";
import type { ChipStyles } from "./types";

// docs/ENTITY_CHIPS.md, "Styling" — a doc's choice of form per chip kind
// lives in the doc's own ydoc, in a `Y.Map` beside the `clients` map every
// doc already has. So:
//
//  - an open editor updates the moment a collaborator changes it, with no
//    refresh and no second channel;
//  - the history shows each version in the style it had, since replaying to
//    a version replays this map too;
//  - a tab from before chips existed can't touch it, knowing nothing of it;
//  - changing it is an edit, and the ordinary store relabels the doc's
//    `prose_json`. `Doc.chipStyles` is its cache, written by that store, as
//    `title` is.
//
// One key per chip kind, `chips.<kind>`, holding that kind's style as plain
// JSON. Per kind rather than one object for them all, so two people setting
// different kinds' styles at once both keep theirs: a `Y.Map` key is
// last-writer-wins as a whole.
//
// Browser-safe: this only reads and writes a Y.Doc it is handed.

export const SETTINGS_MAP = "settings";
const CHIP_STYLE_PREFIX = "chips.";

/** A style blob is a few fields; anything bigger is not a style. */
const MAX_STYLE_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Styles from an untrusted value (a column, a request): each chip kind's
 * entry kept only if it is a small plain object. A kind this build doesn't
 * know is kept as it is, since a newer build wrote it and will read it
 * again; each kind's `parseStyle` is what makes sense of its own entry.
 */
export function parseChipStyles(raw: unknown): ChipStyles {
  if (!isRecord(raw)) return {};
  const styles: ChipStyles = {};
  for (const [kind, style] of Object.entries(raw)) {
    if (isRecord(style) && JSON.stringify(style).length <= MAX_STYLE_LENGTH) styles[kind] = style;
  }
  return styles;
}

/** The styles a doc's ydoc holds: empty for a doc that has set none. */
export function chipStylesOf(doc: Y.Doc): ChipStyles {
  const raw: Record<string, unknown> = {};
  doc.getMap(SETTINGS_MAP).forEach((value, key) => {
    if (key.startsWith(CHIP_STYLE_PREFIX)) raw[key.slice(CHIP_STYLE_PREFIX.length)] = value;
  });
  return parseChipStyles(raw);
}

/**
 * Sets one chip kind's style in a doc, or clears it with null so the kind's
 * default applies again. The style is normalized by its kind first, so what
 * is stored is only what that kind understands; a kind this build doesn't
 * know is refused, there being nothing to check it with.
 */
export function setChipStyle(doc: Y.Doc, kind: string, style: unknown): boolean {
  const known = chipKinds().find((candidate) => candidate.name === kind);
  if (!known) return false;
  const settings = doc.getMap(SETTINGS_MAP);
  const key = `${CHIP_STYLE_PREFIX}${kind}`;
  if (style === null) {
    if (settings.has(key)) settings.delete(key);
    return true;
  }
  const next = known.parseStyle(style) as Record<string, unknown>;
  if (JSON.stringify(settings.get(key)) !== JSON.stringify(next)) settings.set(key, next);
  return true;
}

/**
 * Calls `onChange` with the doc's styles whenever they change, and once at
 * the start if it already holds any. Returns the unsubscribe.
 *
 * Not at the start for a doc holding none: a Y.Doc that hasn't synced yet
 * holds none either, and reporting that as "no style" would repaint every
 * chip in its default form for the moment before the real answer arrives.
 */
export function observeChipStyles(doc: Y.Doc, onChange: (styles: ChipStyles) => void): () => void {
  const settings = doc.getMap(SETTINGS_MAP);
  const initial = chipStylesOf(doc);
  let last = JSON.stringify(initial);
  const handler = () => {
    const styles = chipStylesOf(doc);
    const now = JSON.stringify(styles);
    if (now === last) return;
    last = now;
    onChange(styles);
  };
  settings.observe(handler);
  if (Object.keys(initial).length > 0) onChange(initial);
  return () => settings.unobserve(handler);
}

/** Whether two style sets are the same, key order aside. */
export function sameChipStyles(a: ChipStyles, b: ChipStyles): boolean {
  const canon = (styles: ChipStyles) =>
    JSON.stringify(
      Object.keys(styles)
        .sort()
        .map((kind) => [kind, Object.entries(styles[kind] as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1))]),
    );
  return canon(a) === canon(b);
}
