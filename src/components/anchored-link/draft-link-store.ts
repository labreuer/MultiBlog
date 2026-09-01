"use client";

import { useMemo, useSyncExternalStore } from "react";
import { loadMyDraftLink, type DraftLinkPart, type DraftLinkView } from "@/app/actions/anchored-links";
import { onAnchoredLinkChanged } from "@/lib/anchored-link-tray-events";
import type { AnchorTarget } from "@/lib/anchors";

// docs/ANCHORED_LINKS.md — **one** browser-side copy of the viewer's draft
// link, shared by everything that shows it: the tray's text list and each
// reading surface's in-progress highlights.
//
// A store rather than a hook per consumer, because the consumers are in
// different trees and would otherwise each fetch the same row on every
// notify — on the PDF page the surface is inside the ssr:false island and
// the tray is the page's own sibling, so no common React ancestor exists to
// hang a context off. Module scope survives that boundary; it is what
// anchored-link-tray-events.ts already relies on.
//
// The draft is the viewer's own by construction (`loadMyDraftLink` is
// session-scoped), so nothing here is a second permission check waiting to
// drift — there is no other viewer's draft to leak.

let draft: DraftLinkView | null = null;
let inFlight = false;
let queued = false;

const listeners = new Set<() => void>();
let unsubscribeEvents: (() => void) | null = null;

/**
 * Re-reads the draft from the server. Coalesced, but never *dropped*: a
 * notify arriving mid-flight queues one more read rather than reusing the
 * answer in progress, which may have been taken before the mutation that
 * prompted it committed.
 */
export function refreshDraftLink(): void {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  loadMyDraftLink()
    .then((next) => {
      draft = next;
      for (const listener of listeners) listener();
    })
    // Quiet, the tray's original stance: keep showing what we have; the next
    // notify retries.
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      if (queued) {
        queued = false;
        refreshDraftLink();
      }
    });
}

/**
 * Drops the draft locally — for the two outcomes that definitively end one
 * (mint, discard), where a round trip could only confirm what the caller
 * already knows.
 */
export function clearDraftLink(): void {
  draft = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // First consumer on the page opens the subscription and asks once; later
    // ones read the cache and re-render off the same answer.
    unsubscribeEvents = onAnchoredLinkChanged(refreshDraftLink);
    refreshDraftLink();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
    }
  };
}

const getSnapshot = () => draft;
// Server render has no session-scoped state to show and must not fetch: the
// draft arrives after hydration, like the tray's own original effect.
const getServerSnapshot = () => null;

/** The viewer's draft link, or null when there is none. */
export function useDraftLink(): DraftLinkView | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const NO_PARTS: DraftLinkPart[] = [];

/**
 * The draft's parts that point into one object — what a surface paints. The
 * array identity is stable while the draft is unchanged, so it can be a
 * dependency without re-running its consumer every render.
 */
export function useDraftLinkParts(targetKind: AnchorTarget["kind"], targetId: string): DraftLinkPart[] {
  const current = useDraftLink();
  return useMemo(() => {
    const parts = (current?.parts ?? []).filter(
      (part) => part.target?.kind === targetKind && part.target.id === targetId,
    );
    // A constant for the common answer, so a surface with no draft parts
    // never sees its memo output change identity.
    return parts.length === 0 ? NO_PARTS : parts;
  }, [current, targetKind, targetId]);
}
