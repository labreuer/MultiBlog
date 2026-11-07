"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { importReferencesAction, type ImportReport } from "@/app/actions/references";
import account from "@/styles/account.module.css";
import styles from "./ReferencesTable.module.css";

// docs/CITATIONS.md, "Who writes them" — adding works to the library by
// pasting BibTeX, RIS or CSL-JSON, one record or many. Each record stands
// alone: one already in the library is shown with the key it has there, one
// that can't be kept is shown with why, and the rest are added.

export default function ReferenceImport() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await importReferencesAction(text);
        setReport(result);
        // What was added is now in the table below; what wasn't stays in the box to be corrected.
        if (result.outcomes.length > 0 && result.outcomes.every((outcome) => outcome.status !== "refused") && result.errors.length === 0) setText("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "The import failed.");
      }
    });
  }

  return (
    <details className={styles.importPanel}>
      <summary>Add references</summary>
      <label>
        Paste BibTeX, RIS or CSL-JSON, one record or many.
        <textarea
          className={styles.importBox}
          aria-label="References to import"
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          disabled={pending}
        />
      </label>
      <button type="button" className={account.button} onClick={submit} disabled={pending || text.trim() === ""}>
        Import
      </button>
      {error && <p className={styles.refused}>{error}</p>}
      {report && (
        <ul className={styles.importReport} aria-label="Import results">
          {report.format === null && report.errors.length === 0 && <li>Nothing to import.</li>}
          {report.outcomes.map((outcome, index) => (
            <li key={index} className={outcome.status === "refused" ? styles.refused : undefined}>
              {outcome.status === "created" && (
                <>
                  Added <Link href={`/references/${outcome.key}`}>{outcome.key}</Link>: {outcome.title}
                </>
              )}
              {outcome.status === "duplicate" && (
                <>
                  Already in the library as <Link href={`/references/${outcome.key}`}>{outcome.key}</Link>
                  {outcome.deleted ? " (deleted; restore it from the table)" : ""}: {outcome.title}
                </>
              )}
              {outcome.status === "refused" && (
                <>
                  Not added, “{outcome.title}”: {outcome.error}
                </>
              )}
            </li>
          ))}
          {report.errors.map((message, index) => (
            <li key={`error-${index}`} className={styles.refused}>
              {message}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
