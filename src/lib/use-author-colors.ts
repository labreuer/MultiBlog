"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type AuthorColorInfo = { name: string; color: string };
export type AuthorColorMap = Record<string, AuthorColorInfo>;

// Fetches + caches {name, color} for a set of author ids (from
// authorHighlight marks), so the same lookups aren't repeated as the doc
// changes. `known` seeds ids that never need fetching (e.g. the current
// user, whose color is already in hand) without triggering a request.
export function useAuthorColors(authorIds: string[], known?: AuthorColorMap): AuthorColorMap {
  const [fetched, setFetched] = useState<AuthorColorMap>({});
  const cacheRef = useRef<AuthorColorMap>({});

  useEffect(() => {
    const missing = authorIds.filter((id) => !cacheRef.current[id] && !known?.[id]);
    if (missing.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/users/colors?ids=${encodeURIComponent(missing.join(","))}`);
        if (!res.ok || cancelled) return;
        const result: AuthorColorMap = await res.json();
        cacheRef.current = { ...cacheRef.current, ...result };
        setFetched((prev) => ({ ...prev, ...result }));
      } catch {
        // Best-effort — unmarked/uncolored highlights just render without a color.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorIds.join(","), known]);

  return useMemo(() => ({ ...fetched, ...known }), [fetched, known]);
}
