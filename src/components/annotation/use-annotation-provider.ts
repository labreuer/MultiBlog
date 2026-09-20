"use client";

import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { attachProvider } from "@/lib/collab-socket";
import { useDocPresence } from "./doc-presence-context";
import type { AnnotationConnectionBundle } from "@/lib/annotation-connection";

export type AnnotationConnection = {
  provider: HocuspocusProvider | null;
  ydoc: Y.Doc;
  // PLAN.md §22e — what the token decided about *this* viewer's write
  // access. Null until the token comes back; the caller should treat null as
  // "not yet known" rather than as writable, since the only honest default
  // before the round trip is neither. A caller handed a pre-minted bundle
  // knows from the first render and never sees the null.
  readOnly: boolean | null;
  error: string | null;
};

// The provider-connection lifecycle for one annotation's ydoc, factored out of
// LiveAnnotationComposer (PLAN.md §13j Phase 2/4) when §22e gave a *posted*
// body an editor too. Both surfaces need the identical connect-on-mount /
// destroy-on-unmount dance plus the token refresher Hocuspocus calls on
// reconnect; what differs between them is only what they render around it.
//
// The `firstToken` single-use cache is not an optimization — it's what keeps
// the initial connection from spending a second round trip on a token the
// component already holds, while still giving the provider a real refresher
// for every later reconnect. Same shape DocEditor.tsx uses.
//
// The connection is a *document* on the page's one shared socket, not a
// socket of its own (docs/YDOC.md "One socket per page"): opening an
// annotation costs the token round trip plus auth and sync on a socket the
// surface already holds, never a fresh handshake. Every surface that mounts
// an annotation editor sits inside a DocPresenceProvider, which owns that
// socket. Read-only or writable is still decided per document, by this
// annotation's own token — the doc tap being read-only on the same socket
// constrains nothing here.
//
// **`initialConnection` is the bundle an action already minted** — see
// annotation-connection.ts. The handshake was already gone; what is left of
// "opening an annotation costs a token round trip" is that round trip, and
// with a bundle in hand this hook awaits nothing before attaching. The action
// that created the DRAFT row or opened the edit session answered the same
// question on its way back, with more certainty than the route has, having
// just written the row. Without one (a moved draft, OwnDraftsList, the
// editor's rail — anything mounted on a row this client didn't just act on)
// it fetches, exactly as every caller used to. Either way the bundle is good
// for the *first* attempt only; every reconnect goes through `fetchToken`,
// since these expire in two minutes.
export function useAnnotationProvider(
  annotationId: string,
  initialConnection?: AnnotationConnectionBundle,
): AnnotationConnection {
  const { getSocket } = useDocPresence();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [readOnly, setReadOnly] = useState<boolean | null>(initialConnection?.readOnly ?? null);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- one Y.Doc per annotation id, deliberately recreated when that changes and never otherwise
  const ydoc = useMemo(() => new Y.Doc(), [annotationId]);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;

    let firstToken: string | null = null;
    async function fetchToken(): Promise<string> {
      if (firstToken !== null) {
        const t = firstToken;
        firstToken = null;
        return t;
      }
      const res = await fetch(`/api/annotation/${annotationId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate.");
      const { token } = (await res.json()) as { token: string };
      return token;
    }

    async function fetchConnection(): Promise<AnnotationConnectionBundle> {
      const res = await fetch(`/api/annotation/${annotationId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate.");
      const bundle = (await res.json()) as Partial<AnnotationConnectionBundle>;
      // `lineage` is checked as strictly as the other two even though
      // nothing here reads it yet: it is PLAN.md §11e's IndexedDB key, and
      // the one wrong value that would do real damage is a plausible-looking
      // default. Better to refuse the response than to hand a later
      // `attachIndexeddb` a lineage nobody minted.
      if (
        typeof bundle.token !== "string" ||
        typeof bundle.documentName !== "string" ||
        typeof bundle.lineage !== "number"
      ) {
        throw new Error("Failed to authenticate.");
      }
      return {
        token: bundle.token,
        documentName: bundle.documentName,
        lineage: bundle.lineage,
        // Absent means writable (YdocTokenPayload's rule), so only an
        // explicit true narrows it — the same coercion this did when it
        // parsed the response inline.
        readOnly: bundle.readOnly === true,
      };
    }

    (async () => {
      try {
        // `??` short-circuits, so the pre-minted path never suspends: this
        // body runs synchronously inside the effect and the document is
        // attached on the render right after mount rather than a round trip
        // later.
        const connection = initialConnection ?? (await fetchConnection());
        if (cancelled) return;
        firstToken = connection.token;
        setReadOnly(connection.readOnly);

        instance = attachProvider(getSocket(), {
          name: connection.documentName,
          document: ydoc,
          token: fetchToken,
        });
        setProvider(instance);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      ydoc.destroy();
    };
    // getSocket is a stable context callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `initialConnection` is read once, at attach time; a later identity change must not tear down a live connection to re-attach with a token no fresher than the refresher's
  }, [annotationId, ydoc, getSocket]);

  return { provider, ydoc, readOnly, error };
}
