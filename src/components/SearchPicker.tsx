"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./SearchPicker.module.css";

// A search box whose results are buttons: pick one, and the box empties. The
// two places a reference is tied to its PDF use it (docs/CITATIONS.md, "A
// work's PDF"), one searching references and the other PDFs. The search
// runs as the citation popover's "Add a work" does, debounced, and a
// result counts only for the query it answered.

const SEARCH_DEBOUNCE_MS = 200;

export type PickerOption = { id: string; label: string; note?: string };

export default function SearchPicker({
  label,
  placeholder,
  search,
  onPick,
  disabled,
}: {
  label: string;
  placeholder?: string;
  search: (query: string) => Promise<PickerOption[]>;
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; options: PickerOption[] }>({ query: "", options: [] });
  const id = useId();
  // The latest `search`, so a caller's inline function doesn't rerun the search on every render.
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });
  useEffect(() => {
    const words = query.trim();
    if (!words) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchRef
        .current(words)
        .catch(() => [])
        .then((options) => {
          if (!cancelled) setResults({ query, options });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);
  const answered = query.trim() !== "" && results.query === query;
  return (
    <div className={styles.picker}>
      <label className={styles.field} htmlFor={id}>
        <span className={styles.label}>{label}</span>
        <input id={id} className={styles.input} value={query} placeholder={placeholder} disabled={disabled} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {answered && results.options.length > 0 && (
        <ul className={styles.results} aria-label={`${label}: results`}>
          {results.options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                className={styles.result}
                disabled={disabled}
                onClick={() => {
                  onPick(option.id);
                  setQuery("");
                }}
              >
                {option.label}
                {option.note && <span className={styles.note}> {option.note}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {answered && results.options.length === 0 && <p className={styles.none}>Nothing found.</p>}
    </div>
  );
}
