"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { searchReferencesForFile, tieReferenceToFile, untieReferenceFromFile } from "@/app/actions/references";
import type { FileReference } from "@/lib/reference-files";
import SearchPicker from "../SearchPicker";
import styles from "./FileReferencesPanel.module.css";

// docs/CITATIONS.md, "A work's PDF" — in the PDF's Metadata pane, the
// references this file is the PDF of, and for an AUTHOR or above a picker
// that ties one, where you are right after uploading it. Several references
// can name one PDF, an anthology's chapters, say.
//
// It keeps its own list from what each action answers, never a refresh: it
// sits inside the viewer's `ssr: false` island, where a refresh delivers
// nothing (CLAUDE.md's invariant on `router.refresh()`).

export default function FileReferencesPanel({
  fileId,
  initial,
  canWrite,
  isPrivate,
}: {
  fileId: string;
  initial: FileReference[];
  canWrite: boolean;
  isPrivate: boolean;
}) {
  const [references, setReferences] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (references.length === 0 && !canWrite) return null;

  const run = (action: () => Promise<FileReference[]>) => {
    setError(null);
    startTransition(async () => {
      try {
        setReferences(await action());
      } catch (err) {
        setError(err instanceof Error ? err.message : "That didn't save.");
      }
    });
  };

  return (
    <section className={styles.panel} aria-label="The PDF of">
      <h3 className={styles.heading}>The PDF of</h3>
      {references.length > 0 ? (
        <ul className={styles.list}>
          {references.map((reference) => (
            <li key={reference.id} className={styles.item}>
              <Link href={`/references/${reference.key}`}>{reference.entry}</Link>
              {canWrite && (
                <button
                  type="button"
                  className={styles.remove}
                  disabled={pending}
                  aria-label={`Untie ${reference.key} from this PDF`}
                  title="This isn't its PDF"
                  onClick={() => run(() => untieReferenceFromFile(fileId, reference.id))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>No reference in the library names this as its PDF.</p>
      )}
      {canWrite && (
        <SearchPicker
          label="Add a reference"
          placeholder="Author, title or key"
          disabled={pending}
          search={async (query) =>
            (await searchReferencesForFile(fileId, query)).map((candidate) => ({
              id: candidate.id,
              label: candidate.entry,
              ...(candidate.elsewhere ? { note: "(moves it from another PDF)" } : {}),
            }))
          }
          onPick={(referenceId) => run(() => tieReferenceToFile(fileId, referenceId))}
        />
      )}
      {isPrivate && (
        <p className={styles.none}>
          This PDF is private, so a citation of it opens it only for people who may read it. Everyone else gets the
          reference&apos;s page.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
