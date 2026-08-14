"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshFilesListing } from "@/app/actions/files";
import {
  FILE_LIMITS_PATH,
  FILE_UPLOAD_PATH,
  formatBytes,
  proxyRejectedUploadMessage,
  type FileLimits,
} from "@/lib/file-format";
import styles from "./FileUploader.module.css";

// PLAN.md §19 — the upload control above the /files table.
//
// **XMLHttpRequest, not fetch, and that is the whole point of this component.**
// Two things need it. Upload progress: `fetch` has no request-progress event at
// all, and a 50MB upload with no feedback is indistinguishable from a hang. And
// error attribution: when a reverse proxy rejects a body it either answers 413
// or severs the connection mid-send, and through `fetch` the second case
// arrives as an opaque `TypeError: Failed to fetch` with nothing to
// distinguish it from the wifi dropping. XHR reports it as `status === 0` on
// the error event, which — combined with the size we know we were sending — is
// enough to name the likely cause instead of shrugging.

const PROXY_SUSPECT_BYTES = 1024 * 1024;

export default function FileUploader({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [limits, setLimits] = useState<FileLimits | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [probing, setProbing] = useState(false);

  // Asked for rather than baked in: FILE_MAX_UPLOAD_BYTES is a bare env var so
  // a deployment can change it with a restart, which a NEXT_PUBLIC_ value
  // compiled into this bundle could not do. Fetched once on mount; a failure
  // leaves `limits` null, which only costs the client-side pre-check — the
  // server still enforces the real number.
  useEffect(() => {
    let cancelled = false;
    fetch(FILE_LIMITS_PATH)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FileLimits | null) => {
        if (!cancelled && data) setLimits(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = useCallback(
    (file: File) => {
      setError(null);
      setNote(null);

      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
        setError("Only PDF files can be uploaded.");
        return;
      }
      if (limits && file.size > limits.maxUploadBytes) {
        // Refused here, before a byte leaves the browser — the server would say
        // the same thing, but only after transferring the whole file to say it.
        setError(
          `"${file.name}" is ${formatBytes(file.size)}, over this site's ${formatBytes(limits.maxUploadBytes)} limit.`,
        );
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${FILE_UPLOAD_PATH}?filename=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Content-Type", "application/pdf");
      setProgress({ sent: 0, total: file.size });

      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) setProgress({ sent: event.loaded, total: event.total });
      });

      xhr.addEventListener("load", () => {
        setProgress(null);
        if (xhr.status >= 200 && xhr.status < 300) {
          setNote(`Uploaded ${file.name}.`);
          // The bytes went to a Route Handler, which can't revalidate the page
          // that called it; this Server Action is what refreshes the listing.
          refreshFilesListing()
            .then(() => router.refresh())
            .catch(() => router.refresh());
          return;
        }
        if (xhr.status === 413) {
          // Could be ours (file-storage.ts answers 413 over the limit) or the
          // proxy's. Ours is JSON with a message; nginx's is an HTML error
          // page, and that difference is what tells them apart.
          setError(parseError(xhr) ?? proxyRejectedUploadMessage(limits?.maxUploadBytes ?? file.size));
          return;
        }
        setError(parseError(xhr) ?? `Upload failed (HTTP ${xhr.status}).`);
      });

      xhr.addEventListener("error", () => {
        setProgress(null);
        // status 0 means the request never completed at the HTTP level: the
        // connection was refused, severed, or blocked. For a body big enough
        // to trip a default client_max_body_size, a proxy cutting us off is by
        // far the likeliest cause and worth naming; for a small one it really
        // is just the network.
        setError(
          file.size > PROXY_SUSPECT_BYTES
            ? proxyRejectedUploadMessage(limits?.maxUploadBytes ?? file.size)
            : "The upload failed — check your connection and try again.",
        );
      });

      xhr.addEventListener("abort", () => setProgress(null));
      xhr.send(file);
    },
    [limits, router],
  );

  // The deploy-time proxy check (PLAN.md §19). Sends a full-size throwaway body
  // the server discards, so an admin can find out whether nginx passes
  // MAX_UPLOAD_BYTES *before* someone's real upload does.
  const runProbe = useCallback(() => {
    if (!limits) return;
    setProbing(true);
    setError(null);
    setNote(null);

    const payload = new Blob([new Uint8Array(limits.maxUploadBytes)]);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${FILE_UPLOAD_PATH}?probe=1`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) setProgress({ sent: event.loaded, total: event.total });
    });
    xhr.addEventListener("load", () => {
      setProgress(null);
      setProbing(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        setNote(
          `Proxy check passed — a ${formatBytes(limits.maxUploadBytes)} body reached the app intact.`,
        );
      } else {
        setError(proxyRejectedUploadMessage(limits.maxUploadBytes));
      }
    });
    xhr.addEventListener("error", () => {
      setProgress(null);
      setProbing(false);
      setError(proxyRejectedUploadMessage(limits.maxUploadBytes));
    });
    xhr.send(payload);
  }, [limits]);

  const busy = progress !== null;

  return (
    <div
      className={styles.uploader}
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (busy) return;
        const file = event.dataTransfer.files[0];
        if (file) upload(file);
      }}
    >
      <button
        type="button"
        className={`${styles.dropZone} ${dragging ? styles.dragging : ""}`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Uploading…" : "Drop a PDF here, or click to choose one"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className={styles.hiddenInput}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice in a row still fires change.
          event.target.value = "";
          if (file) upload(file);
        }}
      />

      {isAdmin && limits && (
        <button type="button" className={styles.probeButton} disabled={busy || probing} onClick={runProbe}>
          {probing ? "Checking…" : `Check upload limit (${formatBytes(limits.maxUploadBytes)})`}
        </button>
      )}

      {progress && (
        <div className={styles.progressRow}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressBar}
              style={{ width: `${progress.total ? Math.round((progress.sent / progress.total) * 100) : 0}%` }}
            />
          </div>
          <span>
            {formatBytes(progress.sent)} / {formatBytes(progress.total)}
          </span>
        </div>
      )}

      {error && <p className={styles.error}>{error}</p>}
      {note && !error && <p className={styles.note}>{note}</p>}
      {limits && !busy && !error && !note && (
        <p className={styles.note}>PDF only, up to {formatBytes(limits.maxUploadBytes)}.</p>
      )}
    </div>
  );
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
