"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
// scrolls.

type Props = {
  notes: OtherVersionNote[];
  /** The fragment names an entry here: the surface opens the Annotations pane. */
  onArrive?: () => void;
};

function fragmentName(): string {
  if (typeof window === "undefined") return "";
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return "";
  }
}

export default function PdfOtherVersionNotes({ notes, onArrive }: Props) {
  const [arrived, setArrived] = useState<string | null>(null);
  const byVersion = useMemo(() => {
    const groups = new Map<number, OtherVersionNote[]>();
    for (const note of notes) groups.set(note.versionNumber, [...(groups.get(note.versionNumber) ?? []), note]);
    return [...groups].sort(([a], [b]) => b - a);
  }, [notes]);

  useEffect(() => {
    const land = () => {
      const name = fragmentName();
      const note = name ? notes.find((candidate) => candidate.anchorNames.includes(name)) : undefined;
      setArrived(note ? note.threadId : null);
      if (!note) return;
      onArrive?.();
      // After the pane this opens has rendered.
      requestAnimationFrame(() => document.getElementById(note.anchorNames[0])?.scrollIntoView({ block: "center" }));
    };
    land();
    window.addEventListener("hashchange", land);
    return () => window.removeEventListener("hashchange", land);
  }, [notes, onArrive]);

  if (notes.length === 0) return null;

  return (
    <div className={styles.elsewhere} data-testid="pdf-other-version-notes">
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
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
