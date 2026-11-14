"use client";

import { useEffect, useRef, useState } from "react";
import { FILE_LIMITS_PATH, contentTypeForKind, formatBytes, uploadKindForFilename, type FileLimits } from "@/lib/file-format";
import { sendFile, uploadFailureMessage } from "@/lib/upload-client";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "The upload" — a manager's control for giving a file new
// bytes: `PUT /api/files/<id>?filename=…`, through /files' own sender, so a
// 50MB scan streams with progress and a proxy's refusal names the proxy.
//
// What it makes is a **candidate**: the file's next version, readable at once
// at its own address, while `/pdf/<slug>` shows what it did. So a success goes
// to the candidate's page, by a full load, where it is promoted or abandoned.
// A full load because the viewer is behind `ssr: false`, where a
// `router.refresh()` alone is lost (CLAUDE.md), and the page it reaches is
// another version's anyway.

export default function PdfVersionUploader({ fileId }: { fileId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [limits, setLimits] = useState<FileLimits | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // As /files' uploader asks: the limit is a bare env var, changed with a restart.
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

  const upload = (file: File) => {
    setError(null);
    setNote(null);
    if (uploadKindForFilename(file.name) !== "pdf") {
      setError("A new version of a PDF is a PDF.");
      return;
    }
    if (limits && file.size > limits.maxUploadBytes) {
      setError(`"${file.name}" is ${formatBytes(file.size)}, over this site's ${formatBytes(limits.maxUploadBytes)} limit.`);
      return;
    }
    setProgress({ sent: 0, total: file.size });
    void sendFile({
      method: "PUT",
      url: `/api/files/${fileId}?filename=${encodeURIComponent(file.name)}`,
      file,
      contentType: contentTypeForKind("pdf"),
      onProgress: (sent, total) => setProgress({ sent, total }),
    }).then((outcome) => {
      if (outcome.kind !== "ok") {
        setProgress(null);
        const message = uploadFailureMessage(outcome, file, limits);
        if (message) setError(message);
        return;
      }
      const answer = (outcome.body ?? {}) as { unchanged?: unknown; url?: unknown };
      if (answer.unchanged === true || typeof answer.url !== "string") {
        setProgress(null);
        setNote("Those are this file's latest bytes already, so nothing was uploaded.");
        return;
      }
      // The candidate's own page. Progress stays up until the load replaces this one.
      window.location.assign(answer.url);
    });
  };

  const busy = progress !== null;
  return (
    <div className={styles.manage} data-testid="pdf-version-uploader">
      <button type="button" className={styles.manageButton} disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? `Uploading… ${progress.total ? Math.round((progress.sent / progress.total) * 100) : 0}%` : "Upload a new version"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        data-testid="pdf-version-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) upload(file);
        }}
      />
      <p className={styles.versionFacts}>
        A corrected scan, or a later draft. It waits at its own address until it is promoted, and this address shows what it does now until then.
      </p>
      {error && (
        <p className={styles.manageError} role="alert">
          {error}
        </p>
      )}
      {note && !error && <p className={styles.versionFacts}>{note}</p>}
    </div>
  );
}
