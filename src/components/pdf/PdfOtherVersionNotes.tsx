"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { markNoteStays, setNoteMoveShown } from "@/app/actions/note-moves";
import { useAnnotationReload } from "@/components/annotation/annotation-reload-context";
import LocalTime from "@/components/LocalTime";
import type { OtherVersionNote } from "@/lib/pdf-annotation-entries";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses" — what is *listed* on a version's page is the
// file's: its notes on other versions, under the version each is on. They are
// not drawn here (their quads are other sheets'), so each entry links the
// note at its own version.
//
// **An entry carries its card's fragment id and its replies'.** A card's link
// names one address of the file: `/pdf/<slug>#<card>` in `/annotations`, in
// MCP's answers and in every body written while the file had one version,
// `/pdf/<slug>/v/<n>#<card>` in a later one. Either finds its note from any
// address: on its card where the note is on the version shown, and here
// otherwise. The island mounts after the page loads, so the browser's own
// scroll to a fragment has already missed; `onArrive` opens the pane and this
// scrolls (`useArrivedEntry`).
//
// **An entry says where a note went from here** (§13, "Moving a note
// forward"): one whose shown move left the version shown reads "moved to
// version n". A hidden move says nothing, and the note is listed as any note
// on another version is. Its author alone is also given the two things that
// are theirs to change from here: a move of their note shown or hidden, and
// a "stays here" mark taken off.
//
// **On the latest's page the viewer's own part of the list comes first**
// (`mine`): their notes on earlier versions that are still to be decided,
// which are their worklist (`PdfNoteWorklist`), each with what moves it.
// Those are listed there and not again below.

type Props = {
  notes: OtherVersionNote[];
  /** The fragment names an entry here: the surface opens the Annotations pane. */
  onArrive?: () => void;
  /** The viewer's worklist, where they have one: the first part of the list. */
  mine?: ReactNode;
};

function fragmentName(): string {
  if (typeof window === "undefined") return "";
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return "";
  }
}

/**
 * Which of these entries the address's fragment names, by its key, or null:
 * the entry a card's link from another address of the file lands on. It
 * calls `onArrive` and scrolls the entry into view, on arrival and whenever
 * the fragment changes. Each entry's element carries `anchorNames[0]` as its
 * id.
 */
export function useArrivedEntry(entries: readonly { key: string; anchorNames: readonly string[] }[], onArrive?: () => void): string | null {
  const [arrived, setArrived] = useState<string | null>(null);
  // By value: a caller builds its list on every render, and landing again on each would scroll the pane under the reader.
  const named = JSON.stringify(entries.map((entry) => [entry.key, ...entry.anchorNames]));
  useEffect(() => {
    const list = JSON.parse(named) as string[][];
    const land = () => {
      const name = fragmentName();
      const entry = name ? list.find(([, ...names]) => names.includes(name)) : undefined;
      setArrived(entry ? entry[0] : null);
      if (!entry) return;
      onArrive?.();
      // After the pane this opens has rendered.
      requestAnimationFrame(() => document.getElementById(entry[1])?.scrollIntoView({ block: "center" }));
    };
    land();
    window.addEventListener("hashchange", land);
    return () => window.removeEventListener("hashchange", land);
  }, [named, onArrive]);
  return arrived;
}

export default function PdfOtherVersionNotes({ notes, onArrive, mine }: Props) {
  const byVersion = useMemo(() => {
    const groups = new Map<number, OtherVersionNote[]>();
    for (const note of notes) groups.set(note.versionNumber, [...(groups.get(note.versionNumber) ?? []), note]);
    return [...groups].sort(([a], [b]) => b - a);
  }, [notes]);
  const arrived = useArrivedEntry(
    useMemo(() => notes.map((note) => ({ key: note.threadId, anchorNames: note.anchorNames })), [notes]),
    onArrive,
  );

  if (notes.length === 0 && !mine) return null;

  return (
    <div className={styles.elsewhere} data-testid="pdf-other-version-notes">
      {mine}
      {mine && notes.length > 0 && <p className={styles.partHeading}>Other notes on other versions</p>}
      {byVersion.map(([number, group]) => (
        <div key={number}>
          <p className={styles.heading}>On version {number}</p>
          <ul className={styles.list}>
            {group.map((note) => (
              <li
                key={note.threadId}
                id={note.anchorNames[0]}
                className={`${styles.entry} ${arrived === note.threadId ? styles.arrived : ""}`}
                data-thread-id={note.threadId}
              >
                {/* Each reply's fragment id, so a reply's link lands on its thread's entry too. */}
                {note.anchorNames.slice(1).map((name) => (
                  <span key={name} id={name} />
                ))}
                {note.quotedText && <span className={styles.entryQuote}>“{note.quotedText}”</span>}
                <Link href={note.href} className={styles.entryBody}>
                  {note.bodyText.trim() || "(deleted)"}
                </Link>
                <span className={styles.entryMeta}>
                  {note.displayName}, <LocalTime value={note.createdAt} precision="date" />
                  {note.replies > 0 && `, ${note.replies} ${note.replies === 1 ? "reply" : "replies"}`}
                </span>
                <EntryStanding note={note} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** What an entry says of its note's move from the version shown, and what its author may change from here. */
function EntryStanding({ note }: { note: OtherVersionNote }) {
  const reload = useAnnotationReload();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const moved = note.left && !note.left.hidden ? note.left : null;
  if (!moved && !(note.mine && (note.left || note.stays))) return null;

  const act = (run: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const answer = await run().catch(() => ({ ok: false as const, error: "That didn't work. Reload the page and try again." }));
      if (answer.ok) reload();
      else setError(answer.error);
    });
  };

  return (
    <span className={styles.entryStanding}>
      {moved && (
        <span data-testid="pdf-note-moved-to">
          Moved to version {moved.toNumber}
          {moved.by && ` by ${moved.by}`}.
        </span>
      )}
      {note.mine && note.left && (
        <button
          type="button"
          className={styles.linkButton}
          disabled={pending}
          data-testid={note.left.hidden ? "pdf-note-move-show" : "pdf-note-move-hide"}
          onClick={() => act(() => setNoteMoveShown(note.left!.id, note.left!.hidden))}
        >
          {note.left.hidden ? `Say that it was moved to version ${note.left.toNumber}` : "Don't say so"}
        </button>
      )}
      {note.mine && note.stays && (
        <>
          <span data-testid="pdf-note-stays">You marked it as staying on version {note.versionNumber}.</span>
          <button
            type="button"
            className={styles.linkButton}
            disabled={pending}
            data-testid="pdf-note-unstay"
            onClick={() => act(() => markNoteStays({ kind: "annotation", id: note.threadId }, false))}
          >
            Take the mark off
          </button>
        </>
      )}
      {error && (
        <span className={styles.manageError} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
