"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { entityChipKey, setChipInputs } from "./node";
import { chipsIn, chipTargets } from "./renderings";
import { NO_CHIP_INPUTS, type ChipContext, type ChipInputs } from "./types";

// docs/ENTITY_CHIPS.md, step 1, item 5 — how a live editor gets what its
// chips' labels are computed from. The page's first paint hands over the
// context it rendered with; this keeps it current: it asks the server about
// any target the context doesn't hold yet (a chip a collaborator just
// inserted) and gives the editor the answer.

/** The object an editor's chips belong to, and what the server already rendered them with. */
export type ChipSurface = {
  target: { doc: string } | { annotation: string };
  /** The inputs the page's first paint used. Omitted, the hook fetches them on mount. */
  initial?: ChipInputs;
};

const ASK_DEBOUNCE_MS = 150;

type Fetched = { styles: ChipInputs["styles"] | null; context: ChipContext; pending: Record<string, string[]> | null };
const NOTHING_FETCHED: Fetched = { styles: null, context: {}, pending: null };

function mergeContext(base: ChipContext, more: ChipContext): ChipContext {
  const merged: ChipContext = { ...base };
  for (const [kind, records] of Object.entries(more)) {
    merged[kind] = { ...((base[kind] as Record<string, unknown> | undefined) ?? {}), ...(records as Record<string, unknown>) };
  }
  return merged;
}

/**
 * Keeps `editor`'s chips labelled. A no-op without a surface, which is every
 * editor on a page that has not been given one.
 */
export function useChipInputs(editor: Editor | null, surface: ChipSurface | null | undefined): void {
  const targetKey = surface ? ("doc" in surface.target ? `doc=${surface.target.doc}` : `annotation=${surface.target.annotation}`) : null;
  const initial = surface?.initial;

  // What this hook has fetched, kept apart from `initial` so that a refreshed
  // page's newer context joins it by derivation rather than by an effect.
  const [fetched, setFetched] = useState<Fetched>(NOTHING_FETCHED);
  const inputs = useMemo<ChipInputs>(
    () => ({
      styles: fetched.styles ?? initial?.styles ?? NO_CHIP_INPUTS.styles,
      context: mergeContext(initial?.context ?? {}, fetched.context),
      ...(fetched.pending ? { pending: fetched.pending } : {}),
    }),
    [initial, fetched],
  );
  // Every target id the server has been asked about, answered or not, per
  // chip kind: an id it didn't return doesn't exist for this viewer, and
  // asking again would only repeat that.
  const askedRef = useRef(new Map<string, Set<string>>());
  const inputsRef = useRef(inputs);
  useEffect(() => {
    inputsRef.current = inputs;
  }, [inputs]);

  // Before paint, so an editor that is about to be shown is shown labelled.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (entityChipKey.getState(editor.state)?.inputs !== inputs) setChipInputs(editor.view, inputs);
  }, [editor, inputs]);

  useEffect(() => {
    if (!editor || !targetKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen: unknown = null;

    const ask = async (missing: Record<string, string[]>) => {
      const query = Object.entries(missing)
        .map(([kind, ids]) => `&${encodeURIComponent(kind)}=${ids.map(encodeURIComponent).join(",")}`)
        .join("");
      let answer: ChipInputs | null = null;
      try {
        const res = await fetch(`/api/chip-context?${targetKey}${query}`);
        if (res.ok) answer = (await res.json()) as ChipInputs;
      } catch {
        // Best-effort: the chips stay as they are, and the next change asks again for anything new.
      }
      if (cancelled) return;
      setFetched((previous) => {
        // Whatever was asked is no longer pending, answered or not.
        const pending: Record<string, string[]> = {};
        for (const [kind, ids] of Object.entries(previous.pending ?? {})) {
          const left = ids.filter((id) => !missing[kind]?.includes(id));
          if (left.length > 0) pending[kind] = left;
        }
        return {
          styles: answer?.styles ?? previous.styles,
          context: answer ? mergeContext(previous.context, answer.context) : previous.context,
          pending: Object.keys(pending).length > 0 ? pending : null,
        };
      });
    };

    const check = () => {
      timer = null;
      if (cancelled || editor.isDestroyed) return;
      const current = inputsRef.current;
      const missing: Record<string, string[]> = {};
      for (const [kind, ids] of Object.entries(chipTargets(chipsIn(editor.state.doc)))) {
        const known = (current.context[kind] as Record<string, unknown> | undefined) ?? {};
        let asked = askedRef.current.get(kind);
        if (!asked) askedRef.current.set(kind, (asked = new Set()));
        const fresh = ids.filter((id) => !Object.hasOwn(known, id) && !asked.has(id));
        if (fresh.length === 0) continue;
        fresh.forEach((id) => asked.add(id));
        missing[kind] = fresh;
      }
      if (Object.keys(missing).length === 0) return;
      setFetched((previous) => {
        const pending: Record<string, string[]> = {};
        for (const kind of new Set([...Object.keys(previous.pending ?? {}), ...Object.keys(missing)])) {
          pending[kind] = [...(previous.pending?.[kind] ?? []), ...(missing[kind] ?? [])];
        }
        return { ...previous, pending };
      });
      void ask(missing);
    };

    // Only a change in which chips the document holds can bring a new target,
    // and the plugin's map of renderings is rebuilt exactly then.
    const onTransaction = () => {
      const seen = entityChipKey.getState(editor.state)?.byIid;
      if (seen === lastSeen) return;
      lastSeen = seen;
      if (timer === null) timer = setTimeout(check, ASK_DEBOUNCE_MS);
    };

    editor.on("transaction", onTransaction);
    onTransaction();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      editor.off("transaction", onTransaction);
    };
  }, [editor, targetKey]);
}
