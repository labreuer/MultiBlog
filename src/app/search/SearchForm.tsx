"use client";

import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { hasFilters, type SearchKind, type SearchParams } from "@/lib/search/params";
import type { SearchAuthorOption } from "@/lib/search/types";
import { KIND_LABELS } from "./labels";
import styles from "./page.module.css";

// docs/FULLTEXT.md §6 — the search box and its filters, as one GET form.
//
// **It works without JavaScript**: a plain submit sends every field, and the
// parser reads repeated checkbox values and ignores empty ones. What the
// script adds is only a tidier URL, and the reader's time zone:
//
// - Empty fields are dropped and repeated values joined, so the address bar
//   carries only what was chosen.
// - `tz` is filled from the browser's `Intl` at submit time, and only beside
//   a date, which is the one thing it changes the meaning of. Read here
//   rather than on the server for the reason `LocalTime` exists: the
//   server's zone isn't the reader's. Without a script the hidden field
//   sends the zone the page was rendered with — UTC unless the URL said
//   otherwise.
//
// The page remounts this (a `key` on the URL) whenever the search changes,
// since every field is uncontrolled and would otherwise keep showing what a
// link like "All 12 docs" has just changed.

const DATE_FIELDS = ["created_from", "created_to", "updated_from", "updated_to"] as const;

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export default function SearchForm({
  params,
  readableKinds,
  authorOptions,
}: {
  params: SearchParams;
  readableKinds: SearchKind[];
  authorOptions: SearchAuthorOption[];
}) {
  const router = useRouter();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = new URLSearchParams();
    const q = String(data.get("q") ?? "").trim();
    if (q) query.set("q", q);
    for (const name of ["kinds", "authors"]) {
      const values = data.getAll(name).map(String).filter(Boolean);
      if (values.length > 0) query.set(name, values.join(","));
    }
    for (const name of DATE_FIELDS) {
      const value = String(data.get(name) ?? "");
      if (value) query.set(name, value);
    }
    const zone = browserTimeZone();
    if (zone && zone !== "UTC" && DATE_FIELDS.some((name) => query.has(name))) query.set("tz", zone);
    const search = query.toString();
    router.push(search ? `/search?${search}` : "/search");
  };

  const selectedKinds = new Set(params.kinds ?? []);
  const selectedAuthors = new Set(params.authors);

  return (
    <form action="/search" onSubmit={submit} className={styles.form} role="search">
      <div className={styles.queryRow}>
        <input
          type="search"
          name="q"
          defaultValue={params.q}
          aria-label="Search"
          placeholder="Search…"
          autoFocus={!params.q}
          className={styles.queryInput}
        />
        <button type="submit" className={styles.button}>
          Search
        </button>
      </div>

      <details className={styles.filters} open={hasFilters(params)}>
        <summary>Filters</summary>
        <div className={styles.filterGrid}>
          {readableKinds.length > 1 && (
            <fieldset className={styles.fieldset}>
              {/* Nothing checked means every kind, so a reader narrows by
                  checking rather than by unchecking four boxes. */}
              <legend>Only these kinds</legend>
              {readableKinds.map((kind) => (
                <label key={kind} className={styles.check}>
                  <input type="checkbox" name="kinds" value={kind} defaultChecked={selectedKinds.has(kind)} />{" "}
                  {KIND_LABELS[kind].plural}
                </label>
              ))}
            </fieldset>
          )}

          {authorOptions.length > 0 && (
            <fieldset className={styles.fieldset}>
              <legend>By any of</legend>
              {authorOptions.map((author) => (
                <label key={author.slug} className={styles.check}>
                  <input
                    type="checkbox"
                    name="authors"
                    value={author.slug}
                    defaultChecked={selectedAuthors.has(author.slug)}
                  />{" "}
                  {author.name}
                </label>
              ))}
            </fieldset>
          )}

          <fieldset className={styles.fieldset}>
            <legend>Created</legend>
            <label className={styles.date}>
              from <input type="date" name="created_from" defaultValue={params.created.from ?? ""} />
            </label>
            <label className={styles.date}>
              to <input type="date" name="created_to" defaultValue={params.created.to ?? ""} />
            </label>
          </fieldset>

          <fieldset className={styles.fieldset}>
            <legend>Updated</legend>
            <label className={styles.date}>
              from <input type="date" name="updated_from" defaultValue={params.updated.from ?? ""} />
            </label>
            <label className={styles.date}>
              to <input type="date" name="updated_to" defaultValue={params.updated.to ?? ""} />
            </label>
          </fieldset>
        </div>
        <input type="hidden" name="tz" defaultValue={params.tz} />
      </details>
    </form>
  );
}
