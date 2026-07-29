"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { renderYdocDoc } from "@/lib/ydoc-render";
import proseStyles from "@/styles/prose.module.css";

type Props = {
  docId: string;
  staticBody: ReactNode;
};

// The reading view's live half (PLAN.md §12g) — shows staticBody (server-
// rendered from Doc.proseJson, so its first paint matches the SSR HTML
// exactly) until a read-only Hocuspocus connection has synced at least once,
// then swaps to renderYdocDoc's decode of the live document on every change.
// No ProseMirror editor is ever constructed here (unlike DocEditor/
// CollabEditorBody) — a reader gets a plain re-rendered React tree, which is
// what makes "no CollaborationCaret for a read-only client" (§12g) true
// structurally: there's no editor instance for a caret extension to attach
// to in the first place, not a flag turning one off.
export default function LiveDocBody({ docId, staticBody }: Props) {
  const [body, setBody] = useState<ReactNode>(staticBody);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [docId]);

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
      const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to authenticate.");
      const { token } = (await res.json()) as { token: string };
      return token;
    }

    (async () => {
      try {
        const res = await fetch(`/api/doc/${docId}/token`, { method: "POST" });
        if (!res.ok) {
          throw new Error("Failed to authenticate.");
        }
        const { token, documentName } = (await res.json()) as { token: string; documentName: string };
        if (cancelled) return;
        firstToken = token;

        ydoc.on("update", () => {
          const result = renderYdocDoc(ydoc);
          if (result.ok) {
            setBody(<div className={proseStyles.prose}>{result.body}</div>);
          } else {
            setError(result.error);
          }
        });

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: documentName,
          document: ydoc,
          token: fetchToken,
        });
      } catch {
        // Read-only and best-effort: the server-rendered staticBody is
        // already showing correct (if potentially stale) content, so a
        // failure to establish the live tap just means it stays static
        // rather than surfacing an error the reader can't act on.
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      ydoc.destroy();
    };
  }, [docId, ydoc]);

  if (error) {
    return <p style={{ color: "crimson" }}>{error}</p>;
  }
  return body;
}
