"use client";

import { useEffect, useRef, useState } from "react";
import { buildVersionMap } from "@/app/actions/files";
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
//
// **The uploader says which kind of new version it is** (§13, "The
// upload"), by which of two buttons opens the file picker:
//
// - **a better copy** of the same text, a new scan or a corrected text
//   layer. As soon as the upload has answered, this asks for the page map
//   between it and the latest (`buildVersionMap`), so the candidate's page
//   can show what would carry. The map is a request of its own, since
//   building one can take longer than an upload should wait;
// - **a revised text**, a later draft. Nothing more runs.
//
// **The answer is not stored**, and no reader branches on it. What is there
// afterwards is a candidate with a page map or one without, and a manager
// may ask for the map later, on the version's map page. A map that fails to
// build here leaves a candidate without one, which that page offers again.

/** Which kind of new version the uploader said it is. It decides only whether a page map is asked for. */
type VersionKind = "better-copy" | "revised-text";

export default function PdfVersionUploader({ fileId }: { fileId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Set by the button that opens the picker. A revised text is the kind that runs nothing.
  const kindRef = useRef<VersionKind>("revised-text");
  const [matching, setMatching] = useState(false);
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
      const answer = (outcome.body ?? {}) as { unchanged?: unknown; url?: unknown; versionId?: unknown };
      if (answer.unchanged === true || typeof answer.url !== "string") {
        setProgress(null);
        setNote("Those are this file's latest bytes already, so nothing was uploaded.");
        return;
      }
      const url = answer.url;
      // The candidate's own page. Progress stays up until the load replaces this one.
      if (kindRef.current !== "better-copy" || typeof answer.versionId !== "string") {
        window.location.assign(url);
        return;
      }
      // A better copy: its pages are matched with the latest's before its page opens.
      // The candidate's page offers the map again where this fails.
      setMatching(true);
      void buildVersionMap(answer.versionId)
        .catch(() => null)
        .then(() => window.location.assign(url));
    });
  };

  const busy = progress !== null;
  const pick = (kind: VersionKind) => {
    kindRef.current = kind;
    inputRef.current?.click();
  };
  return (
    <div className={styles.manage} data-testid="pdf-version-uploader">
      {busy ? (
        <button type="button" className={styles.manageButton} disabled>
          {matching ? "Matching its pages…" : `Uploading… ${progress.total ? Math.round((progress.sent / progress.total) * 100) : 0}%`}
        </button>
      ) : (
        <div className={styles.manageRow}>
          <button type="button" className={styles.manageButton} data-testid="pdf-upload-better-copy" onClick={() => pick("better-copy")}>
            Upload a better copy
          </button>
          <button type="button" className={styles.manageButton} data-testid="pdf-upload-revised-text" onClick={() => pick("revised-text")}>
            Upload a revised text
          </button>
        </div>
      )}
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
        A better copy holds the same text: a new scan, or the same scan with its text corrected. Its pages are matched with this version&apos;s, so that notes
        and links can be carried to it. A revised text is a later draft: nothing is matched, and each note is moved by its author, or stays. Either waits at
        its own address until it is promoted, and this address shows what it does now until then.
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
