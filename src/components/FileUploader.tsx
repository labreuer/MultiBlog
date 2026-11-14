"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshFilesListing } from "@/app/actions/files";
import {
  FILE_LIMITS_PATH,
  FILE_UPLOAD_PATH,
  UPLOAD_ACCEPT_ATTRIBUTE,
  UPLOAD_ACCEPT_LABEL,
  contentTypeForKind,
  formatBytes,
  proxyRejectedUploadMessage,
  uploadKindForFilename,
  type FileLimits,
} from "@/lib/file-format";
import { sendFile, uploadFailureMessage } from "@/lib/upload-client";
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

      // The same table the route decides with (src/lib/file-format.ts), so a
      // file this refuses is exactly a file that upload would have refused —
      // just without spending the transfer to find out. `file.type` is not
      // consulted: it is absent often enough to be unusable (a .docx dragged
      // from some file managers arrives as application/octet-stream), and it
      // is client-supplied either way. The bytes are checked server-side.
      const kind = uploadKindForFilename(file.name);
      if (!kind) {
        setError(`Only ${UPLOAD_ACCEPT_LABEL} files can be uploaded.`);
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

      setProgress({ sent: 0, total: file.size });
      // The sender is src/lib/upload-client.ts's, shared with the upload of a
      // new version of a file: progress, and the 413 and severed-connection
      // messages that name the proxy, since neither mentions nginx.
      void sendFile({
        method: "POST",
        url: `${FILE_UPLOAD_PATH}?filename=${encodeURIComponent(file.name)}`,
        file,
        contentType: contentTypeForKind(kind),
        onProgress: (sent, total) => setProgress({ sent, total }),
      }).then((outcome) => {
        setProgress(null);
        if (outcome.kind === "ok") {
          setNote(`Uploaded ${file.name}.`);
          // The route handler can't revalidate /files itself, so ask a Server
          // Action to; refresh either way, since a failed revalidation still
          // leaves a router cache worth refetching.
          refreshFilesListing()
            .then(() => router.refresh())
            .catch(() => router.refresh());
          return;
        }
        const message = uploadFailureMessage(outcome, file, limits);
        if (message) setError(message);
      });
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
        {busy ? "Uploading…" : `Drop a ${UPLOAD_ACCEPT_LABEL} file here, or click to choose one`}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
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
        <p className={styles.note}>
          {UPLOAD_ACCEPT_LABEL}, up to {formatBytes(limits.maxUploadBytes)}.
        </p>
      )}
    </div>
  );
}
