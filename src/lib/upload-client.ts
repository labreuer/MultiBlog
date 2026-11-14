import { proxyRejectedUploadMessage, type FileLimits } from "@/lib/file-format";

// PLAN.md §19 — sending a file's bytes to an upload route from the browser,
// for /files' uploader (a new file) and the PDF page's (a new version of
// one, docs/PDF.md §13 "The upload"): one sender, so the two can't differ in
// their progress, their 413 or their severed-connection message.
//
// XMLHttpRequest rather than fetch, for upload progress and because a reverse
// proxy that cuts the connection mid-body is distinguishable here
// (`status === 0`, the `error` event) and opaque through fetch.
//
// Browser-only.

/** A body past this size that fails with no response was most likely cut by a proxy's own limit. */
const PROXY_SUSPECT_BYTES = 1024 * 1024;

export type UploadOutcome =
  /** A 2xx, with the route's JSON body. */
  | { kind: "ok"; body: unknown }
  /** Any other answer: its status, and the `error` of our own JSON body, or null for a page that isn't ours (nginx's). */
  | { kind: "refused"; status: number; error: string | null }
  /** No answer at all: the connection was cut, or never made. */
  | { kind: "severed" }
  | { kind: "aborted" };

/** Sends `file` as the raw body of one request, reporting progress as it goes. */
export function sendFile(opts: {
  method: "POST" | "PUT";
  url: string;
  file: File;
  contentType: string;
  onProgress: (sent: number, total: number) => void;
}): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method, opts.url);
    xhr.setRequestHeader("Content-Type", opts.contentType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) opts.onProgress(event.loaded, event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // An empty or non-JSON 2xx: the caller gets null.
        }
        resolve({ kind: "ok", body });
        return;
      }
      resolve({ kind: "refused", status: xhr.status, error: parseError(xhr) });
    });
    xhr.addEventListener("error", () => resolve({ kind: "severed" }));
    xhr.addEventListener("abort", () => resolve({ kind: "aborted" }));
    xhr.send(opts.file);
  });
}

/**
 * What to tell the uploader of an outcome that isn't `ok`, or null for an
 * abort, which they chose. A 413 with no message of ours, and a severed
 * connection on a body of any size, name the proxy explicitly, since neither
 * mentions nginx (docs/PDF.md §2a).
 */
export function uploadFailureMessage(outcome: Exclude<UploadOutcome, { kind: "ok" }>, file: File, limits: FileLimits | null): string | null {
  if (outcome.kind === "aborted") return null;
  if (outcome.kind === "severed") {
    return file.size > PROXY_SUSPECT_BYTES
      ? proxyRejectedUploadMessage(limits?.maxUploadBytes ?? file.size)
      : "The upload failed — check your connection and try again.";
  }
  if (outcome.status === 413) return outcome.error ?? proxyRejectedUploadMessage(limits?.maxUploadBytes ?? file.size);
  return outcome.error ?? `Upload failed (HTTP ${outcome.status}).`;
}

/** The `error` field of our own JSON error body, or null when the response isn't ours (an nginx HTML page). */
function parseError(xhr: XMLHttpRequest): string | null {
  try {
    const parsed = JSON.parse(xhr.responseText) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}
