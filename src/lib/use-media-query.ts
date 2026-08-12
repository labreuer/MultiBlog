"use client";

import { useCallback, useSyncExternalStore } from "react";

// `useSyncExternalStore` rather than useState + an effect, for the reason
// LocalTime.tsx exists (CLAUDE.md): the App Router renders client components
// on the server too, and there is no `window.matchMedia` there. The server
// snapshot is a hard `false` — every surface using this must therefore render
// its *narrow* form during SSR and upgrade after hydration, which is why the
// margin-notes rail's column layout is done in CSS (correct from first paint)
// and only the absolute positioning waits on this hook.
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
