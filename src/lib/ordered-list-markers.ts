// docs/DOC_IMPORT.md §12 — which line opens an ordered-list item, for every
// Markdown parse (docs, comments, annotations) and for a plain-text paste into
// an editor, and which marker the Markdown export writes for one. Used by
// `OrderedList` and `ListItem` in tiptap-schema.ts, which are TipTap's own
// with these in place of the package's tokenizer, paste rule and item marker.
//
// @tiptap/extension-list 3.29 takes digits, any run of Roman-numeral letters or
// any one or two letters, then `.` or `)` and a space, as a marker, so on its
// own it reads a paragraph opening "N. T. Wright" as a list lettered from N,
// and one opening "St. Augustine" as a list from 1, deleting the "St.". The
// rule here:
//
//   - digits: as the package has them, one space after `1.` or `1)`;
//   - one letter or a valid Roman numeral, then `.`: two spaces, a tab, or
//     the end of the line, since an initial or an abbreviation takes one;
//   - one letter or a valid Roman numeral, then `)`: one space;
//   - nothing else is a marker ("St", "cf", "Dr", "ok", "Iv", "iiii").
//
// A two-letter marker past `z` (`aa`, `ab`, …) is an item only where it is the
// next letter after the previous item at the same depth, so a lettered list
// longer than 26 reads back while "cf." still opens nothing.
//
// The tokenizer below is the package's (collectOrderedListItems,
// buildNestedStructure and their helpers, in
// node_modules/@tiptap/extension-list/src/ordered-list/utils.ts), none of
// which is exported, ported with this file's matcher in place of its regex,
// and with one addition: a lettered or Roman list ends at an item that isn't
// its next marker (continuesOrderedList), where the package's runs on through
// any item of any style. How lines group into items and nest is unchanged.

import type {
  JSONContent,
  MarkdownLexerConfiguration,
  MarkdownRendererHelpers,
  MarkdownToken,
  MarkdownTokenizer,
  RenderContext,
} from "@tiptap/core";
import { renderNestedMarkdownContent } from "@tiptap/core";
import { toRoman } from "@tiptap/extension-list";
import { Plugin } from "@tiptap/pm/state";

/** An ordered list's `type` attribute: letters or Roman numerals in either case, or null for numbers. */
export type OrderedListStyle = "a" | "A" | "i" | "I" | null;

/** A line that opens an ordered-list item under this file's rule. */
export type OrderedListLine = {
  indent: number;
  marker: string;
  delimiter: "." | ")";
  /** The text after the marker and its spacing; "" for a marker at the end of the line. */
  content: string;
};

const ITEM_SHAPE = /^(\s*)(\d+|[A-Za-z]+)([.)])(.*)$/;
const DIGITS = /^\d+$/;
const LOWER = /^[a-z]+$/;
const UPPER = /^[A-Z]+$/;
const ROMAN_DIGITS: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

/** `a` = 1 … `z` = 26, `aa` = 27: the counting the browser draws `<ol type="a">` with. */
function lettersToNumber(letters: string): number {
  let value = 0;
  for (const char of letters.toLowerCase()) value = value * 26 + (char.charCodeAt(0) - 96);
  return value;
}

function numberToLetters(value: number): string {
  let letters = "";
  for (let rest = value; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(97 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/** The value of a Roman numeral in its canonical form, all one case; null for anything else ("iiii", "Iv", "ic"). */
function romanValue(marker: string): number | null {
  if (!/^(?:[ivxlcdm]+|[IVXLCDM]+)$/.test(marker)) return null;
  const lower = marker.toLowerCase();
  let total = 0;
  for (let index = 0; index < lower.length; index++) {
    const digit = ROMAN_DIGITS[lower[index]];
    const next = ROMAN_DIGITS[lower[index + 1]] ?? 0;
    total += digit < next ? -digit : digit;
  }
  return total > 0 && toRoman(total) === lower ? total : null;
}

/** Whether `marker` can open a list: digits, one letter, or a valid Roman numeral. */
function opensList(marker: string): boolean {
  return DIGITS.test(marker) || /^[A-Za-z]$/.test(marker) || romanValue(marker) !== null;
}

/** Whether `marker` is the letter after `previous`, in the same case: `aa` after `z`. */
function isNextLetter(previous: string, marker: string): boolean {
  const sameCase = (LOWER.test(previous) && LOWER.test(marker)) || (UPPER.test(previous) && UPPER.test(marker));
  return sameCase && lettersToNumber(marker) === lettersToNumber(previous) + 1;
}

/** The letter `offset` places after (or before) `letters`, in its case. */
function shiftLetters(letters: string, offset: number): string {
  const shifted = numberToLetters(lettersToNumber(letters) + offset);
  return UPPER.test(letters) ? shifted.toUpperCase() : shifted;
}

function leadingWhitespace(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

/**
 * `line` as an ordered-list item, or null when it doesn't open one.
 * `previous` is the marker of the item before it at the same depth, if any:
 * only a letter after `z` needs it.
 */
export function matchOrderedListLine(line: string, previous?: string): OrderedListLine | null {
  const shape = ITEM_SHAPE.exec(line);
  if (!shape) return null;
  const [, indent, marker, delimiter, rest] = shape;
  if (!opensList(marker) && !(previous !== undefined && isNextLetter(previous, marker))) return null;

  const [, gap, content] = /^(\s*)(.*)$/.exec(rest)!;
  if (DIGITS.test(marker)) {
    // The package's own rule for numbers, unchanged: whitespace, then anything.
    if (gap === "") return null;
  } else if (content !== "") {
    // A letter or a numeral at the end of the line opens an (empty) item with
    // either delimiter. With text after it, `)` needs one space and `.` two.
    if (gap === "") return null;
    if (delimiter === "." && gap.length < 2 && !gap.includes("\t")) return null;
  }
  return { indent: indent.length, marker, delimiter: delimiter as "." | ")", content };
}

/**
 * `lines[index]` as the first item of a lettered list that starts past `z`
 * (`aa)`, `AB.  `), or null. Such a marker opens nothing alone, being two
 * letters like "cf" or "St", so it opens a list only when the next item at its
 * depth is the letter after it. What a serialized list from 27 looks like, and
 * nothing a sentence opens with.
 */
function matchLetteredPastZ(lines: string[], index: number): OrderedListLine | null {
  const marker = ITEM_SHAPE.exec(lines[index])?.[2];
  if (!marker || !/^(?:[a-z]{2,}|[A-Z]{2,})$/.test(marker)) return null;
  const item = matchOrderedListLine(lines[index], shiftLetters(marker, -1));
  if (!item) return null;
  for (let next = index + 1; next < lines.length; next++) {
    if (lines[next].trim() === "") continue;
    const indent = leadingWhitespace(lines[next]);
    if (indent > item.indent) continue;
    if (indent < item.indent) return null;
    return matchOrderedListLine(lines[next], marker)?.marker === shiftLetters(marker, 1) ? item : null;
  }
  return null;
}

/**
 * The style and start a list takes from its first marker and, when that one is
 * ambiguous, its second, the next item at the same depth.
 *
 * As Pandoc's fancy_lists reads a first marker: `i`/`I` is Roman 1, any
 * other single letter is a letter even where it is also a numeral (`c` is 3,
 * not 100; `v` is 22, not 5), and a longer valid numeral is Roman. Pandoc then
 * ends the list at an item in another style; TipTap keeps one list, so here a
 * second marker that continues the other reading decides instead: `v` then
 * `vi` is Roman from 5, `i` then `j` letters from 9, `cv` then `cw` letters
 * from 100. A one-item list has no second marker and keeps the first reading;
 * its one marker draws the same either way.
 */
export function resolveOrderedListMarker(first: string, second?: string): { type: OrderedListStyle; start: number } {
  if (DIGITS.test(first)) return { type: null, start: parseInt(first, 10) };
  const upper = UPPER.test(first);
  const roman = romanValue(first);
  const asRoman = { type: (upper ? "I" : "i") as OrderedListStyle, start: roman ?? 1 };
  const asLetter = { type: (upper ? "A" : "a") as OrderedListStyle, start: lettersToNumber(first) };
  if (roman === null) return asLetter;
  if (second !== undefined) {
    // The two successors never coincide, so the order of these is immaterial.
    if (second === orderedListMarker(asRoman.type, roman + 1)) return asRoman;
    if (second === orderedListMarker(asLetter.type, asLetter.start + 1)) return asLetter;
  }
  return first.length > 1 || first.toLowerCase() === "i" ? asRoman : asLetter;
}

/**
 * Whether an item marked `marker` continues the list whose items so far, at
 * its depth, are marked `previous` (at least one). A numbered list takes any
 * number, as CommonMark and the package have it, and ends at a letter. A
 * lettered or Roman list takes only its next marker, so it ends at a list of
 * another style, or a restart, written directly below it. The export writes
 * every list's markers in sequence, so two adjacent lists it wrote read back
 * as two unless they are both numbered, which CommonMark reads as one too.
 */
export function continuesOrderedList(previous: string[], marker: string): boolean {
  if (DIGITS.test(previous[0])) return DIGITS.test(marker);
  const { type, start } = resolveOrderedListMarker(previous[0], previous[1] ?? marker);
  return marker === orderedListMarker(type, start + previous.length);
}

function isTyped(type: unknown): type is "a" | "A" | "i" | "I" {
  return type === "a" || type === "A" || type === "i" || type === "I";
}

/** The marker, delimiter aside, for the item at `position` in a list of style `type`. Digits for a style with no form there (0, or below). */
export function orderedListMarker(type: unknown, position: number): string {
  if (!isTyped(type) || position < 1) return String(position);
  const marker = type === "a" || type === "A" ? numberToLetters(position) : toRoman(position);
  return type === type.toUpperCase() ? marker.toUpperCase() : marker;
}

/**
 * What the Markdown export writes before an ordered-list item: `1. ` for
 * numbers, as the package writes them, and `a) `, `iv) ` and so on for every
 * other style, which the rule above reads back with one space. `a.  ` would
 * read back too, but two spaces don't survive a hand or a model retyping the
 * text, and the schema keeps no delimiter to lose (docs/DOC_IMPORT.md §12).
 */
export function orderedListItemPrefix(type: unknown, position: number): string {
  return isTyped(type) && position >= 1 ? `${orderedListMarker(type, position)}) ` : `${position}. `;
}

/** ListItem's `renderMarkdown` inside an ordered list: the package's, with `orderedListItemPrefix` for its marker and a `start` of 0 kept. */
export function renderOrderedListItem(node: JSONContent, h: MarkdownRendererHelpers, ctx: RenderContext): string {
  const attrs = ctx.meta?.parentAttrs ?? {};
  const start = typeof attrs.start === "number" ? attrs.start : 1;
  return renderNestedMarkdownContent(node, h, orderedListItemPrefix(attrs.type, start + (ctx.index || 0)));
}

// ---------------------------------------------------------------------------
// The tokenizer: the package's, with matchOrderedListLine for its regex.

// Blocks that can interrupt a paragraph, so a line opening with one is never
// lazy continuation text of an item.
const PARAGRAPH_INTERRUPTERS = [
  /^#{1,6}(?:\s|$)/,
  /^[-+*]\s+/,
  /^(?:```|~~~)/,
  /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/,
];

function isBlockContentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    PARAGRAPH_INTERRUPTERS[1].test(trimmed) ||
    matchOrderedListLine(trimmed) !== null ||
    PARAGRAPH_INTERRUPTERS[0].test(trimmed) ||
    // A dash rule directly below text is a setext heading's underline.
    (PARAGRAPH_INTERRUPTERS[3].test(trimmed) && !trimmed.startsWith("-")) ||
    /^>\s?/.test(trimmed) ||
    PARAGRAPH_INTERRUPTERS[2].test(trimmed)
  );
}

function splitItemContent(contentLines: string[]): { paragraphLines: string[]; blockLines: string[] } {
  const paragraphLines: string[] = [];
  const blockLines: string[] = [];
  let atBlocks = false;
  for (const line of contentLines) {
    if (!atBlocks && (line.trim() === "" || (paragraphLines.length > 0 && isBlockContentLine(line)))) atBlocks = true;
    (atBlocks ? blockLines : paragraphLines).push(line);
  }
  return { paragraphLines, blockLines };
}

type CollectedItem = OrderedListLine & { contentLines: string[]; raw: string };

/** The items `lines` opens with, flat with their indentation, and how many lines they took. */
function collectItems(lines: string[]): [CollectedItem[], number] {
  const items: CollectedItem[] = [];
  // The marker of the latest item at each indentation, for isNextLetter.
  const previousAt = new Map<number, string>();
  const match = (at: number) => {
    const previous = previousAt.get(leadingWhitespace(lines[at]));
    return matchOrderedListLine(lines[at], previous) ?? (previous === undefined ? matchLetteredPastZ(lines, at) : null);
  };
  let index = 0;

  // The list's own markers so far, for continuesOrderedList: an item at the
  // first one's depth that doesn't continue them opens the next list instead,
  // which marked asks this tokenizer for once this one ends above it.
  const listMarkers: string[] = [];

  while (index < lines.length) {
    const item = match(index);
    if (!item) break;
    if (items.length === 0 || item.indent === items[0].indent) {
      if (listMarkers.length > 0 && !continuesOrderedList(listMarkers, item.marker)) break;
      listMarkers.push(item.marker);
    }
    for (const indent of [...previousAt.keys()]) if (indent > item.indent) previousAt.delete(indent);
    previousAt.set(item.indent, item.marker);

    const contentLines = [item.content];
    const itemLines = [lines[index]];
    let next = index + 1;
    let sawBlankLine = false;
    // Continuation lines, up to the next item at any depth.
    while (next < lines.length && !match(next)) {
      const line = lines[next];
      if (line.trim() === "") {
        contentLines.push("");
        sawBlankLine = true;
      } else if (/^\s/.test(line)) {
        // Indented: strip only the indentation actually there, up to the item's content column.
        contentLines.push(line.slice(Math.min(leadingWhitespace(line), item.indent + item.marker.length + 1)));
      } else if (sawBlankLine || PARAGRAPH_INTERRUPTERS.some((pattern) => pattern.test(line))) {
        break;
      } else {
        contentLines.push(line);
      }
      itemLines.push(line);
      next += 1;
    }

    items.push({ ...item, contentLines, raw: itemLines.join("\n") });
    index = next;
  }
  return [items, index];
}

/** A `list` token for `items`, whose own items are those at `baseIndent`, deeper ones nesting under the item before them. */
function listToken(items: CollectedItem[], baseIndent: number, lexer: MarkdownLexerConfiguration, raw: string): MarkdownToken {
  const siblings = items.filter((item) => item.indent === baseIndent);
  const { type, start } = resolveOrderedListMarker(siblings[0].marker, siblings[1]?.marker);
  const listItems: MarkdownToken[] = [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (item.indent !== baseIndent) {
      index += 1;
      continue;
    }
    const { paragraphLines, blockLines } = splitItemContent(item.contentLines);
    const tokens: MarkdownToken[] = [];
    const mainText = paragraphLines.join("\n").trim();
    if (mainText) tokens.push({ type: "paragraph", raw: mainText, tokens: lexer.inlineTokens(mainText) });
    const additional = blockLines.join("\n").trim();
    if (additional) tokens.push(...lexer.blockTokens(additional));

    let next = index + 1;
    while (next < items.length && items[next].indent > baseIndent) next += 1;
    const nested = items.slice(index + 1, next);
    if (nested.length > 0) tokens.push(...nestedListTokens(nested, lexer));

    listItems.push({ type: "list_item", raw: item.raw, tokens });
    index = next;
  }

  return { type: "list", ordered: true, start, typeMarker: type ?? undefined, items: listItems, raw };
}

/**
 * The lists `items` (an item's deeper items) make, at the shallowest depth
 * among them: one, or more where an item there doesn't continue the list
 * above it (continuesOrderedList), as the tokenizer splits lists at the top.
 */
function nestedListTokens(items: CollectedItem[], lexer: MarkdownLexerConfiguration): MarkdownToken[] {
  const baseIndent = Math.min(...items.map((item) => item.indent));
  const runs: CollectedItem[][] = [[]];
  let markers: string[] = [];
  for (const item of items) {
    if (item.indent === baseIndent) {
      if (markers.length > 0 && !continuesOrderedList(markers, item.marker)) {
        runs.push([]);
        markers = [];
      }
      markers.push(item.marker);
    }
    runs.at(-1)!.push(item);
  }
  return runs.map((run) => listToken(run, baseIndent, lexer, run.map((item) => item.raw).join("\n")));
}

export const orderedListTokenizer: MarkdownTokenizer = {
  name: "orderedList",
  level: "block",
  // As the package has it: marked already breaks a paragraph before a list
  // marker at a line's start, and probes `start` with `src.slice(1)`, so any
  // marker found here would be mid-line. Defined so marked doesn't probe
  // `tokenize` instead.
  start: () => -1,
  tokenize: (src, _tokens, lexer) => {
    // Every block start is offered here: refuse a non-list before splitting
    // the rest of the document into lines.
    const firstLineEnd = src.indexOf("\n");
    const firstLine = firstLineEnd === -1 ? src : src.slice(0, firstLineEnd);
    const marker = ITEM_SHAPE.exec(firstLine)?.[2];
    if (!marker) return undefined;
    const pastZ = /^[A-Za-z]{2,}$/.test(marker) && matchOrderedListLine(firstLine, shiftLetters(marker, -1)) !== null;
    if (!pastZ && !matchOrderedListLine(firstLine)) return undefined;

    const lines = src.split("\n");
    const [items, consumed] = collectItems(lines);
    if (items.length === 0) return undefined;
    const token = listToken(items, items[0].indent, lexer, lines.slice(0, consumed).join("\n"));
    return token.items!.length > 0 ? token : undefined;
  },
};

/**
 * OrderedList's `parseMarkdown` result, made to keep `start: 0` (the package
 * reads 0 as "no start") and to give an item with nothing after its marker
 * the empty paragraph the schema requires of every listItem.
 */
export function conformOrderedList<T>(parsed: T, token: MarkdownToken): T {
  const list = parsed as JSONContent;
  if (!list || Array.isArray(parsed) || list.type !== "orderedList") return parsed;
  return {
    ...list,
    ...(token.start === 0 ? { attrs: { ...list.attrs, start: 0 } } : {}),
    content: (list.content ?? []).map((item) =>
      item.type === "listItem" && !item.content?.length ? { ...item, content: [{ type: "paragraph" }] } : item,
    ),
  } as T;
}

// ---------------------------------------------------------------------------
// A plain-text paste into an editor: the package's paste rule, which makes a
// list of a clipboard holding only text when every line is an item and the
// markers run in sequence, under this file's marker rule. A one-line paste of
// "N. T. Wright says…" stays text.

/** `text` as an orderedList node when every non-blank line is an item and the markers count up from the first; else null. */
export function parsePlainTextOrderedList(text: string): JSONContent | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return null;

  const items: OrderedListLine[] = [];
  for (const [index, line] of lines.entries()) {
    const item = index === 0 ? (matchOrderedListLine(line) ?? matchLetteredPastZ(lines, 0)) : matchOrderedListLine(line, items.at(-1)!.marker);
    if (!item || item.content === "") return null;
    items.push(item);
  }

  const { type, start } = resolveOrderedListMarker(items[0].marker, items[1]?.marker);
  if (start < 1 || items.some((item, index) => item.marker !== orderedListMarker(type, start + index))) return null;

  return {
    type: "orderedList",
    attrs: { ...(type ? { type } : {}), ...(start !== 1 ? { start } : {}) },
    content: items.map((item) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text: item.content }] }],
    })),
  };
}

/** The package's paste plugin with parsePlainTextOrderedList as its parse. */
export function orderedListPastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste: (view, event) => {
        if (event.clipboardData?.getData("text/html")?.trim()) return false;
        const text = event.clipboardData?.getData("text/plain");
        const list = text ? parsePlainTextOrderedList(text) : null;
        if (!list) return false;
        try {
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodeFromJSON(list)));
          return true;
        } catch {
          return false;
        }
      },
    },
  });
}
