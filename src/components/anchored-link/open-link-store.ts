"use client";

import { useMemo, useSyncExternalStore } from "react";
import { loadMyOpenLink, type OpenLinkPart, type OpenLinkView } from "@/app/actions/anchored-links";
import { onAnchoredLinkChanged } from "@/lib/anchored-link-tray-events";
import type { AnchorTarget } from "@/lib/anchors";

// docs/ANCHORED_LINKS.md — **one** browser-side copy of the viewer's open
// link (a draft, or a minted link reopened for editing), shared by
// everything that shows it: the tray's list, each reading surface's
// in-progress highlights, and every Edit affordance deciding whether it may
// proceed (anchored-link-editing.ts).
//
// A store rather than a hook per consumer, because the consumers are in
// different trees and would otherwise each fetch the same row on every
// notify — on the PDF page the surface is inside the ssr:false island and
// the tray is the page's own sibling, so no common React ancestor exists to
// hang a context off. Module scope survives that boundary; it is what
// anchored-link-tray-events.ts already relies on.
//
// The open link is the viewer's own by construction (`loadMyOpenLink` is
// session-scoped), so nothing here is a second permission check waiting to
// drift — there is no other viewer's link to leak.
//
// Three-valued: `undefined` until the first answer arrives, then the view
// or `null`. An Edit button that rendered off `null` before the fetch
// returned would flash enabled and then grey out; off `undefined` it
// renders nothing until it knows.

let openLink: OpenLinkView | null | undefined = undefined;
let inFlight = false;
let queued = false;

const listeners = new Set<() => void>();
let unsubscribeEvents: (() => void) | null = null;

/**
 * Re-reads the open link from the server. Coalesced, but never *dropped*: a
 * notify arriving mid-flight queues one more read rather than reusing the
 * answer in progress, which may have been taken before the mutation that
 * prompted it committed.
 */
export function refreshOpenLink(): void {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  loadMyOpenLink()
    .then((next) => {
      openLink = next;
      for (const listener of listeners) listener();
    })
    // Quiet, the tray's original stance: keep showing what we have; the next
    // notify retries.
    .catch(() => {})
    .finally(() => {
      inFlight = false;
      if (queued) {
        queued = false;
        refreshOpenLink();
      }
    });
}

/**
 * Drops the open link locally — for the outcomes that definitively end one
 * (mint, discard, Done), where a round trip could only confirm what the
 * caller already knows.
 */
export function clearOpenLink(): void {
  openLink = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // First consumer on the page opens the subscription and asks once; later
    // ones read the cache and re-render off the same answer.
    unsubscribeEvents = onAnchoredLinkChanged(refreshOpenLink);
    refreshOpenLink();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
    }
  };
}

const getSnapshot = () => openLink;
// Server render has no session-scoped state to show and must not fetch: the
// answer arrives after hydration, like the tray's own original effect.
const getServerSnapshot = () => undefined;

/** The viewer's open link; `null` when there is none, `undefined` until the first fetch answers. */
export function useOpenLink(): OpenLinkView | null | undefined {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const NO_PARTS: OpenLinkPart[] = [];

/**
 * The open link's parts that point into one object — what a surface paints.
 * The array identity is stable while the link is unchanged, so it can be a
 * dependency without re-running its consumer every render.
 */
export function useOpenLinkParts(targetKind: AnchorTarget["kind"], targetId: string): OpenLinkPart[] {
  const current = useOpenLink();
  return useMemo(() => {
    const parts = (current?.parts ?? []).filter(
      (part) => part.target?.kind === targetKind && part.target.id === targetId,
    );
    // A constant for the common answer, so a surface with no open parts
    // never sees its memo output change identity.
    return parts.length === 0 ? NO_PARTS : parts;
  }, [current, targetKind, targetId]);
}

/**
 * The name a surface shows for link `linkId` (docs/ANCHORED_LINKS.md,
 * "Naming a link"): the store's copy while that link is the open one — a
 * rename in the tray is then visible on the same page with no refresh, the
 * reason draft parts are painted — and the server's otherwise. Server
 * render has no store, so it shows the server's name and nothing flashes.
 */
export function useLinkName(linkId: string, serverName: string | null): string | null {
  const open = useOpenLink();
  return open && open.id === linkId ? open.name : serverName;
}
