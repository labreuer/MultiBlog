"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { importReferenceBatchAction, previewReferenceImportAction } from "@/app/actions/references";
import type { ImportOutcome, KeyNote, PreviewAnswer } from "@/lib/reference-write";
import { cutBatches } from "@/lib/references/batches";
import { citedNames, keyBaseOf, titleOf, yearOf } from "@/lib/references/csl";
import { identifiersOf } from "@/lib/references/identifiers";
import { parseReferences, type ImportedReference, type ReadNote } from "@/lib/references/import";
import { referencePath } from "@/lib/references/keys";
import TitleRuns from "@/components/bibliography/TitleRuns";
import account from "@/styles/account.module.css";
import styles from "./ReferencesTable.module.css";

// docs/CITATIONS.md, "The import box" — adding works to the library from
// what another tool exports: pasted, or picked as files, several at once,
// read in the browser into one list. A preview shows each record before
// anything is written: what it is, the key it will get and why that isn't
// its source's, what reading it dropped, cut or mapped, and whether the
// library already holds it. Import then sends the records in batches, one
// server action each, with a running count.

/** How many records one preview question asks about. */
const PREVIEW_CHUNK = 500;

type Row = { reference: ImportedReference; answer: PreviewAnswer };
type Phase = "edit" | "reading" | "preview" | "importing" | "done";

/** A note as the preview words it. */
function noteText(note: ReadNote): string {
  switch (note.kind) {
    case "cut":
      return `${note.field} cut to its length`;
    case "dropped":
      return `${note.field}: no CSL field holds it, so it is left out`;
    case "mapped":
      return `type “${note.from}” read as ${note.to}`;
    case "undefined":
      return `${note.field}: empty, or an @string the file doesn’t define, so it is left out`;
    case "identifier":
      return `${note.scheme} “${note.raw}” fails its check and is left out; correct it in the box first to keep it`;
  }
}

/** Why a record's key isn't its source's. */
function keyNoteText(note: KeyNote): string {
  switch (note.reason) {
    case "taken":
      return `its own key, ${note.sourceKey}, is another reference’s`;
    case "alias":
      return `${note.sourceKey} isn’t a library key; it will still find this one`;
    case "unfit":
      return `${note.sourceKey} isn’t a library key, and can’t be kept as another name for it`;
  }
}

export default function ReferenceImport() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [phase, setPhase] = useState<Phase>("edit");
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  async function pickFiles(list: FileList | null) {
    setFiles(await Promise.all([...(list ?? [])].map(async (file) => ({ name: file.name, text: await file.text() }))));
  }

  async function read() {
    setFailure(null);
    setPhase("reading");
    try {
      const sources = [...files.map((file) => ({ label: file.name, text: file.text })), ...(text.trim() ? [{ label: "The box", text }] : [])];
      const results = await Promise.all(sources.map(async (source) => ({ source, result: await parseReferences(source.text) })));
      const references = results.flatMap(({ result }) => result.references);
      setErrors(results.flatMap(({ source, result }) => result.errors.map((message) => (sources.length > 1 ? `${source.label}: ${message}` : message))));
      const answers: PreviewAnswer[] = [];
      const reserved: string[] = [];
      for (let at = 0; at < references.length; at += PREVIEW_CHUNK) {
        const chunk = references.slice(at, at + PREVIEW_CHUNK);
        const got = await previewReferenceImportAction(
          chunk.map((reference) => ({ sourceKey: reference.sourceKey, keyBase: keyBaseOf(reference.item), identifiers: identifiersOf(reference.data).identifiers })),
          reserved,
        );
        for (const answer of got) if (answer.held.length === 0) reserved.push(answer.key);
        answers.push(...got);
      }
      setRows(references.map((reference, index) => ({ reference, answer: answers[index] })));
      setPhase("preview");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Reading that failed.");
      setPhase("edit");
    }
  }

  async function importAll() {
    setFailure(null);
    setPhase("importing");
    const records = rows.map((row, place) => ({ place, sourceKey: row.reference.sourceKey, short: row.reference.short, csl: row.reference.data }));
    const batches = cutBatches(records);
    const got: ImportOutcome[] = [];
    setProgress({ done: 0, total: records.length });
    try {
      for (const batch of batches) {
        got.push(...(await importReferenceBatchAction(batch)));
        setProgress({ done: got.length, total: records.length });
      }
      setPhase("done");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "The import failed part-way.");
      setPhase("preview");
    } finally {
      setOutcomes(got);
      router.refresh();
    }
  }

  function startOver() {
    setRows([]);
    setErrors([]);
    setOutcomes([]);
    setPhase("edit");
    if (outcomes.length > 0 && outcomes.every((outcome) => outcome.status !== "refused")) {
      setText("");
      setFiles([]);
    }
  }

  const busy = phase === "reading" || phase === "importing";
  const toAdd = rows.filter((row) => row.answer.held.length === 0).length;

  return (
    <details className={styles.importPanel}>
      <summary>Add references</summary>
      {(phase === "edit" || phase === "reading") && (
        <>
          <label>
            Paste BibTeX, biblatex, RIS, CSL-JSON, PubMed’s .nbib or a CITATION.cff, one record or many.
            <textarea
              className={styles.importBox}
              aria-label="References to import"
              value={text}
              onChange={(event) => setText(event.target.value)}
              spellCheck={false}
              disabled={busy}
            />
          </label>
          <label className={styles.importFiles}>
            Or pick files: <input type="file" multiple aria-label="Files to import" onChange={(event) => void pickFiles(event.target.files)} disabled={busy} />
          </label>
          <button type="button" className={account.button} onClick={() => void read()} disabled={busy || (text.trim() === "" && files.length === 0)}>
            {phase === "reading" ? "Reading…" : "Preview"}
          </button>
        </>
      )}
      {failure && <p className={styles.refused}>{failure}</p>}
      {errors.length > 0 && (
        <ul className={styles.importReport} aria-label="What couldn’t be read">
          {errors.map((message, index) => (
            <li key={index} className={styles.refused}>
              {message}
            </li>
          ))}
        </ul>
      )}
      {(phase === "preview" || phase === "importing") && (
        <>
          <p>
            {rows.length === 0
              ? "Nothing to import."
              : `${rows.length} record${rows.length === 1 ? "" : "s"}: ${toAdd} to add, ${rows.length - toAdd} already in the library.`}
          </p>
          <ol className={styles.importPreview} aria-label="Import preview">
            {rows.map((row, index) => (
              <PreviewRow key={index} row={row} />
            ))}
          </ol>
          <button type="button" className={account.button} onClick={() => void importAll()} disabled={busy || toAdd === 0}>
            {phase === "importing" ? `Importing… ${progress.done} of ${progress.total}` : `Import ${toAdd}`}
          </button>{" "}
          <button type="button" className={account.button} onClick={startOver} disabled={busy}>
            Back
          </button>
        </>
      )}
      {phase === "done" && (
        <>
          <ul className={styles.importReport} aria-label="Import results">
            {outcomes.map((outcome) => (
              <li key={outcome.place} className={outcome.status === "refused" ? styles.refused : undefined}>
                {outcome.status === "created" && (
                  <>
                    Added <Link href={referencePath(outcome.key)}>{outcome.key}</Link>: {outcome.title}
                    {outcome.keyNote && ` (${keyNoteText(outcome.keyNote)})`}
                  </>
                )}
                {outcome.status === "duplicate" && (
                  <>
                    Already in the library as <Link href={referencePath(outcome.key)}>{outcome.key}</Link>
                    {outcome.deleted ? " (deleted; restore it from the table)" : ""}: {outcome.title}
                  </>
                )}
                {outcome.status === "refused" && (
                  <>
                    Not added{outcome.title ? `, “${outcome.title}”` : ""}: {outcome.error}
                  </>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className={account.button} onClick={startOver}>
            Import more
          </button>
        </>
      )}
    </details>
  );
}

function PreviewRow({ row }: { row: Row }) {
  const { item, notes } = row.reference;
  const { answer } = row;
  const people = citedNames(item);
  const year = yearOf(item);
  return (
    <li className={answer.held.length > 0 ? styles.previewHeld : undefined}>
      <div>
        <strong>{item.title ? <TitleRuns runs={item.title.runs} /> : titleOf(item)}</strong>
        {people && ` · ${people}`}
        {year !== null && ` · ${year}`} · {item.type}
      </div>
      {answer.held.length === 0 ? (
        <div className={styles.previewKey}>
          Key <code>{answer.key}</code>
          {answer.keyNote && `: ${keyNoteText(answer.keyNote)}`}
        </div>
      ) : (
        <div className={styles.previewKey}>
          {answer.held.length > 1 ? "Matches two references, by its DOI and its ISBN, so neither is replaced: " : "Already in the library as "}
          {answer.held.map((held, index) => (
            <span key={held.id}>
              {index > 0 && " and "}
              <Link href={referencePath(held.key)}>{held.key}</Link>
              {held.deleted ? " (deleted)" : ""}, “{held.title}”
            </span>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <ul className={styles.previewNotes}>
          {notes.map((note, index) => (
            <li key={index}>{noteText(note)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
