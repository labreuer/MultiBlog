"use client";

import { useEffect, useRef } from "react";
import { tabTitle } from "./site-config";

// The one place that writes document.title by hand. Next composes a route's
// tab title once, in generateMetadata; the two doc surfaces then change theirs
// client-side (PLAN.md §12n, "The title follows the fragment live"). Always
// through tabTitle, so the root layout's site-name suffix survives; and
// restored on unmount, because Next rewrites the tab only when its own
// metadata value changes and cannot see this write.
export function useLiveTabTitle(segment: string | null) {
  const originalRef = useRef<string | null>(null);

  // Snapshot once per mount, not per segment change — restoring per change
  // would flash the previous keystroke's value.
  useEffect(() => {
    originalRef.current = document.title;
    return () => {
      if (originalRef.current !== null) document.title = originalRef.current;
    };
  }, []);

  useEffect(() => {
    if (segment === null) return;
    document.title = tabTitle(segment);
  }, [segment]);
}
