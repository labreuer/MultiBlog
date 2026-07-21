"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Persists "show deleted rows" for the current browser session
// (sessionStorage, not localStorage — cleared when the tab closes, but
// survives navigating away from and back to the admin table) so each admin
// table (posts, users) remembers its own setting independently via a
// distinct storageKey.
//
// Must default to false unconditionally, not read sessionStorage in the
// useState initializer — that was the original approach here and it caused
// a real hydration mismatch, not just a lint nitpick. sessionStorage is
// browser-only: SSR always computes `false` (no window), but the client's
// hydration render can see an already-persisted `true` and render a
// different set of rows for the very first paint than the server-rendered
// HTML did. Reading it in an effect after mount — the "subscribe to an
// external system" case react-hooks/set-state-in-effect's own message
// calls out as legitimate — corrects the value one render later instead,
// once hydration has already committed against the matching `false` state,
// so the two can never disagree.
export function useShowDeletedRows(storageKey: string) {
  const router = useRouter();
  const [showDeleted, setShowDeleted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing initial value from sessionStorage (an external system); see comment above
    setShowDeleted(sessionStorage.getItem(storageKey) === "true");
  }, [storageKey]);

  function toggle(next: boolean) {
    setShowDeleted(next);
    sessionStorage.setItem(storageKey, String(next));
    router.refresh();
  }

  return { showDeleted, toggle };
}
