// docs/MCP.md §15, "What `read` takes" — a MultiBlog URL, as a path or
// absolute on this instance, parsed into what it names. Pure, so the parse
// is a unit table (url.test.ts); resolving what it names, through slug
// history and each kind's read gate, is resolve.ts's.
//
// Every tool names objects this way, so a URL copied out of a doc, a search
// hit or an earlier result can be passed straight back. A bare id is
// accepted too, and resolve.ts tries each kind that has one.

export type ParsedRef =
  /** /doc/<slug or id>, with or without /edit. */
  | { kind: "doc"; param: string; fragment: string }
  /** /pdf/<slug>, with its fragment: #page=…, a fragment link's text=…, or an annotation card's name. */
  | { kind: "pdf"; slug: string; fragment: string }
  /** /files/<slug>: any file, a .docx included. */
  | { kind: "file"; slug: string }
  /** /annotations: the threads on every container the actor can read. */
  | { kind: "annotations" }
  /** /link/<id>, or a reading route carrying ?sel=<id>. */
  | { kind: "link"; id: string }
  /** /<yyyy>/<mm>/<dd>/<slug>, a post's public path, with a comment card's fragment perhaps. */
  | { kind: "post"; year: string; month: string; day: string; slug: string; fragment: string }
  /** /post/<id>/edit, and the post's other management pages. */
  | { kind: "post-id"; id: string; fragment: string }
  | { kind: "tag"; slug: string }
  | { kind: "author"; slug: string }
  /** Something with no URL of its own: an id, which resolve.ts looks up by kind. */
  | { kind: "id"; id: string }
  /** A URL some other tool answers: `search` for /search and the date archives. */
  | { kind: "elsewhere"; tool: string; path: string }
  | { kind: "unknown"; path: string };

/** A cuid, the shape every id here has: lowercase letters and digits, about 25 long. */
const ID_RE = /^c[a-z0-9]{20,32}$/;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * What `ref` names. `appOrigin` is this instance's origin (APP_URL): an
 * absolute URL on another host is "unknown" rather than read as a path here,
 * since its path would name something else entirely.
 */
export function parseRef(ref: string, appOrigin: string | null): ParsedRef {
  const trimmed = ref.trim();
  if (ID_RE.test(trimmed)) return { kind: "id", id: trimmed };

  let url: URL;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      url = new URL(trimmed);
      const here = appOrigin ? new URL(appOrigin) : null;
      if (!here || url.host !== here.host) return { kind: "unknown", path: trimmed };
    } else {
      url = new URL(trimmed.startsWith("/") ? trimmed : `/${trimmed}`, "https://ref.invalid");
    }
  } catch {
    return { kind: "unknown", path: trimmed };
  }

  const fragment = url.hash.replace(/^#/, "");
  const sel = url.searchParams.get("sel");
  const segments = url.pathname.split("/").filter(Boolean);
  const path = url.pathname;
  const [first, second, third] = segments;

  if (first === "doc" && second && (segments.length === 2 || (segments.length === 3 && third === "edit"))) {
    if (sel) return { kind: "link", id: sel };
    const param = decode(second);
    return param ? { kind: "doc", param, fragment } : { kind: "unknown", path };
  }
  if (first === "pdf" && second && segments.length === 2) {
    if (sel) return { kind: "link", id: sel };
    const slug = decode(second);
    return slug ? { kind: "pdf", slug, fragment } : { kind: "unknown", path };
  }
  if (first === "files" && second && (segments.length === 2 || (segments.length === 3 && third === "download"))) {
    const slug = decode(second);
    return slug ? { kind: "file", slug } : { kind: "unknown", path };
  }
  if (first === "annotations" && segments.length === 1) return { kind: "annotations" };
  if (first === "link" && second && segments.length === 2) return { kind: "link", id: second };
  if (first === "post" && second && segments.length >= 2) return { kind: "post-id", id: second, fragment };
  if (first === "tag" && second && segments.length === 2) {
    const slug = decode(second);
    return slug ? { kind: "tag", slug } : { kind: "unknown", path };
  }
  if (first === "authors" && second && segments.length === 2) {
    const slug = decode(second);
    return slug ? { kind: "author", slug } : { kind: "unknown", path };
  }
  if (first === "search" && segments.length === 1) return { kind: "elsewhere", tool: "search", path };
  if (first && /^\d{4}$/.test(first)) {
    if (segments.length === 4 && /^\d{2}$/.test(second ?? "") && /^\d{2}$/.test(third ?? "")) {
      const slug = decode(segments[3]);
      return slug
        ? { kind: "post", year: first, month: second, day: third, slug, fragment }
        : { kind: "unknown", path };
    }
    if (segments.length <= 3) return { kind: "elsewhere", tool: "search", path };
  }
  return { kind: "unknown", path };
}

/** The fragment's `key=value` parameters, in order, undecoded. */
export function fragmentParams(fragment: string): [string, string][] {
  return fragment
    .split("&")
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
    });
}

/** Whether a PDF fragment is a viewer fragment (page, text, zoom…) rather than an annotation card's name. */
export function isViewerFragment(fragment: string): boolean {
  return fragmentParams(fragment).some(([key]) => ["page", "text", "zoom", "nameddest", "search"].includes(key));
}
