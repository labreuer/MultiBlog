// The page a PDF's fragment opens at: `#sheet=<n>`, the 1-based sheet, or
// `#p=<label>`, the page printed on it (docs/PDF_FRAGMENT_LINKS.md §2).
// `#page=<n>` is read as `sheet=` for good, as Acrobat and every browser's
// built-in viewer take it, so every link written before `sheet=` keeps
// working; nothing writes it any more. Search links a page hit with one or the
// other (docs/FULLTEXT.md §7). The other parameters (`zoom`, `nameddest`, …)
// are ignored rather than half-supported.
//
// Pure and browser-safe, so the parsing is a unit test.

/**
 * Which page a fragment names: a sheet, as `sheet=` gives one (1-based), or a
 * printed label, as `p=` gives one. Which sheets a label names depends on the
 * file's labels, so only `sheetsNamed` (src/lib/pdf-page-labels.ts) turns one
 * into sheets.
 */
export type PageName = { sheet: number } | { label: string };

/** The parameters that name a page: a sheet by `sheet`, or by `page`, its older name; a printed page by `p`. */
export type PageParam = "sheet" | "page" | "p";

/**
 * A `sheet`, `page` or `p` parameter's page, or null for one whose value doesn't read:
 * a sheet that isn't a positive whole number, a label that is empty once
 * trimmed or holds a malformed escape. `+` in a label is a space, as it is in
 * a `text` value.
 */
export function pageNameOf(name: PageParam, value: string): PageName | null {
  if (name !== "p") return /^\d+$/.test(value) && Number(value) >= 1 ? { sheet: Number(value) } : null;
  let label: string;
  try {
    label = decodeURIComponent(value.replace(/\+/g, " ")).trim();
  } catch {
    return null;
  }
  return label ? { label } : null;
}

/** Whether a fragment parameter's name is one of the three that name a page. */
export function isPageParam(name: string): name is PageParam {
  return name === "sheet" || name === "page" || name === "p";
}

/**
 * The page a fragment asks for: its first readable `sheet`, `page` or `p`, or
 * null when it asks for none. The fragment's parameters are `&`-separated, as
 * the convention writes them (`#sheet=3&zoom=200`); an annotation's permalink
 * fragment has no `=` at all and yields null. Clamping to the document's
 * length is the viewer's job, since only it knows the length, and so is
 * finding a label's sheet, since only it has the labels.
 */
export function pageFromHash(hash: string): PageName | null {
  for (const param of hash.replace(/^#/, "").split("&")) {
    const equals = param.indexOf("=");
    if (equals < 0) continue;
    const name = param.slice(0, equals);
    if (!isPageParam(name)) continue;
    const page = pageNameOf(name, param.slice(equals + 1));
    if (page) return page;
  }
  return null;
}

/**
 * A page as a fragment parameter, without `&` or `#`: `sheet=<n>`, or
 * `p=<label>` with the label percent-encoded wherever it holds anything but
 * ASCII letters, digits, `.` and `-` (nearly every label is digits or a Roman
 * numeral, and needs none).
 */
export function formatPageName(page: PageName): string {
  if ("sheet" in page) return `sheet=${page.sheet}`;
  const encoded = page.label.replace(/[^A-Za-z0-9.-]/gu, (ch) =>
    encodeURIComponent(ch).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  );
  return `p=${encoded}`;
}
