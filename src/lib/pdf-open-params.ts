// The page a PDF's fragment opens at: `#sheet=<n>`, the 1-based sheet, or
// `#p=<label>`, the page printed on it (docs/PDF_FRAGMENT_LINKS.md §2), with
// the version whose sheets or labels it counts, `&v=<n>` (docs/PDF.md §13,
// "Links into the file"). `#page=<n>` is read as `sheet=` for good, as Acrobat
// and every browser's built-in viewer take it, so every link written before
// `sheet=` keeps working; nothing writes it any more. Search links a page hit
// with one or the other (docs/FULLTEXT.md §7). The other parameters (`zoom`,
// `nameddest`, …) are ignored rather than half-supported.
//
// Pure and browser-safe, so the parsing is a unit test.

/**
 * A page in one of its two forms: a sheet, as `sheet=` gives one (1-based), or
 * a printed label, as `p=` gives one. Which sheets a label names depends on
 * the labels of the version it is read on, so only `sheetsNamed`
 * (src/lib/pdf-page-labels.ts) turns one into sheets.
 */
export type PageForm = { sheet: number } | { label: string };

/**
 * Which page a fragment names, **as a parser returns it**: its form, and the
 * version its `v=` stamps it with. A missing `v` is a reading, never an
 * omission: the link names the file's first version, or on a version's own
 * address that version (`namedVersion`, src/lib/pdf-link-reading.ts).
 */
export type PageName = PageForm & { v?: number };

/**
 * What a writer says of the version a page is on: its number, or `"sole"` for
 * a file that has one version, whose links carry no stamp. `pageStampFor`
 * (src/lib/file-version.ts) is the rule.
 */
export type PageStamp = number | "sole";

/**
 * A page **as a writer names it**: its form with its stamp. `formatPageName`
 * takes this and never a `PageName`, so every writer must fill the stamp and
 * the compiler names each of them: with one type for both, an unstamped name
 * would pass from a parser to a writer unseen, and once a file has a second
 * version a link without `v=` means its first.
 */
export type StampedPageName = PageForm & { stamp: PageStamp };

/** The parameters that name a page: a sheet by `sheet`, or by `page`, its older name; a printed page by `p`. */
export type PageParam = "sheet" | "page" | "p";

/**
 * A `sheet`, `page` or `p` parameter's page, or null for one whose value doesn't read:
 * a sheet that isn't a positive whole number, a label that is empty once
 * trimmed or holds a malformed escape. `+` in a label is a space, as it is in
 * a `text` value.
 */
export function pageNameOf(name: PageParam, value: string): PageForm | null {
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
 * A `v` parameter's version: digits alone, from 1, as a version's address
 * writes its number. Null for anything else, which is then no stamp at all,
 * as an unreadable `sheet` is no page.
 */
export function versionStampOf(value: string): number | null {
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}

/**
 * A fragment's parameters as the readers below walk them: `&`-separated, in
 * order, each split at its first `=`. One without an `=` (an annotation's
 * permalink fragment) is left out.
 */
function* paramsOf(fragment: string): Generator<{ name: string; value: string; raw: string }> {
  for (const raw of fragment.replace(/^#/, "").split("&")) {
    const equals = raw.indexOf("=");
    if (equals < 0) continue;
    yield { name: raw.slice(0, equals), value: raw.slice(equals + 1), raw };
  }
}

/**
 * The page a fragment asks for: its first readable `sheet`, `page` or `p`,
 * with the `v` that stamps it, or null when it asks for none. The fragment's
 * parameters are `&`-separated, as the convention writes them
 * (`#sheet=3&zoom=200`); an annotation's permalink fragment has no `=` at all
 * and yields null. Clamping to the document's length is the viewer's job,
 * since only it knows the length, and so is finding a label's sheet, since
 * only it has the labels.
 *
 * **A `v=` belongs to the page before it**: the first readable one between
 * that page and the next page parameter. One before any page is ignored.
 */
export function pageFromHash(hash: string): PageName | null {
  let page: PageForm | null = null;
  for (const { name, value } of paramsOf(hash)) {
    if (isPageParam(name)) {
      if (page) return page;
      page = pageNameOf(name, value);
    } else if (name === "v" && page) {
      const v = versionStampOf(value);
      if (v !== null) return { ...page, v };
    }
  }
  return page;
}

/**
 * A page as a fragment writes it, without `&` or `#`: `sheet=<n>`, or
 * `p=<label>` with the label percent-encoded wherever it holds anything but
 * ASCII letters, digits, `.` and `-` (nearly every label is digits or a Roman
 * numeral, and needs none); then `&v=<n>`, straight after it, unless the file
 * has one version (docs/PDF.md §13, "Links into the file").
 */
export function formatPageName(page: StampedPageName): string {
  const stamp = page.stamp === "sole" ? "" : `&v=${page.stamp}`;
  if ("sheet" in page) return `sheet=${page.sheet}${stamp}`;
  const encoded = page.label.replace(/[^A-Za-z0-9.-]/gu, (ch) =>
    encodeURIComponent(ch).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  );
  return `p=${encoded}${stamp}`;
}

/**
 * A fragment with every page parameter that has no `v=` of its own stamped
 * `v=<version>`, straight after it, and everything else as written: what a
 * link read on a version's own address becomes when it is offered on another
 * address, since there the address no longer says which version it names
 * (docs/PDF.md §13, "Addresses": `/pdf/book/v/2#sheet=49` is offered as
 * `/pdf/book#sheet=49&v=2`). Without its `#`.
 */
export function stampFragment(fragment: string, version: number): string {
  const params = fragment.replace(/^#/, "").split("&");
  const out: string[] = [];
  // The index in `out` of the last readable page parameter still waiting for its `v`.
  let unstamped: number | null = null;
  const settle = () => {
    if (unstamped !== null) out.splice(unstamped + 1, 0, `v=${version}`);
    unstamped = null;
  };
  for (const raw of params) {
    const equals = raw.indexOf("=");
    const name = equals < 0 ? "" : raw.slice(0, equals);
    const value = equals < 0 ? "" : raw.slice(equals + 1);
    if (isPageParam(name)) {
      settle();
      out.push(raw);
      if (pageNameOf(name, value)) unstamped = out.length - 1;
    } else {
      if (name === "v" && unstamped !== null && versionStampOf(value) !== null) unstamped = null;
      out.push(raw);
    }
  }
  settle();
  return out.join("&");
}
