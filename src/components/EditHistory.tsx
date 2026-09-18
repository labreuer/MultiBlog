"use client";

import { useEffect, useState, type ReactNode } from "react";
import LocalTime, { useLocalTime } from "./LocalTime";
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
  /**
   * Where the marker sits, which is what decides whether it says the edit
   * time out loud.
   *
   * `"own-line"` is the marker on a line of its own below the body, where
   * there is room for "edited <when>". `"meta"` is the marker parenthesized
   * at the end of the entry's meta line, directly after the *posting* time
   * (`CommentNode`) — two timestamps side by side there would read as one
   * confusing pair, so the edit time moves into the tooltip. The parentheses
   * belong to this component rather than the call site so the panel opens
   * *after* the closing one: a block between them would push the ")" onto a
   * line of its own.
   */
  placement?: "own-line" | "meta";
  /**
   * Told when the panel is actually *listing* versions, so a caller whose
   * marker sits above the body can hide that body while the list stands in
   * for it (`CommentNode`) — the current version is the first entry, so
   * leaving both up shows the same text twice.
   *
   * Deliberately narrower than "the panel is open": while the fetch is in
   * flight, or if it fails, or if every version is withheld, the panel has
   * nothing to stand in *with*, and hiding the body would leave the reader
   * with a spinner or an error where the comment was.
   */
  onVersionsShown?: (shown: boolean) => void;
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
export default function EditHistory<V extends EditHistoryMeta>({
  editedAt,
  load,
  renderBody,
  what,
  placement = "own-line",
  onVersionsShown,
}: Props<V>) {
  // Hydration-safe by construction, same as the element form: UTC text on the
  // server and the first client render, localized after. A `title` React
  // rendered differently on the two sides would be a prop mismatch.
  const editedAtText = useLocalTime(editedAt);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<V[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showingVersions = open && versions !== null && versions.length > 0;
  useEffect(() => {
    onVersionsShown?.(showingVersions);
  }, [showingVersions, onVersionsShown]);

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
      {placement === "meta" && <span className={styles.paren}>(</span>}
      <button
        type="button"
        onClick={toggle}
        className={styles.marker}
        aria-expanded={open}
        aria-label={open ? `Hide earlier versions of this ${what}` : `Show earlier versions of this ${what}`}
        title={editedAtText ? `Last edited ${editedAtText}` : undefined}
      >
        edited{placement === "own-line" && editedAt ? " " : ""}
        {placement === "own-line" && editedAt && <LocalTime value={editedAt} />}
      </button>
      {placement === "meta" && <span className={styles.paren}>)</span>}
      {open && (
        <div className={styles.panel} data-edit-history={what}>
          {pending && <p className={styles.status}>Loading earlier versions…</p>}
          {error && <p className={styles.error}>{error}</p>}
          {versions?.map((version) => (
            <div
              key={version.revisionNo}
              className={`${styles.version} ${version.current ? styles.currentVersion : ""}`}
              // A hook for the suite: which block is which is otherwise only
              // a hashed CSS-module class and a word of prose.
              data-edit-version={version.current ? "current" : "earlier"}
            >
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
