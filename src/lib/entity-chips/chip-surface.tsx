"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ChipContext, ChipInputs } from "./types";
import type { ChipSurface } from "./use-chip-inputs";

// Which object the editors below belong to, for their chips' labels
// (use-chip-inputs.ts). A context rather than a prop because the editor sits
// several components below the page that knows the object, and each of those
// would only pass it on.

type Seed = (kind: string, id: string, record: unknown) => void;

const ChipSurfaceContext = createContext<ChipSurface | null>(null);
const ChipSeedContext = createContext<Seed>(() => {});

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
  // Records a menu already holds for a chip it is inserting, so the chip is
  // labelled as it lands instead of after a round trip.
  const [seeded, setSeeded] = useState<ChipContext>({});
  const seed = useCallback<Seed>((kind, id, record) => {
    setSeeded((previous) => ({
      ...previous,
      [kind]: { ...((previous[kind] as Record<string, unknown> | undefined) ?? {}), [id]: record },
    }));
  }, []);

  const surface = useMemo<ChipSurface | null>(
    () =>
      doc ? { target: { doc }, initial, seeded } : annotation ? { target: { annotation }, initial, seeded } : null,
    [doc, annotation, initial, seeded],
  );
  return (
    <ChipSeedContext.Provider value={seed}>
      <ChipSurfaceContext.Provider value={surface}>{children}</ChipSurfaceContext.Provider>
    </ChipSeedContext.Provider>
  );
}

/** The surface an editor here belongs to, or null on a page that named none. */
export function useChipSurface(): ChipSurface | null {
  return useContext(ChipSurfaceContext);
}

/** Adds one record to the surface's chip context: `seed(chip kind, target id, record)`. A no-op with no surface. */
export function useSeedChipContext(): Seed {
  return useContext(ChipSeedContext);
}
