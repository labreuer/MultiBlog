"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { useFileDrop } from "@/components/useFileDrop";
import { FILE_LIMITS_PATH, contentTypeForKind, formatBytes, uploadKindForFilename, type FileLimits } from "@/lib/file-format";
import { sendFile, uploadFailureMessage } from "@/lib/upload-client";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "The upload", and §14, "What the page holds", item 6 — a
// manager's control for giving a file new bytes, on its manage page:
// `PUT /api/files/<id>?filename=…`, through /files' own sender, so a 50MB
// scan streams with progress and a proxy's refusal names the proxy.
//
// What it makes is a **candidate**: the file's next version, readable at once
// at its own address, while `/pdf/<slug>` shows what it did. The page stays
// where it is and refreshes, which shows the candidate's card.
//
// **Two boxes say which kind of new version it is**, each a button that opens
// the file picker and a drop target, with its line on what it means:
//
// - **a better copy** of the same text, a new scan or a corrected text
//   layer. Once the upload has answered, the versions section asks for the
//   page map between it and the latest (`onUploaded`), so the candidate's
//   card can show what would carry;
// - **a revised text**, a later draft. Nothing more runs.
//
// **The answer is not stored**, and no reader branches on it. What is there
// afterwards is a candidate with a page map or one without, and a manager
// may ask for the map later, on the candidate's card or its map page.
//
// **A drop is refused before anything is sent**: more than one file, a file
// that isn't a PDF, one over the site's limit. A drop elsewhere on the
// versions section has its default prevented (the browser would open the
// PDF in place of the page) and is answered with a line asking for one of the
// boxes (`useVersionsDropZone`).

/** Which kind of new version the uploader said it is. It decides only whether a page map is asked for. */
export type VersionKind = "better-copy" | "revised-text";

const STRAY = "Drop the PDF on one of the two boxes, so it says which kind of version it is.";

/** Whether a drag carries files, as opposed to text or a link. */
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/**
 * The versions section as a drop zone: whether a file is being dragged over
 * it, so both boxes are marked as targets, and whether the last drop missed
 * them. Its handlers go on the section. A drop on a box is the box's
 * (`useFileDrop`, which prevents the default first); one anywhere else in the
 * section has its default prevented here.
 */
export function useVersionsDropZone() {
  const [dragging, setDragging] = useState(false);
  const [stray, setStray] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
      setStray(false);
    },
    onDragOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
    },
    onDragLeave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      const onBox = event.target instanceof Element && event.target.closest("[data-version-drop]") !== null;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      setStray(!onBox);
    },
  };
  return { dragging, stray, clearStray: () => setStray(false), handlers };
}

type Props = {
  fileId: string;
  /** Why no version can be uploaded now (one waits, the file is deleted); null where one can. */
  refused: string | null;
  zone: ReturnType<typeof useVersionsDropZone>;
  /** The upload made a candidate. */
  onUploaded: (versionId: string, kind: VersionKind) => void;
};

export default function PdfVersionUploader({ fileId, refused, zone, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Set by the box that opens the picker. A revised text is the kind that runs nothing.
  const kindRef = useRef<VersionKind>("revised-text");
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

  const busy = progress !== null;
  const takes = refused === null && !busy;

  const upload = (files: File[], kind: VersionKind) => {
    setError(null);
    setNote(null);
    zone.clearStray();
    if (files.length !== 1) {
      setError("One version at a time: choose or drop a single PDF.");
      return;
    }
    const [file] = files;
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
      setProgress(null);
      if (outcome.kind !== "ok") {
        const message = uploadFailureMessage(outcome, file, limits);
        if (message) setError(message);
        return;
      }
      const answer = (outcome.body ?? {}) as { unchanged?: unknown; versionId?: unknown };
      if (answer.unchanged === true || typeof answer.versionId !== "string") {
        setNote("Those are this file's latest bytes already, so nothing was uploaded.");
        return;
      }
      onUploaded(answer.versionId, kind);
    });
  };

  const pick = (kind: VersionKind) => {
    kindRef.current = kind;
    inputRef.current?.click();
  };

  return (
    <div className={styles.manage} data-testid="pdf-version-uploader">
      {busy ? (
        <p className={styles.versionFacts} role="status">
          Uploading… {progress.total ? Math.round((progress.sent / progress.total) * 100) : 0}%
        </p>
      ) : (
        <div className={styles.dropBoxes}>
          <DropBox
            kind="better-copy"
            title="A better copy"
            enabled={takes}
            dragging={zone.dragging}
            onPick={pick}
            onFiles={upload}
            testId="pdf-upload-better-copy"
          >
            The same text: a new scan, or the same scan with its text corrected. Its pages are matched with the latest&apos;s, so that notes and links can be
            carried to it.
          </DropBox>
          <DropBox
            kind="revised-text"
            title="A revised text"
            enabled={takes}
            dragging={zone.dragging}
            onPick={pick}
            onFiles={upload}
            testId="pdf-upload-revised-text"
          >
            A later draft: nothing is matched, and each note is moved by its author, or stays.
          </DropBox>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        data-testid="pdf-version-file"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) upload(files, kindRef.current);
        }}
      />
      {refused !== null ? (
        <p className={styles.versionFacts} data-testid="pdf-upload-refused">
          {refused}
        </p>
      ) : (
        <p className={styles.versionFacts}>
          Either waits at its own address until it is promoted, and the file&apos;s address shows what it does now until then. Choose a box, or drop the PDF on
          one.
        </p>
      )}
      {(error || zone.stray) && (
        <p className={styles.manageError} role="alert" data-testid="pdf-upload-error">
          {zone.stray ? STRAY : error}
        </p>
      )}
      {note && !error && <p className={styles.versionFacts}>{note}</p>}
    </div>
  );
}

function DropBox({
  kind,
  title,
  enabled,
  dragging,
  onPick,
  onFiles,
  testId,
  children,
}: {
  kind: VersionKind;
  title: string;
  enabled: boolean;
  dragging: boolean;
  onPick: (kind: VersionKind) => void;
  onFiles: (files: File[], kind: VersionKind) => void;
  testId: string;
  children: React.ReactNode;
}) {
  const drop = useFileDrop((files) => onFiles(files, kind), enabled);
  const marked = enabled && dragging;
  return (
    <div
      className={`${styles.dropBox} ${marked ? styles.dropTarget : ""} ${drop.over ? styles.dropOver : ""}`}
      data-version-drop={kind}
      data-testid={`${testId}-box`}
      {...drop.handlers}
    >
      <button type="button" className={styles.manageButton} disabled={!enabled} data-testid={testId} onClick={() => onPick(kind)}>
        Upload {title.toLowerCase()}
      </button>
      <p className={styles.versionFacts}>{children}</p>
    </div>
  );
}
