// docs/CITATIONS.md, "What a record keeps", "Markup in a field" — the little
// markup a CSL-JSON text field may hold: `<i>`, `<b>`, `<sup>`, `<sub>`, and
// a `<span>` for small capitals or `nocase`. A title keeps those tags, in one
// spelling; every other tag, and every tag in any other field, is taken out
// with the text inside it kept.
//
// - A tag is a `<`, a `/` or not, and a letter, up to the next `>`. Any other
//   `<` is text, so "p < 0.05" keeps its sign.
// - Character references are decoded before the tags are read: Crossref
//   writes `&amp;` and `&#x2013;`, and its `&lt;i&gt;` is italics it meant.
//
// Pure and browser-safe.

export type TitleMark = "italic" | "bold" | "sup" | "sub" | "smallCaps" | "nocase";
export type TitleRun = { text: string; marks?: TitleMark[] };

/** A title field read back: its text, for everything that reads a title as words, and its runs, for what draws one. */
export type MarkedText = { text: string; runs: TitleRun[] };

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  shy: "­",
};

/** `&amp;`, `&#8211;` and `&#x2013;` as the characters they name; anything else is left as written. */
export function decodeCharacterReferences(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (whole, dec: string, hex: string, name: string) => {
    if (name) return NAMED[name] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)([^>]*)>/g;

/** Which kept mark an opening tag is, or null for one that is taken out. */
function markOf(name: string, attrs: string): TitleMark | null {
  switch (name.toLowerCase()) {
    case "i":
      return attrs.trim() ? null : "italic";
    case "b":
      return attrs.trim() ? null : "bold";
    case "sup":
      return attrs.trim() ? null : "sup";
    case "sub":
      return attrs.trim() ? null : "sub";
    case "span":
      if (/font-variant\s*:\s*small-caps/i.test(attrs)) return "smallCaps";
      if (/class\s*=\s*["']?nocase\b/i.test(attrs)) return "nocase";
      return null;
    default:
      return null;
  }
}

/** Every tag taken out, the text inside kept: what a field that isn't a title stores. */
export function stripTags(value: string): string {
  return value.replace(TAG, "");
}

const ORDER: TitleMark[] = ["italic", "bold", "smallCaps", "sup", "sub", "nocase"];

function sameMarks(a: readonly TitleMark[] | undefined, b: readonly TitleMark[] | undefined): boolean {
  return (a ?? []).join() === (b ?? []).join();
}

/** Adjacent runs with the same marks as one, and empty runs dropped. */
export function merged(runs: readonly TitleRun[]): TitleRun[] {
  const out: TitleRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, run.marks)) last.text += run.text;
    else out.push({ text: run.text, ...(run.marks?.length ? { marks: [...run.marks] } : {}) });
  }
  return out;
}

/**
 * A field as runs: each kept tag a mark over the text inside it, any other
 * tag taken out. A closing tag closes the nearest open tag of its name and
 * any opened inside it; one with no such tag open is taken out.
 */
export function titleRuns(value: string): TitleRun[] {
  const runs: TitleRun[] = [];
  const open: { name: string; mark: TitleMark | null }[] = [];
  const marks = () => ORDER.filter((mark) => open.some((tag) => tag.mark === mark));
  let at = 0;
  for (const match of value.matchAll(TAG)) {
    const [whole, closing, name, attrs] = match;
    runs.push({ text: value.slice(at, match.index), marks: marks() });
    at = match.index + whole.length;
    const lower = name.toLowerCase();
    if (closing) {
      const index = open.findLastIndex((tag) => tag.name === lower);
      if (index !== -1) open.length = index;
    } else if (!/\/\s*$/.test(attrs)) {
      open.push({ name: lower, mark: markOf(lower, attrs) });
    }
  }
  runs.push({ text: value.slice(at), marks: marks() });
  return merged(runs);
}

const TAGS: Record<TitleMark, [string, string]> = {
  italic: ["<i>", "</i>"],
  bold: ["<b>", "</b>"],
  sup: ["<sup>", "</sup>"],
  sub: ["<sub>", "</sub>"],
  smallCaps: ['<span style="font-variant:small-caps;">', "</span>"],
  nocase: ['<span class="nocase">', "</span>"],
};

/**
 * Runs as a field's markup, in the one spelling CSL-JSON gives each tag, a
 * tag left open across runs that share it; `maxText` bounds the text, not the
 * tags. Reading the result back gives the same runs.
 */
export function markupOf(runs: readonly TitleRun[], maxText = Infinity): string {
  let left = maxText;
  let out = "";
  const open: TitleMark[] = [];
  for (const run of merged(runs)) {
    if (left <= 0) break;
    const text = run.text.slice(0, left);
    left -= text.length;
    const marks = run.marks ?? [];
    // Keep the open tags this run shares, in order; close the rest, innermost first.
    let keep = 0;
    while (keep < open.length && marks.includes(open[keep])) keep++;
    while (open.length > keep) out += TAGS[open.pop()!][1];
    for (const mark of marks) {
      if (!open.includes(mark)) {
        open.push(mark);
        out += TAGS[mark][0];
      }
    }
    out += text;
  }
  while (open.length > 0) out += TAGS[open.pop()!][1];
  return out;
}

/** A title field's text alone: what a label, a key, a sort and the search vector read. */
export const runsText = (runs: readonly TitleRun[]): string => runs.map((run) => run.text).join("");

/** A stored title field as its text and its runs. */
export function markedText(value: string): MarkedText {
  const runs = titleRuns(value);
  return { text: runsText(runs), runs };
}

/** Plain text as a marked title, for a title that has no markup: a key standing in for a missing one. */
export const plainMarked = (text: string): MarkedText => ({ text, runs: text ? [{ text }] : [] });

/**
 * Runs as a title set in italics draws them: an italic run inside is roman,
 * as CSL sets the play's name in a book titled `A Commentary on <i>Hamlet</i>`.
 */
export function flippedItalics(runs: readonly TitleRun[]): TitleRun[] {
  return runs.map((run) => {
    const marks = run.marks ?? [];
    const flipped = marks.includes("italic") ? marks.filter((mark) => mark !== "italic") : ["italic" as const, ...marks];
    return { text: run.text, ...(flipped.length ? { marks: flipped } : {}) };
  });
}
