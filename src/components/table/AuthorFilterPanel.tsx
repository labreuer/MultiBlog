"use client";

import { useRef } from "react";
import { AUTHOR_MODES, type AuthorMode } from "@/lib/table-query";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import styles from "./AdminTable.module.css";

export type AuthorOption = { slug: string; label: string };

// The Authors filter panel on /docs and /posts — a checkbox list of eligible
// authors plus a combining mode, both mirrored into the querystring
// (src/lib/author-filter.ts owns the `where` semantics; this only renders and
// reports selection). /files renders the same panel over its Owner(s) column,
// which is why the wording is a prop — but only the wording: the callback still
// reports `{ authors, authorMode }`, the shape /docs and /posts already spread
// straight into `updateFilters`, so adding /files changed nothing for them.
// /files' own keys are `owners`/`ownerMode`, and FilesTable does that one-line
// translation at its call site. Deliberately not an extension of MultiSelectDropdown
// (TableControls.tsx): that component's option value *is* its own label, so
// it can't carry a slug with a separate display name, and its `Set<T> |
// "ALL"` selection snaps an empty selection back to "ALL" — wrong here, where
// empty means "no filter" and there is no "All" row at all.
export function AuthorFilterPanel({
  options,
  selected,
  mode,
  onChange,
  label = "Authors",
  noun = "author",
}: {
  /** Every ADMIN/EDITOR/AUTHOR, alphabetical by display label, "(me)" already applied. */
  options: readonly AuthorOption[];
  /** Checked slugs. Empty means no filter, whatever `mode` is. */
  selected: readonly string[];
  mode: AuthorMode;
  /**
   * One callback for both halves — a checkbox and the mode select are each one
   * navigation. Keyed for /docs and /posts, who spread it into `updateFilters`
   * unchanged; a caller filtering on some other relation translates.
   */
  onChange: (next: { authors: string[]; authorMode: AuthorMode }) => void;
  /** Plural heading on the summary — "Owners" on /files. */
  label?: string;
  /** Singular, lowercase, for the accessible names beneath it. */
  noun?: string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(detailsRef);

  // Capitalized for the <select>'s accessible name, which reads as a sentence
  // start; the button's stays lowercase mid-sentence, as it always was.
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const checked = new Set(selected);
  const chosen = options.filter((o) => checked.has(o.slug));

  // Bounded on purpose: this sits between the search box and Columns in a
  // wrapping flex row, and .dropdownPanel is white-space: nowrap — spelling
  // out several names would push Columns onto a second line. The full list is
  // still available in the summary's title, so hovering answers "which ones?".
  const summary =
    chosen.length === 0 ? "All" : chosen.length === 1 ? `${mode} ${chosen[0].label}` : `${mode} ${chosen.length} selected`;

  function commit(slugs: string[], nextMode: AuthorMode) {
    onChange({ authors: slugs, authorMode: nextMode });
  }

  function toggle(slug: string, isChecked: boolean) {
    const next = new Set(checked);
    if (isChecked) next.add(slug);
    else next.delete(slug);
    // Rebuilt from `options` order rather than click order, so the same set
    // of people always serializes to the same querystring however it was
    // ticked.
    commit(
      options.filter((o) => next.has(o.slug)).map((o) => o.slug),
      mode,
    );
  }

  return (
    <details ref={detailsRef} className={styles.dropdownWrapper}>
      <summary className={styles.dropdownSummary} title={chosen.map((o) => o.label).join(", ")}>
        {label}: {summary}
      </summary>
      <div className={styles.dropdownPanel}>
        <div className={styles.columnPickerList}>
          {options.length === 0 && <span className={styles.columnRowFixed}>No {noun}s to filter by.</span>}
          {options.map((option) => (
            <label key={option.slug} className={styles.columnRow}>
              <input
                type="checkbox"
                checked={checked.has(option.slug)}
                onChange={(e) => toggle(option.slug, e.target.checked)}
              />
              {option.label}
            </label>
          ))}
        </div>

        <div className={styles.columnPickerActions}>
          <label>
            Match:{" "}
            <select
              value={mode}
              aria-label={`${Noun} match mode`}
              onChange={(e) => commit([...selected], e.target.value as AuthorMode)}
            >
              {AUTHOR_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            aria-label={`Clear ${noun} filter`}
            disabled={selected.length === 0}
            onClick={() => commit([], mode)}
          >
            Clear
          </button>
        </div>
      </div>
    </details>
  );
}
