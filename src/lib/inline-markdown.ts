// docs/CITATIONS.md, "Markdown inside a citation" — the inline Markdown a
// citation's words before and after a work may hold, read into runs of text
// with their marks: emphasis, strong emphasis, strikethrough (`~~`) and code
// spans, with backslash escapes. Anything else is text, a link and raw HTML
// included: a chip is one link, and nothing in it is HTML.
//
// A parser of its own rather than marked's, because it runs in the live
// editor, where marked would be the whole of a Markdown parser shipped for a
// few characters of a chip. It follows CommonMark's rules for which
// delimiter runs may open and close, and its tests hold it to marked's
// answers.
//
// Browser-safe and dependency-free.

export type InlineMark = "bold" | "italic" | "strike" | "code";

/** A stretch of text and the marks on it, in a fixed order. */
export type InlineRun = { text: string; marks?: InlineMark[] };

const MARK_ORDER: readonly InlineMark[] = ["bold", "italic", "strike", "code"];

/** The element each mark is drawn as, outermost first in a run's order. */
export const RUN_TAGS: Record<InlineMark, "strong" | "em" | "s" | "code"> = { bold: "strong", italic: "em", strike: "s", code: "code" };

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;

type Delimiter = { kind: "delimiter"; char: "*" | "_" | "~"; count: number; length: number; opens: boolean; closes: boolean };
type Node = { kind: "text"; text: string } | { kind: "code"; text: string } | Delimiter | { kind: "marked"; mark: InlineMark; children: Node[] };

/** The code span opening at `start` (a run of `length` backticks): where it closes, or -1. */
function codeSpanEnd(src: string, start: number, length: number): number {
  for (let i = start + length; i < src.length; ) {
    if (src[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (src[i + run] === "`") run += 1;
    if (run === length) return i;
    i += run;
  }
  return -1;
}

function tokenize(src: string): Node[] {
  const nodes: Node[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ kind: "text", text });
    text = "";
  };
  for (let i = 0; i < src.length; ) {
    const char = src[i];
    if (char === "\\" && i + 1 < src.length && ASCII_PUNCTUATION.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (char === "`") {
      let length = 1;
      while (src[i + length] === "`") length += 1;
      const end = codeSpanEnd(src, i, length);
      if (end < 0) {
        text += "`".repeat(length);
        i += length;
        continue;
      }
      let code = src.slice(i + length, end).replace(/\n/g, " ");
      if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      nodes.push({ kind: "code", text: code });
      i = end + length;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      let length = 1;
      while (src[i + length] === char) length += 1;
      // Only `~~` strikes: Pandoc reads a single `~` as a subscript.
      if (char === "~" && length !== 2) {
        text += char.repeat(length);
        i += length;
        continue;
      }
      // The start and the end of the text count as whitespace.
      const before = i > 0 ? src[i - 1] : " ";
      const after = i + length < src.length ? src[i + length] : " ";
      const leftFlanking = !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before));
      const rightFlanking = !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after));
      // An underscore inside a word neither opens nor closes: snake_case_name.
      const opens = char === "_" ? leftFlanking && (!rightFlanking || PUNCTUATION.test(before)) : leftFlanking;
      const closes = char === "_" ? rightFlanking && (!leftFlanking || PUNCTUATION.test(after)) : rightFlanking;
      flush();
      nodes.push({ kind: "delimiter", char, count: length, length, opens, closes });
      i += length;
      continue;
    }
    text += char;
    i += 1;
  }
  flush();
  return nodes;
}

/** A delimiter that matched nothing, as the text it is. */
function literal(node: Node): Node[] {
  if (node.kind !== "delimiter") return [node];
  return node.count > 0 ? [{ kind: "text", text: node.char.repeat(node.count) }] : [];
}

/** CommonMark's emphasis pass: each closer, left to right, with the nearest opener that may pair with it. */
function pairDelimiters(nodes: Node[]): Node[] {
  let from = 0;
  for (;;) {
    let closerAt = -1;
    for (let k = from; k < nodes.length; k++) {
      const node = nodes[k];
      if (node.kind === "delimiter" && node.closes && node.count > 0) {
        closerAt = k;
        break;
      }
    }
    if (closerAt < 0) break;
    const closer = nodes[closerAt] as Delimiter;
    let openerAt = -1;
    for (let k = closerAt - 1; k >= 0; k--) {
      const node = nodes[k];
      if (node.kind !== "delimiter" || node.char !== closer.char || !node.opens || node.count === 0) continue;
      if (closer.char === "~") {
        if (node.count === 2 && closer.count === 2) openerAt = k;
        if (openerAt >= 0) break;
        continue;
      }
      // The rule of three: `*a**b*` isn't strong emphasis inside emphasis.
      const both = node.closes || closer.opens;
      if (both && (node.length + closer.length) % 3 === 0 && !(node.length % 3 === 0 && closer.length % 3 === 0)) continue;
      openerAt = k;
      break;
    }
    if (openerAt < 0) {
      from = closerAt + 1;
      continue;
    }
    const opener = nodes[openerAt] as Delimiter;
    const used = closer.char === "~" || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
    const mark: InlineMark = closer.char === "~" ? "strike" : used === 2 ? "bold" : "italic";
    const children = nodes.slice(openerAt + 1, closerAt).flatMap(literal);
    opener.count -= used;
    closer.count -= used;
    nodes.splice(openerAt + 1, closerAt - openerAt - 1, { kind: "marked", mark, children });
    let at = openerAt + 2;
    if (opener.count === 0) {
      nodes.splice(openerAt, 1);
      at -= 1;
    }
    if (closer.count === 0) nodes.splice(at, 1);
    from = at;
  }
  return nodes.flatMap(literal);
}

function addRun(runs: InlineRun[], text: string, marks: readonly InlineMark[]): void {
  if (!text) return;
  const ordered = MARK_ORDER.filter((mark) => marks.includes(mark));
  const last = runs.at(-1);
  if (last && (last.marks ?? []).join() === ordered.join()) last.text += text;
  else runs.push(ordered.length > 0 ? { text, marks: ordered } : { text });
}

function flatten(nodes: readonly Node[], marks: readonly InlineMark[], runs: InlineRun[]): void {
  for (const node of nodes) {
    if (node.kind === "text") addRun(runs, node.text, marks);
    else if (node.kind === "code") addRun(runs, node.text, [...marks, "code"]);
    else if (node.kind === "marked") flatten(node.children, marks.includes(node.mark) ? marks : [...marks, node.mark], runs);
  }
}

/** `runs` with adjacent runs that carry the same marks joined, and empty ones dropped. */
export function mergeRuns(runs: readonly InlineRun[]): InlineRun[] {
  const merged: InlineRun[] = [];
  for (const run of runs) addRun(merged, run.text, run.marks ?? []);
  return merged;
}

/** `markdown` as runs of text and their marks, adjacent runs with the same marks joined. */
export function inlineRuns(markdown: string): InlineRun[] {
  const runs: InlineRun[] = [];
  flatten(pairDelimiters(tokenize(markdown)), [], runs);
  return runs;
}

/** The text `runs` spell, with no marks. */
export function runsText(runs: readonly InlineRun[]): string {
  return runs.map((run) => run.text).join("");
}

/** Whether any of `runs` carries a mark: if none does, the text alone says everything. */
export function runsHaveMarks(runs: readonly InlineRun[]): boolean {
  return runs.some((run) => (run.marks?.length ?? 0) > 0);
}
