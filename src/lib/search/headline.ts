// docs/FULLTEXT.md §4, "Snippets" — `ts_headline`'s output, split into the
// pieces a page renders.
//
// **`ts_headline` does not escape the text around a match.** With its default
// `<b>` delimiters the result would be HTML assembled from the user's own
// words, so the delimiters here are private-use characters that no
// ProseMirror document or comment carries (and the SQL strips them from the
// source text first, so one can't be forged): U+E000 opens a match, U+E001
// closes it, U+E002 separates fragments. The result is parsed into plain
// strings, and a page renders each match in a `<mark>` through React — never
// through `dangerouslySetInnerHTML`.
//
// Pure and browser-safe, so the parsing is a unit test rather than a page.

export const MATCH_START = "";
export const MATCH_STOP = "";
export const FRAGMENT_DELIMITER = "";

/** Every delimiter, for the SQL's `translate()` that strips them from the source text. */
export const HEADLINE_DELIMITERS = MATCH_START + MATCH_STOP + FRAGMENT_DELIMITER;

/**
 * The options every body snippet is asked for with: at most two fragments,
 * each long enough to read as a phrase.
 */
export const SNIPPET_OPTIONS = [
  `StartSel=${MATCH_START}`,
  `StopSel=${MATCH_STOP}`,
  `FragmentDelimiter=${FRAGMENT_DELIMITER}`,
  "MaxFragments=2",
  "MaxWords=24",
  "MinWords=10",
].join(", ");

/** For a title: the whole of it, with every match marked. */
export const TITLE_OPTIONS = [`StartSel=${MATCH_START}`, `StopSel=${MATCH_STOP}`, "HighlightAll=true"].join(", ");

export type HeadlinePart = { text: string; match: boolean };
/** One fragment of a snippet: alternating plain and matched text. */
export type HeadlineFragment = HeadlinePart[];

/**
 * A headline as fragments of parts. Whitespace runs — a block boundary is a
 * newline in `prose_text` — read as one space, which is how the page would
 * render them anyway, and an unclosed match runs to the end of its fragment.
 * Empty fragments are dropped, so "" parses to [].
 */
export function parseHeadline(raw: string): HeadlineFragment[] {
  const fragments: HeadlineFragment[] = [];
  for (const piece of raw.split(FRAGMENT_DELIMITER)) {
    const parts: HeadlinePart[] = [];
    let match = false;
    let text = "";
    const flush = () => {
      if (text) parts.push({ text, match });
      text = "";
    };
    for (const char of piece.replace(/\s+/g, " ")) {
      if (char === MATCH_START) {
        flush();
        match = true;
      } else if (char === MATCH_STOP) {
        flush();
        match = false;
      } else {
        text += char;
      }
    }
    flush();
    // Trimmed at the fragment's edges only, so the space between a match and
    // its neighbour survives.
    if (parts.length > 0) {
      parts[0] = { ...parts[0], text: parts[0].text.trimStart() };
      const last = parts.length - 1;
      parts[last] = { ...parts[last], text: parts[last].text.trimEnd() };
    }
    const kept = parts.filter((part) => part.text !== "");
    if (kept.length > 0) fragments.push(kept);
  }
  return fragments;
}

/** Whether a parsed headline marks anything — false for a snippet of text the query didn't match. */
export function hasMatch(fragments: HeadlineFragment[]): boolean {
  return fragments.some((fragment) => fragment.some((part) => part.match));
}
