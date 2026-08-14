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
