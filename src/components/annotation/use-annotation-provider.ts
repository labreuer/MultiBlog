"use client";

import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { getCollabUrl } from "@/lib/collab-url";

export type AnnotationConnection = {
  provider: HocuspocusProvider | null;
  ydoc: Y.Doc;
  // PLAN.md §22e — what /api/annotation/[id]/token decided about *this*
  // viewer's write access. Null until the token comes back; the caller should
  // treat null as "not yet known" rather than as writable, since the only
  // honest default before the round trip is neither.
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
export function useAnnotationProvider(annotationId: string): AnnotationConnection {
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [readOnly, setReadOnly] = useState<boolean | null>(null);
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

    (async () => {
      try {
        const res = await fetch(`/api/annotation/${annotationId}/token`, { method: "POST" });
        if (!res.ok) throw new Error("Failed to authenticate.");
        const { token, documentName, readOnly: ro } = (await res.json()) as {
          token: string;
          documentName: string;
          readOnly?: boolean;
        };
        if (cancelled) return;
        firstToken = token;
        setReadOnly(ro === true);

        instance = new HocuspocusProvider({
          url: getCollabUrl(),
          name: documentName,
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
  }, [annotationId, ydoc]);

  return { provider, ydoc, readOnly, error };
}
