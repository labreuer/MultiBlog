"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { importReferenceBatchAction, importReportAction, previewReferenceImportAction } from "@/app/actions/references";
import { discardPendingImport, dropAnsweredBatch, keepPendingImport, unfinishedImport, type PendingImport, type PendingRecord } from "@/lib/reference-import-store";
import type { ImportOutcome, KeyNote, PreviewAnswer } from "@/lib/reference-write";
import { cutBatches, IMPORT_RESUMABLE_MS } from "@/lib/references/batches";
import { citedNames, keyBaseOf, titleOf, yearOf } from "@/lib/references/csl";
import { identifiersOf } from "@/lib/references/identifiers";
import { parseReferences, type ImportedReference, type ReadNote } from "@/lib/references/import";
import { referencePath } from "@/lib/references/keys";
import TitleRuns from "@/components/bibliography/TitleRuns";
import { useFileDrop } from "@/components/useFileDrop";
import account from "@/styles/account.module.css";
import styles from "./ReferencesTable.module.css";

// docs/CITATIONS.md, "The import box" — adding works to the library from
// what another tool exports: pasted, or picked or dropped as files, several
// at once, read in the browser into one list. A preview shows each record before
// anything is written: what it is, the key it will get and why that isn't
// its source's, what reading it dropped, cut or mapped, and whether the
// library already holds it, with the choice of replacing that record. Import
// then sends the records in batches, one server action each, with a running
// count. The batches still to send are kept in IndexedDB, so a reload offers
// the import to resume; the report is read from the receipts the server keeps.

/** How many records one preview question asks about. */
const PREVIEW_CHUNK = 500;

type Row = { reference: ImportedReference; answer: PreviewAnswer };

/** A file chosen to import, read as text. `id` is its name, size and modified time: added again, by a pick or a drop, it is skipped. */
type ChosenFile = { id: string; name: string; text: string };

const fileId = (file: File) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
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

export default function ReferenceImport({ userId }: { userId: string }) {
  const router = useRouter();
  const panel = useRef<HTMLDetailsElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [replacing, setReplacing] = useState<Set<number>>(new Set());
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ChosenFile[]>([]);
  const [phase, setPhase] = useState<Phase>("edit");
  const [rows, setRows] = useState<Row[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void unfinishedImport(userId, IMPORT_RESUMABLE_MS).then((found) => live && setPending(found));
    return () => {
      live = false;
    };
  }, [userId]);

  /** Adds `list` to the files chosen, skipping one already there: a pick and a drop each add. */
  async function addFiles(list: readonly File[]) {
    const read = await Promise.all(list.map(async (file): Promise<ChosenFile> => ({ id: fileId(file), name: file.name, text: await file.text() })));
    setFiles((before) => {
      const seen = new Set(before.map((file) => file.id));
      return [...before, ...read.filter((file) => !seen.has(file.id) && seen.add(file.id))];
    });
  }

  const drop = useFileDrop(
    (dropped) => void addFiles(dropped),
    phase === "edit",
    // A file dragged onto the closed panel opens it, so the drop lands where the files are listed.
    () => {
      if (panel.current && !panel.current.open) panel.current.open = true;
    },
  );

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
    const importId = crypto.randomUUID();
    const records: PendingRecord[] = rows.map((row, place) => ({
      place,
      sourceKey: row.reference.sourceKey,
      short: row.reference.short,
      csl: row.reference.data,
      replace: replacing.has(place) && row.answer.held.length === 1 ? row.answer.held[0].id : null,
    }));
    const batches = cutBatches(records);
    await keepPendingImport({ userId, importId, startedAt: Date.now(), total: records.length, batches });
    await send(importId, batches, records.length);
  }

  /** Sends `batches` in order, dropping each from what is kept once answered, then reads the report from the server's receipts. */
  async function send(importId: string, batches: PendingRecord[][], total: number) {
    setFailure(null);
    setPending(null);
    setPhase("importing");
    // A resume starts from the banner, above a panel a reload has closed: the progress and the report are in it.
    if (panel.current) panel.current.open = true;
    let done = total - batches.reduce((sum, batch) => sum + batch.length, 0);
    setProgress({ done, total });
    try {
      for (const batch of batches) {
        const answer = await importReferenceBatchAction(importId, batch);
        if (answer.expired) {
          await discardPendingImport(userId, importId);
          setFailure("That import was started more than six days ago and can no longer be resumed. What it sent is in the library. Importing the file again adds the rest, but also adds a second copy of any work it already sent that has no DOI or ISBN.");
          setPhase(rows.length > 0 ? "preview" : "edit");
          return;
        }
        await dropAnsweredBatch(userId, importId, batch[0].place);
        done += batch.length;
        setProgress({ done, total });
      }
      setOutcomes(await importReportAction(importId));
      setPhase("done");
    } catch (e) {
      setFailure(`${e instanceof Error ? e.message : "The import failed part-way."} What was sent is in; reload to resume the rest.`);
      setPhase(rows.length > 0 ? "preview" : "edit");
    } finally {
      router.refresh();
    }
  }

  async function discard() {
    if (pending) await discardPendingImport(userId, pending.importId);
    setPending(null);
  }

  function startOver() {
    setReplacing(new Set());
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
  const replaceable = rows.flatMap((row, place) => (row.answer.held.length === 1 ? [place] : []));
  const toReplace = replaceable.filter((place) => replacing.has(place)).length;
  const left = pending ? pending.batches.reduce((sum, batch) => sum + batch.length, 0) : 0;
  const toggle = (place: number) =>
    setReplacing((before) => {
      const next = new Set(before);
      if (!next.delete(place)) next.add(place);
      return next;
    });

  return (
    <>
      {pending && phase === "edit" && (
        <p className={styles.importResume} role="status">
          An import you started is unfinished: {left.toLocaleString("en")} of {pending.total.toLocaleString("en")} records left.{" "}
          <button type="button" className={account.button} onClick={() => void send(pending.importId, pending.batches, pending.total)}>
            Resume
          </button>{" "}
          <button type="button" className={account.button} onClick={() => void discard()}>
            Discard
          </button>
        </p>
      )}
      <details ref={panel} className={`${styles.importPanel} ${drop.over ? styles.importDropping : ""}`} {...drop.handlers}>
        <summary>Add references</summary>
        {(phase === "edit" || phase === "reading") && (
          <>
            <label>
              Paste BibTeX, biblatex, RIS, CSL-JSON, PubMed’s .nbib or a CITATION.cff, one record or many, or drop files here.
              <textarea
                className={styles.importBox}
                aria-label="References to import"
                value={text}
                onChange={(event) => setText(event.target.value)}
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <div className={styles.importFiles}>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                aria-label="Files to import"
                onChange={(event) => {
                  void addFiles([...(event.target.files ?? [])]);
                  // Cleared, so the next pick adds to these and the same file picked again is still seen.
                  event.target.value = "";
                }}
              />
              <button type="button" className={account.button} onClick={() => picker.current?.click()} disabled={busy}>
                Add files…
              </button>
              {files.length > 0 && (
                <ul className={styles.importFileList} aria-label="Files chosen">
                  {files.map((file) => (
                    <li key={file.id}>
                      {file.name}{" "}
                      <button
                        type="button"
                        className={styles.editButton}
                        aria-label={`Remove ${file.name}`}
                        title={`Remove ${file.name}`}
                        onClick={() => setFiles((before) => before.filter((other) => other.id !== file.id))}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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
            {replaceable.length > 0 && (
              <label className={styles.importFiles}>
                <input
                  type="checkbox"
                  checked={toReplace === replaceable.length}
                  onChange={(event) => setReplacing(event.target.checked ? new Set(replaceable) : new Set())}
                  disabled={busy}
                />{" "}
                Replace the record of every work already in the library with the one being imported
              </label>
            )}
            <ol className={styles.importPreview} aria-label="Import preview">
              {rows.map((row, index) => (
                <PreviewRow key={index} row={row} replacing={replacing.has(index)} onReplace={() => toggle(index)} disabled={busy} />
              ))}
            </ol>
            <button type="button" className={account.button} onClick={() => void importAll()} disabled={busy || toAdd + toReplace === 0}>
              {phase === "importing"
                ? `Importing… ${progress.done} of ${progress.total}`
                : [toAdd > 0 ? `Import ${toAdd}` : "", toReplace > 0 ? `${toAdd > 0 ? "and r" : "R"}eplace ${toReplace}` : ""].filter(Boolean).join(" ") || "Import"}
            </button>{" "}
            <button type="button" className={account.button} onClick={startOver} disabled={busy}>
              Back
            </button>
          </>
        )}
        {phase === "importing" && rows.length === 0 && (
          <p role="status">
            Importing… {progress.done.toLocaleString("en")} of {progress.total.toLocaleString("en")}
          </p>
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
                  {outcome.status === "replaced" && (
                    <>
                      Replaced the record of <Link href={referencePath(outcome.key)}>{outcome.key}</Link>
                      {outcome.restored ? ", and restored it" : ""}: {outcome.title}
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
    </>
  );
}

function PreviewRow({ row, replacing, onReplace, disabled }: { row: Row; replacing: boolean; onReplace: () => void; disabled: boolean }) {
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
          {answer.held.length === 1 && (
            <label className={styles.previewReplace}>
              <input type="checkbox" checked={replacing} onChange={onReplace} disabled={disabled} /> Replace its record with this one
              {answer.held[0].deleted ? ", and restore it" : ""}; its key, abbreviation, PDF and citations stay
            </label>
          )}
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
