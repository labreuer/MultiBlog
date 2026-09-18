"use client";

import { useState, type ReactNode } from "react";
import LocalTime from "./LocalTime";
import styles from "./EditHistory.module.css";

/**
 * What every version has in common, whatever it is a version *of*.
 *
 * A comment's body is a string and an annotation's is TipTap JSON, so the
 * body is deliberately absent here — `renderBody` below is what each side
 * supplies, and it is the only difference between them.
 */
export type EditHistoryMeta = {
  revisionNo: number;
  createdAt: string;
  /** Null for an anonymous original — the one version with nobody to name. */
  authorName: string | null;
  /** The text currently on screen. Exactly one version has this. */
  current: boolean;
};

type Props<V extends EditHistoryMeta> = {
  /**
   * When the newest version was written. Shown in the marker, so the reader
   * knows there is something to open before they open it.
   */
  editedAt: string | null;
  /**
   * Fetched on open, never rendered into the page.
   *
   * Two reasons, and the second is the load-bearing one. The post page is
   * statically generated (PLAN.md §21), so a dynamic read in its tree throws
   * at build (§12f) — the same constraint that makes `TagChips` a client
   * island. And a superseded version is withheld under its own gate
   * (§22c/§22e), which a payload baked into the page could not apply.
   */
  load: () => Promise<V[]>;
  renderBody: (version: V) => ReactNode;
  /** Names what is being versioned, for the marker's accessible label. */
  what: "comment" | "annotation";
};

// PLAN.md §22c — the "edited" marker, and the history behind it. One island
// for both comments and annotations: what differs between them is the body's
// type, which `renderBody` carries, and nothing about when an edit is visible
// or how versions are listed.
//
// **Mounting this at all is already a decision.** The marker renders only
// where §22b's silence rule says the edit is visible, which is decided on the
// server — so a silent edit reaches neither this component nor the payload it
// would have been rendered from.
export default function EditHistory<V extends EditHistoryMeta>({ editedAt, load, renderBody, what }: Props<V>) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<V[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    // Loaded once per mount. A version list is immutable once written — the
    // only thing that can change it is a further edit, which re-renders this
    // whole subtree with a new `editedAt` anyway.
    if (versions !== null || pending) return;
    setPending(true);
    setError(null);
    try {
      setVersions(await load());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load earlier versions.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        onClick={toggle}
        className={styles.marker}
        aria-expanded={open}
        aria-label={open ? `Hide earlier versions of this ${what}` : `Show earlier versions of this ${what}`}
      >
        edited{editedAt ? " " : ""}
        {editedAt && <LocalTime value={editedAt} />}
      </button>
      {open && (
        <div className={styles.panel} data-edit-history={what}>
          {pending && <p className={styles.status}>Loading earlier versions…</p>}
          {error && <p className={styles.error}>{error}</p>}
          {versions?.map((version) => (
            <div key={version.revisionNo} className={styles.version}>
              <p className={styles.versionMeta}>
                {version.current ? "Current" : "Earlier"} version
                {version.authorName ? ` by ${version.authorName}` : ""} · <LocalTime value={version.createdAt} />
              </p>
              <div className={styles.versionBody}>{renderBody(version)}</div>
            </div>
          ))}
          {versions !== null && versions.length === 0 && !error && (
            <p className={styles.status}>No earlier versions are available to you.</p>
          )}
        </div>
      )}
    </span>
  );
}
