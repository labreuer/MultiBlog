"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useSession } from "next-auth/react";
import { getCollabUrl } from "@/lib/collab-url";
import {
  PRESENCE_THROTTLE_MS,
  isStale,
  parsePresence,
  viewportChangedEnough,
  type PdfPresence,
  type ViewportState,
} from "@/lib/pdf-presence";
import type { Quad } from "@/lib/pdf-anchor";
import type { PdfViewerHandle } from "./PdfViewer";

// PLAN.md §19 Phase 4 — the presence connection for one PDF, and the follow
// mechanics on top of it.
//
// The document it connects to is empty and stays that way (see ydocIdForFile):
// this is an awareness channel wearing a ydoc's clothes, because Hocuspocus
// awareness rides a document connection. No IndexedDB is attached — there is no
// content to persist — and the token is unconditionally read-only.

export type RemoteReader = {
  clientId: number;
  presence: PdfPresence;
};

export type PdfPresenceState = {
  /** Everyone else currently connected, with a viewport or a selection to show. */
  readers: RemoteReader[];
  /** True while this reader is broadcasting an invitation. */
  leading: boolean;
  setLeading: (leading: boolean) => void;
  /** The clientId being followed, or null. */
  following: number | null;
  follow: (clientId: number | null) => void;
  /** Publish this reader's live text selection (or clear it). */
  publishSelection: (selection: { pageIndex: number; quads: Quad[] } | null) => void;
};

export function usePdfPresence(fileId: string, handle: PdfViewerHandle | null): PdfPresenceState {
  const { data: session } = useSession();
  const [readers, setReaders] = useState<RemoteReader[]>([]);
  const [leading, setLeadingState] = useState(false);
  const [following, setFollowing] = useState<number | null>(null);

  const providerRef = useRef<HocuspocusProvider | null>(null);
  const localRef = useRef<PdfPresence | null>(null);

  // docs/PDF.md §9's first echo guard. Set before scrollPageIntoView and
  // cleared on the rAF *after* the resulting updateviewarea — not immediately,
  // because the scroll and its event are a frame apart, and clearing in between
  // would let the applied position broadcast straight back out.
  const applyingRemoteRef = useRef(false);
  // Third guard: the newest `t` applied from each sender, so a state that
  // arrives out of order is dropped rather than rewinding the reader.
  const lastAppliedRef = useRef(new Map<number, number>());
  const lastSentRef = useRef<ViewportState | null>(null);

  // ---- connect ------------------------------------------------------------
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    let provider: HocuspocusProvider | null = null;

    (async () => {
      const response = await fetch(`/api/file/${fileId}/token`, { method: "POST" });
      if (!response.ok || cancelled) return;
      const { token, documentName } = (await response.json()) as { token: string; documentName: string };
      if (cancelled) return;

      provider = new HocuspocusProvider({ url: getCollabUrl(), name: documentName, token });
      providerRef.current = provider;

      const initial: PdfPresence = {
        user: {
          id: session.user.id,
          name: session.user.name ?? session.user.email ?? "Someone",
          color: session.user.color,
        },
        viewport: null,
        selection: null,
        leading: false,
        following: null,
      };
      localRef.current = initial;
      provider.setAwarenessField("pdf", initial);

      const readAwareness = () => {
        const states = provider!.awareness?.getStates();
        if (!states) return;
        const next: RemoteReader[] = [];
        for (const [clientId, state] of states) {
          if (clientId === provider!.awareness?.clientID) continue;
          const presence = parsePresence((state as Record<string, unknown>).pdf);
          if (presence) next.push({ clientId, presence });
        }
        // Sorted by user id so the rail's circles keep a stable order rather
        // than reshuffling every time somebody scrolls.
        next.sort((a, b) => a.presence.user.id.localeCompare(b.presence.user.id));
        setReaders(next);
      };

      provider.on("awarenessUpdate", readAwareness);
      provider.on("awarenessChange", readAwareness);
      readAwareness();
    })().catch((err) => {
      console.error("[pdf-presence] couldn't connect:", err);
    });

    return () => {
      cancelled = true;
      providerRef.current = null;
      localRef.current = null;
      provider?.destroy();
    };
  }, [fileId, session?.user]);

  const publish = useCallback((patch: Partial<PdfPresence>) => {
    const provider = providerRef.current;
    const local = localRef.current;
    if (!provider || !local) return;
    const next = { ...local, ...patch };
    localRef.current = next;
    provider.setAwarenessField("pdf", next);
  }, []);

  // ---- broadcast our own viewport ----------------------------------------
  useEffect(() => {
    if (!handle) return;

    let timer: number | null = null;
    let counter = 0;

    const currentViewport = (): ViewportState | null => {
      const pageIndex = handle.viewer.currentPageNumber - 1;
      const pageView = handle.viewer.getPageView(pageIndex) as
        | { div?: HTMLElement; viewport?: { convertToPdfPoint: (x: number, y: number) => number[] } }
        | undefined;
      if (!pageView?.div || !pageView.viewport) return null;

      // The top-left of the *visible* region, expressed in the page's own
      // coordinate space — which is what makes it portable. Measured as "where
      // the container's top edge falls within this page", so a reader halfway
      // down page 4 broadcasts that, not "scrolled 3182px".
      const containerRect = handle.container.getBoundingClientRect();
      const pageRect = pageView.div.getBoundingClientRect();
      const [left, top] = pageView.viewport.convertToPdfPoint(
        containerRect.left - pageRect.left,
        containerRect.top - pageRect.top,
      );
      counter += 1;
      return {
        pageIndex,
        pdfPoint: [left, top],
        zoomMode: numericOrNamedScale(handle.viewer.currentScaleValue),
        t: counter,
      };
    };

    const send = () => {
      timer = null;
      // Suppressed while applying somebody else's position — guard one.
      if (applyingRemoteRef.current) return;
      const next = currentViewport();
      if (!next) return;
      const visibleHeight = Math.max(1, handle.container.clientHeight / handle.viewer.currentScale);
      // Guard two: don't send a position indistinguishable from the last one.
      if (!viewportChangedEnough(lastSentRef.current, next, visibleHeight)) return;
      lastSentRef.current = next;
      publish({ viewport: next });
    };

    // Throttled to ~10Hz rather than debounced: a follower should track a
    // leader's scroll continuously, and awareness already coalesces, so
    // intermediate states are dropped rather than queued (docs/PDF.md §9).
    const schedule = () => {
      if (timer !== null) return;
      timer = window.setTimeout(send, PRESENCE_THROTTLE_MS);
    };

    handle.eventBus.on("updateviewarea", schedule);
    handle.eventBus.on("scalechanging", schedule);
    handle.eventBus.on("rotationchanging", schedule);
    schedule();

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      handle.eventBus.off("updateviewarea", schedule);
      handle.eventBus.off("scalechanging", schedule);
      handle.eventBus.off("rotationchanging", schedule);
    };
  }, [handle, publish]);

  // ---- apply the followed reader's viewport -------------------------------
  useEffect(() => {
    if (!handle || following === null) return;
    const target = readers.find((reader) => reader.clientId === following);
    const viewport = target?.presence.viewport;
    if (!viewport) return;

    if (isStale(lastAppliedRef.current.get(following) ?? null, viewport)) return;
    lastAppliedRef.current.set(following, viewport.t);

    applyingRemoteRef.current = true;
    handle.viewer.scrollPageIntoView({
      pageNumber: viewport.pageIndex + 1,
      // `null` for zoom preserves *this* reader's zoom — a follower should see
      // the same content, not be forced into the leader's magnification
      // (docs/PDF.md §9). It is also what makes following usable on a different
      // screen size at all.
      destArray: [viewport.pageIndex, { name: "XYZ" }, viewport.pdfPoint[0], viewport.pdfPoint[1], null],
    });

    // Cleared on the frame after the scroll's own updateviewarea, so the echo
    // it provokes is suppressed rather than rebroadcast.
    const clear = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      applyingRemoteRef.current = false;
    }));
    handle.eventBus.on("updateviewarea", clear);
    const fallback = window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 500);

    return () => {
      handle.eventBus.off("updateviewarea", clear);
      window.clearTimeout(fallback);
    };
  }, [handle, following, readers]);

  // ---- any local scroll gesture drops the follow ---------------------------
  useEffect(() => {
    if (!handle || following === null) return;
    const container = handle.container;

    // docs/PDF.md §9: "any local scroll gesture immediately dropping the
    // follow". Bound to *input* events rather than to `scroll`, which is the
    // whole trick — a programmatic scrollPageIntoView fires `scroll` too, so
    // listening for that would make following cancel itself on the first frame.
    const drop = () => setFollowing(null);
    container.addEventListener("wheel", drop, { passive: true });
    container.addEventListener("touchmove", drop, { passive: true });
    container.addEventListener("keydown", drop);

    return () => {
      container.removeEventListener("wheel", drop);
      container.removeEventListener("touchmove", drop);
      container.removeEventListener("keydown", drop);
    };
  }, [handle, following]);

  const setLeading = useCallback(
    (next: boolean) => {
      setLeadingState(next);
      publish({ leading: next });
    },
    [publish],
  );

  const follow = useCallback(
    (clientId: number | null) => {
      setFollowing(clientId);
      lastAppliedRef.current.delete(clientId ?? -1);
      publish({ following: clientId });
    },
    [publish],
  );

  const publishSelection = useCallback(
    (selection: { pageIndex: number; quads: Quad[] } | null) => {
      // Clearing an already-cleared selection is not a broadcast anyone needs,
      // and it is by far the common case: the caller's trigger is
      // `selectionchange` on `document` (PdfAnnotationSurface's capture
      // effect), which fires for every caret move on the page — including one
      // per keystroke in an annotation composer, itself a contenteditable.
      // `setAwarenessField` has no such guard of its own: y-protocols bumps the
      // awareness clock and fans the state out to every other reader whether or
      // not the value changed, so without this a reader typing a paragraph
      // sends the collab process a stream of identical nulls.
      //
      // Read off `localRef` rather than a ref of its own, so the "what did we
      // last publish" answer has exactly one home — `publish` above is what
      // writes it, and a second copy could disagree with it. Null before the
      // connection exists, which correctly suppresses too: `publish` no-ops in
      // that state anyway.
      //
      // Only the null case is deduplicated. Two *different* selections must
      // both go out, and two identical non-null ones are already bounded by the
      // caller's debounce — the viewport broadcaster above needs
      // `viewportChangedEnough` precisely because its trigger is a raw scroll
      // stream with no such settle step.
      if (selection === null && localRef.current?.selection == null) return;
      publish({ selection });
    },
    [publish],
  );

  return { readers, leading, setLeading, following, follow, publishSelection };
}

/** pdfjs reports `currentScaleValue` as a string; the wire format wants a number or a named mode. */
function numericOrNamedScale(value: string): ViewportState["zoomMode"] {
  if (value === "page-fit" || value === "page-width") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "page-width";
}
