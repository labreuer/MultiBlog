"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChipInputs } from "./types";
import type { ChipSurface } from "./use-chip-inputs";

// Which object the editors below belong to, for their chips' labels
// (use-chip-inputs.ts). A context rather than a prop because the editor sits
// several components below the page that knows the object, and each of those
// would only pass it on.

const ChipSurfaceContext = createContext<ChipSurface | null>(null);

/**
 * Names the doc or annotation whose body the editors inside render, and hands
 * over the inputs the server's first paint used, when it has them.
 */
export function ChipSurfaceProvider({
  doc,
  annotation,
  initial,
  children,
}: {
  doc?: string;
  annotation?: string;
  initial?: ChipInputs;
  children: ReactNode;
}) {
  const surface = useMemo<ChipSurface | null>(
    () => (doc ? { target: { doc }, initial } : annotation ? { target: { annotation }, initial } : null),
    [doc, annotation, initial],
  );
  return <ChipSurfaceContext.Provider value={surface}>{children}</ChipSurfaceContext.Provider>;
}

/** The surface an editor here belongs to, or null on a page that named none. */
export function useChipSurface(): ChipSurface | null {
  return useContext(ChipSurfaceContext);
}
