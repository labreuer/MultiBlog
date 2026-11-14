"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { markNoteStays, moveNoteForward, openNoteWorklist } from "@/app/actions/note-moves";
import type { NoteRef, NoteSuggestion, OpenedWorklist, WorklistItem } from "@/lib/file-note-move";
import { noPlaceWords, suggestionWords, worklistKindWords } from "@/lib/file-note-words";
import type { PdfTarget } from "@/lib/pdf-anchor";
import type { OtherVersionNote } from "@/lib/pdf-annotation-entries";
import { pageLabelFor } from "@/lib/pdf-page-labels";
import { useArrivedEntry } from "./PdfOtherVersionNotes";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Moving a note forward" — the worklist, "my notes on
// earlier versions", on the latest version's page: the viewer's own part of
// the list of notes on other versions. Each note is still on the version it
// was made on, and its author does one of three things with it here.
//
// **Where each would go is worked out when the viewer asks**, by one click
// for the whole list: the placing rules read sheets, which takes seconds,
// and most visits to this page are not about moving a note. A suggestion
// shows the passage on the note's version beside the one on this version,
// and how it was found. Then:
//
// - **accept** it, which hands the suggestion's target back to be checked
//   and written;
// - **place** the note by selecting its passage in the document, where there
//   is no suggestion or it is wrong (`onPlace`: the surface's selection
//   popover then offers the move);
// - **mark** it as staying on its version, which takes it out of this list
//   and out of every carry's reach.
//
// Each decision is written as it is made. A note that had changed since its
// suggestion was worked out is not moved, and the list is worked out again.
//
// **A marked draft or link part is listed last, under "Marked as staying"**,
// with the control that takes the mark off. A posted note has that on its
// card and on its entry in the rest of the list; a draft and a part have
// neither, so without this a mark on one could not be taken back.
//
// **It is the first part of the list of notes on other versions**
// (`PdfOtherVersionNotes` mounts it inside its own box), under the version
// each note is on, as the rest of that list is. So a posted note's line is
// also where its card's link lands from this address: it carries the card's
// fragment id and its replies', as its entry in that list would.

const keyOf = (ref: NoteRef) => `${ref.kind}:${ref.id}`;

const FAILED = "That didn't work. Reload the page and try again.";

type Props = {
  fileId: string;
  items: WorklistItem[];
  /** The posted notes among them, as the list of notes on other versions holds each: its card's link, its replies and its fragment ids. */
  notes: OtherVersionNote[];
  /** The number of the version shown, which is the latest. */
  latestNumber: number;
  pageLabels: string[] | null;
  /** The note being placed by hand in the document, by its key; null for none. */
  placing: string | null;
  /** Start placing a note by hand, or stop (null). */
  onPlace: (item: WorklistItem | null) => void;
  /** A note was moved or marked: the page loads its notes again. */
  onChanged: (ref: NoteRef) => void;
  /** Show a suggestion's passage in the document. */
  onLook: (target: PdfTarget) => void;
  /** The fragment names a note here: the surface opens the Annotations pane. */
  onArrive?: () => void;
};

export default function PdfNoteWorklist({ fileId, items, notes, latestNumber, pageLabels, placing, onPlace, onChanged, onLook, onArrive }: Props) {
  const [pending, startTransition] = useTransition();
  const [opened, setOpened] = useState<OpenedWorklist | null>(null);
  const [error, setError] = useState<{ key: string | null; message: string } | null>(null);
  const cardOf = new Map(notes.map((note) => [note.threadId, note]));
  const arrived = useArrivedEntry(
    items.flatMap((item) => (item.kind === "annotation" && cardOf.has(item.id) ? [{ key: item.id, anchorNames: cardOf.get(item.id)!.anchorNames }] : [])),
    onArrive,
  );

  if (items.length === 0) return null;
  const undecided = items.filter((item) => !item.stays);
  const staying = items.filter((item) => item.stays);
  const byVersion = [...new Set(undecided.map((item) => item.versionNumber))]
    .sort((a, b) => b - a)
    .map((number) => ({ number, group: undecided.filter((item) => item.versionNumber === number) }));

  const open = (message?: { key: string; message: string }) => {
    setError(message ?? null);
    startTransition(async () => {
      const answer = await openNoteWorklist(fileId).catch(() => ({ ok: false as const, error: FAILED }));
      if (answer.ok) setOpened(answer.value);
      else setError({ key: null, message: answer.error });
    });
  };

  // A suggestion is of the note as it was when the list was opened: one that
  // has moved or been re-targeted since has none until the list is opened again.
  const suggestionFor = (item: WorklistItem): NoteSuggestion | null => {
    const was = opened?.items.find((candidate) => keyOf(candidate) === keyOf(item));
    return was && was.fingerprint === item.fingerprint && was.versionId === item.versionId ? (opened?.suggestions[keyOf(item)] ?? null) : null;
  };

  const accept = (item: WorklistItem, suggestion: NoteSuggestion & { kind: "placed" | "proposal" }) => {
    if (!opened) return;
    setError(null);
    startTransition(async () => {
      const answer = await moveNoteForward({
        kind: item.kind,
        id: item.id,
        fromVersionId: item.versionId,
        fingerprint: item.fingerprint,
        destinationVersionId: opened.destination.id,
        target: suggestion.target,
      }).catch(() => ({ ok: false as const, error: FAILED }));
      if (!answer.ok) {
        setError({ key: keyOf(item), message: answer.error });
        return;
      }
      onChanged(item);
      if (!answer.value.moved) open({ key: keyOf(item), message: "This note had changed since its place was worked out, and was not moved. Here is where it stands now." });
    });
  };

  const stay = (item: WorklistItem, stays: boolean) => {
    setError(null);
    startTransition(async () => {
      const answer = await markNoteStays({ kind: item.kind, id: item.id }, stays).catch(() => ({ ok: false as const, error: FAILED }));
      if (answer.ok) onChanged(item);
      else setError({ key: keyOf(item), message: answer.error });
    });
  };

  return (
    <div data-testid="pdf-worklist">
      {undecided.length > 0 && (
        <>
          <p className={styles.partHeading}>Your notes on earlier versions</p>
          <p className={styles.versionFacts}>
            Each is still on the version it was made on, where it is drawn. Move one to version {latestNumber}, or mark it as staying where it is.
          </p>
          <div className={styles.manageRow}>
            <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-worklist-open" onClick={() => open()}>
              {pending && !opened ? "Working out where each could go…" : opened ? "Work them out again" : "Suggest where each could go"}
            </button>
            {/* The same notes as a table, with the drafts and link parts left out: /annotations lists posted notes. */}
            <Link className={styles.worklistLink} href="/annotations?earlier=mine">
              In the annotations table
            </Link>
          </div>
        </>
      )}
      {error && error.key === null && (
        <p className={styles.manageError} role="alert">
          {error.message}
        </p>
      )}
      {byVersion.map(({ number, group }) => (
        <div key={number}>
          <p className={styles.heading}>On version {number}</p>
          <ul className={styles.list}>
            {group.map((item) => {
              const key = keyOf(item);
              const card = item.kind === "annotation" ? cardOf.get(item.id) : undefined;
              const suggestion = suggestionFor(item);
              return (
                <li
                  key={key}
                  id={card?.anchorNames[0]}
                  className={`${styles.entry} ${styles.worklistItem} ${card && arrived === item.id ? styles.arrived : ""}`}
                  data-testid="pdf-worklist-item"
                  data-note-kind={item.kind}
                  data-note-id={item.id}
                  data-thread-id={item.kind === "annotation" ? item.id : undefined}
                  data-suggestion={suggestion?.kind ?? ""}
                >
                  {card?.anchorNames.slice(1).map((name) => (
                    <span key={name} id={name} />
                  ))}
                  <span className={styles.entryMeta}>
                    {worklistKindWords(item.what, item.kind === "link-part" ? item.text : "")}
                    {item.by && `, written by ${item.by}`}
                    {card && card.replies > 0 && `, ${card.replies} ${card.replies === 1 ? "reply" : "replies"}`}
                  </span>
                  <span className={styles.worklistQuote}>{item.quotedText ? `“${item.quotedText}”` : "(a region with no words)"}</span>
                  {/* A plain <a>: the address carries a fragment (CLAUDE.md, "A client navigation that carries a fragment…"). */}
                  <a href={card?.href ?? item.href} className={styles.entryBody}>
                    {item.kind === "annotation" ? item.text || "(no words yet)" : `Sheet ${item.pageIndex + 1} of version ${item.versionNumber}`}
                  </a>
                  {suggestion && suggestion.kind !== "none" && (
                    <div className={styles.suggestion} data-testid="pdf-worklist-suggestion">
                      <span className={styles.entryMeta}>{suggestionWords(suggestion, latestNumber)}</span>
                      <span className={styles.worklistQuote}>
                        {suggestion.quotedText ? `“${suggestion.quotedText}”` : "(a region with no words)"}{" "}
                        <button type="button" className={styles.linkButton} onClick={() => onLook(suggestion.target)}>
                          p. {pageLabelFor(pageLabels, suggestion.target.pageIndex)}
                        </button>
                      </span>
                    </div>
                  )}
                  {suggestion && suggestion.kind === "none" && (
                    <div className={styles.suggestion} data-testid="pdf-worklist-no-suggestion">
                      <span className={styles.entryMeta}>{noPlaceWords(suggestion.why, latestNumber)}</span>
                    </div>
                  )}
                  {placing === key ? (
                    <div className={styles.manageRow} data-testid="pdf-worklist-placing">
                      <span className={styles.versionFacts}>Select its passage in the document, then choose “Move the note here”.</span>
                      <button type="button" className={styles.manageButton} onClick={() => onPlace(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className={styles.manageRow}>
                      {suggestion && suggestion.kind !== "none" && (
                        <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-worklist-accept" onClick={() => accept(item, suggestion)}>
                          Move it there
                        </button>
                      )}
                      <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-worklist-place" onClick={() => onPlace(item)}>
                        Place it myself
                      </button>
                      <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-worklist-stays" onClick={() => stay(item, true)}>
                        It stays on version {item.versionNumber}
                      </button>
                    </div>
                  )}
                  {error?.key === key && (
                    <p className={styles.manageError} role="alert">
                      {error.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {staying.length > 0 && (
        <div data-testid="pdf-worklist-staying">
          <p className={styles.partHeading}>Marked as staying</p>
          <p className={styles.versionFacts}>Each stays on its version, and no carry moves it, until its mark is taken off.</p>
          <ul className={styles.list}>
            {staying.map((item) => {
              const key = keyOf(item);
              return (
                <li key={key} className={`${styles.entry} ${styles.worklistItem}`} data-testid="pdf-worklist-staying-item" data-note-kind={item.kind} data-note-id={item.id}>
                  <span className={styles.entryMeta}>
                    {worklistKindWords(item.what, item.kind === "link-part" ? item.text : "")}, on version {item.versionNumber}
                  </span>
                  <span className={styles.worklistQuote}>{item.quotedText ? `“${item.quotedText}”` : "(a region with no words)"}</span>
                  {/* A plain <a>: the address carries a fragment (CLAUDE.md, "A client navigation that carries a fragment…"). */}
                  <a href={item.href} className={styles.entryBody}>
                    {item.kind === "annotation" ? item.text || "(no words yet)" : `Sheet ${item.pageIndex + 1} of version ${item.versionNumber}`}
                  </a>
                  <div className={styles.manageRow}>
                    <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-worklist-unstay" onClick={() => stay(item, false)}>
                      Take the mark off
                    </button>
                  </div>
                  {error?.key === key && (
                    <p className={styles.manageError} role="alert">
                      {error.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
