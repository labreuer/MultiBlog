"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { nextSortColumns } from "@/lib/table-sort";
import type { BaseFilters } from "@/lib/table-query";

const SEARCH_DEBOUNCE_MS = 400;

// The navigate / updateFilters / debounced-search trio every URL-driven admin
// table needs (PLAN.md §16d), lifted out of CommentsTable and AnnotationsTable
// before /posts, /docs and /users made a third, fourth and fifth copy of it.
//
// `build` is the table's own buildXQueryString: this hook knows the five
// shared params exist but never serializes them itself, so a table's
// multi-selects and deep links keep round-tripping through its own module.
export function useTableFilters<K extends string, F extends BaseFilters<K>>({
  filters,
  build,
}: {
  filters: F;
  build: (filters: F, extra: URLSearchParams) => string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [searchDraft, setSearchDraft] = useState(filters.q);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keeps the search box in sync when `filters.q` changes for a reason other
  // than this hook's own debounced navigation (browser back/forward, or a
  // deep link with ?q= already set) — a no-op the rest of the time, since by
  // then searchDraft already equals filters.q.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing from the URL (an external system), see above
    setSearchDraft(filters.q);
  }, [filters.q]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  function navigate(partial: Partial<F>) {
    const nextFilters: F = { ...filters, ...partial };
    const qs = build(nextFilters, searchParams);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Any filter/sort/page-size change resets to page 1; only Prev/Next (which
  // call `navigate` directly) are meant to change just the page.
  function updateFilters(partial: Partial<F>) {
    navigate({ page: 1, ...partial });
  }

  function onSearchChange(value: string) {
    setSearchDraft(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => updateFilters({ q: value } as Partial<F>), SEARCH_DEBOUNCE_MS);
  }

  function handleSort(key: K, addToSort: boolean) {
    updateFilters({ sort: nextSortColumns(filters.sort, key, addToSort) } as Partial<F>);
  }

  return { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams };
}
