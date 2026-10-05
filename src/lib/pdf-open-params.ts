// The one PDF Open Parameter the viewer reads: `#page=<n>`, the 1-based page
// to open at, as Acrobat and every browser's built-in viewer take it. Search
// links a page hit this way (docs/FULLTEXT.md §7). The other parameters
// (`zoom`, `nameddest`, …) are ignored rather than half-supported.
//
// Pure and browser-safe, so the parsing is a unit test.

/**
 * The page a fragment asks for, or null when it asks for none. The fragment's
 * parameters are `&`-separated, as the convention writes them
 * (`#page=3&zoom=200`); an annotation's permalink fragment has no `=` at all
 * and yields null. Clamping to the document's length is the viewer's job,
 * since only it knows the length.
 */
export function pageFromHash(hash: string): number | null {
  for (const param of hash.replace(/^#/, "").split("&")) {
    const [name, value] = param.split("=");
    if (name === "page" && value !== undefined && /^\d+$/.test(value)) {
      const page = Number(value);
      return page >= 1 ? page : null;
    }
  }
  return null;
}
