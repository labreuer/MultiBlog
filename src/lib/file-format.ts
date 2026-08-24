// The browser-safe half of the uploaded-file feature (PLAN.md §19) — the same
// split src/lib/avatar-url.ts has against src/lib/avatar.ts, and for the same
// reason: FilesTable and the upload control are `"use client"`, and
// file-storage.ts imports `node:fs`, so anything both sides need has to live
// somewhere neither drags the other in.

/** Where the browser POSTs raw file bytes (PLAN.md §19) — not a Server Action, see the route's own header. */
export const FILE_UPLOAD_PATH = "/api/files/upload";

/** Where the browser asks what the server will actually accept, so the two can't hold different numbers. */
export const FILE_LIMITS_PATH = "/api/files/limits";

export type FileLimits = { maxUploadBytes: number };

/**
 * Human-readable size. Used by the /files Size column, by the upload control's
 * pre-flight refusal, and by file-storage.ts's own rejection messages — one
 * function so the number a user is told is the number they see in the table.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// PLAN.md §19 — the message shown when an upload dies in a way that means the
// reverse proxy, not the app, rejected it.
//
// Worth having as one string because the same misconfiguration surfaces two
// different ways and both need saying the same thing. nginx with a
// `client_max_body_size` below the app's limit answers **413 with its own HTML
// body** when it sees the Content-Length; if it instead cuts the connection
// mid-body, `fetch` rejects with an opaque `TypeError: Failed to fetch` and
// XMLHttpRequest reports `status === 0` — neither of which mentions nginx at
// all. Without this, the symptom is "large uploads just fail", which is a
// genuinely hard thing to diagnose from the browser.
export function proxyRejectedUploadMessage(maxUploadBytes: number): string {
  return (
    `The upload was rejected before it reached the app — this is almost always the reverse proxy, ` +
    `not the site. nginx's client_max_body_size defaults to 1MB and needs to be at least ` +
    `${formatBytes(maxUploadBytes)}; see deploy/nginx-app.conf.sample.`
  );
}

// PLAN.md §19 Phase 1 — which formats an upload may be, stated once for both
// sides. The browser filters its file picker with ACCEPT_ATTRIBUTE and refuses
// an obvious mismatch before spending an upload; the route decides the same
// question again from the same table, because a client-side check is a
// courtesy and never the enforcement.
//
// PDF and .docx are deliberately not treated alike beyond this point. A PDF is
// parsed at upload (src/lib/pdf-extract.ts) because its page text is what a
// later annotation anchors into, so a file that cannot be read is rejected
// rather than stored. A .docx is only checked for being a zip: nothing renders
// or anchors into one yet, so a deep parse would buy nothing and would reject
// documents we can happily hold.
export type UploadKind = "pdf" | "docx";

type UploadFormat = {
  kind: UploadKind;
  extension: string;
  contentType: string;
  /** How this format is named to a person, in an error they can act on. */
  label: string;
};

const FORMATS: readonly UploadFormat[] = [
  { kind: "pdf", extension: ".pdf", contentType: "application/pdf", label: "PDF" },
  {
    kind: "docx",
    extension: ".docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word (.docx)",
  },
];

/** The file input's `accept`: both the MIME types and the extensions, since browsers disagree on which they honour. */
export const UPLOAD_ACCEPT_ATTRIBUTE = FORMATS.flatMap((f) => [f.contentType, f.extension]).join(",");

/** "PDF or Word (.docx)" — for the uploader's own prompt and its refusal message. */
export const UPLOAD_ACCEPT_LABEL = FORMATS.map((f) => f.label).join(" or ");

/**
 * The format an upload claims to be, by extension.
 *
 * Extension rather than the browser's `file.type`: that is absent often enough
 * to be unusable on its own (a `.docx` dragged from some file managers arrives
 * as `application/octet-stream`), and it is client-supplied either way. What
 * actually decides is the magic-number check the route runs on the stored
 * bytes — this only picks which check to run.
 */
export function uploadKindForFilename(filename: string): UploadKind | null {
  const lower = filename.toLowerCase();
  return FORMATS.find((f) => lower.endsWith(f.extension))?.kind ?? null;
}

/** The `Content-Type` a stored file of this kind is served as. */
export function contentTypeForKind(kind: UploadKind): string {
  const format = FORMATS.find((f) => f.kind === kind);
  if (!format) throw new Error(`Unknown upload kind: ${kind}`);
  return format.contentType;
}

/** The title an uploaded file gets: its filename without the format's extension. */
export function titleFromFilename(filename: string, kind: UploadKind | null): string {
  if (!kind) return filename;
  const format = FORMATS.find((f) => f.kind === kind);
  if (!format) return filename;
  return filename.slice(0, -format.extension.length) || filename;
}
