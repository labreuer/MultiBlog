"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { replaceReferenceRecord } from "@/app/actions/references";
import type { CslData } from "@/lib/references/csl";
import { downloadHref } from "@/lib/references/export-formats";
import { parseReferences } from "@/lib/references/import";
import account from "@/styles/account.module.css";
import styles from "./ReferencesTable.module.css";

// docs/CITATIONS.md, "Replacing a record", "Replace record" on a row of
// /references: one record in any format the import reads, parsed in the
// browser as the import box parses, the fields that change shown, and saved
// in place of the reference's record. A field the pasted record lacks is
// removed. The repair for a record with no DOI or ISBN, which no import can
// match. The box starts from the reference's CSL-JSON download.

type Change = { field: string; before: string | null; after: string | null };

const shown = (value: unknown) => (value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value));

/** The fields that differ between two records, each as it reads before and after. */
function changesBetween(before: CslData, after: CslData): Change[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((field) => field !== "id" && field !== "citation-key").sort();
  return fields.flatMap((field) => (shown(before[field]) === shown(after[field]) ? [] : [{ field, before: shown(before[field]), after: shown(after[field]) }]));
}

export default function ReferenceReplaceBox({ id, referenceKey, onClose }: { id: string; referenceKey: string; onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [current, setCurrent] = useState<CslData | null>(null);
  const [next, setNext] = useState<{ data: CslData; notes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(downloadHref("csl-json", `key=${encodeURIComponent(referenceKey)}`))
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("The record couldn’t be read."))))
      .then(async (json) => {
        if (!live) return;
        setText(json);
        const read = await parseReferences(json);
        setCurrent(read.references[0]?.data ?? null);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [referenceKey]);

  async function compare() {
    setError(null);
    setNext(null);
    const read = await parseReferences(text);
    if (read.references.length !== 1) {
      setError(read.errors[0] ?? (read.references.length === 0 ? "That holds no record." : "That holds more than one record; paste the one to replace it with."));
      return;
    }
    const [record] = read.references;
    setNext({ data: record.data, notes: [...read.errors, ...record.notes.map((note) => ("field" in note ? `${note.field}: ${note.kind}` : `${note.scheme} “${note.raw}” fails its check and is left out`))] });
  }

  async function save() {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await replaceReferenceRecord(id, next.data);
      router.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The record couldn’t be replaced.");
    } finally {
      setBusy(false);
    }
  }

  const changes = next && current ? changesBetween(current, next.data) : null;
  return (
    <section className={styles.replaceBox} aria-label={`Replace the record of ${referenceKey}`}>
      <h2>Replace the record of {referenceKey}</h2>
      <p>
        Paste one record, in any format the import reads; the record it has now is here to start from. A field the new record lacks
        is removed. Its key, abbreviation, PDF and citations stay.
      </p>
      <textarea className={styles.importBox} aria-label="The new record" value={text} onChange={(event) => (setText(event.target.value), setNext(null))} spellCheck={false} disabled={busy} />
      <button type="button" className={account.button} onClick={() => void compare()} disabled={busy || !text.trim()}>
        Compare
      </button>{" "}
      <button type="button" className={account.button} onClick={onClose} disabled={busy}>
        Cancel
      </button>
      {error && <p className={styles.refused}>{error}</p>}
      {changes && (
        <>
          {changes.length === 0 ? (
            <p>Nothing changes.</p>
          ) : (
            <ul className={styles.importReport} aria-label="What changes">
              {changes.map((change) => (
                <li key={change.field}>
                  <strong>{change.field}</strong>: {change.before === null ? "added" : change.after === null ? "removed" : "changed"}
                  {change.before !== null && <span className={styles.changeBefore}> {change.before}</span>}
                  {change.after !== null && <span> → {change.after}</span>}
                </li>
              ))}
            </ul>
          )}
          {next!.notes.length > 0 && (
            <ul className={styles.previewNotes}>
              {next!.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
          <button type="button" className={account.button} onClick={() => void save()} disabled={busy || changes.length === 0}>
            Save
          </button>
        </>
      )}
    </section>
  );
}
