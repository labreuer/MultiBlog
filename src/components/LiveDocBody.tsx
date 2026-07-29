"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { docContentExtensions } from "@/lib/tiptap-schema";
import { renderYdocDoc } from "@/lib/ydoc-render";
import AnnotationPopover from "./annotation/AnnotationPopover";
import proseStyles from "@/styles/prose.module.css";

type PendingSelection = {
  from: number;
  to: number;
  quotedText: string;
  top: number;
  left: number;
};

type Props = {
  docId: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
  // Set by DocScrubBar (PLAN.md §12) once the reader starts scrubbing —
  // pushed into the editor the same way a real live update is (setContent,
  // emitUpdate: false), so the scrub feature changes the same body a reader
  // was just looking at rather than opening a second preview beside it. A
  // real edit arriving mid-scrub still wins on the next live "update" event,
  // since that handler always sets the *current* live content — there's no
  // "return to live" control because none is needed.
  overrideBodyJSON?: JSONContent | null;
};

// The reading view's live half (PLAN.md §12g/§12i). Two things this
// component is responsible for, both deliberately different from
// AnnotatableArticle (the post-side equivalent it otherwise mirrors closely
// — see PLAN.md §12i for why it's a sibling rather than the same file):
//
// - Live updates. Content isn't fixed at mount the way a published post's
//   is — a read-only Hocuspocus connection taps the live document and
//   pushes each change into the editor via setContent, so an already-open
//   tab reflects an author's edits with no reload.
// - No CollaborationCaret, structurally. This is a plain (non-Collaboration)
//   useEditor instance, editable: false, with content pushed in by hand
//   rather than bound to the Y.Doc through the Collaboration extension —
//   there's no live editor binding for a caret extension to attach to in
//   the first place, which is what makes "no CollaborationCaret for a
//   read-only reader" (§12g) true by construction rather than a flag.
//
// Annotation marks render for free: the mark's own renderHTML (a styled
// span) applies the same way whether ProseMirror got the doc from
// setContent here or from a live Collaboration binding in the editor —
// no extra wiring needed beyond the CSS rule in prose.module.css.
export default function LiveDocBody({ docId, initialBodyJSON, staticBody, overrideBodyJSON }: Props) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The provider's initial handshake applies at least one Yjs update on
  // its own — same as any later real edit — which runs the setContent
  // call below and would silently collapse a selection made in the window
  // between "editor mounted" and "live tap has synced once". No visible UI
  // for this (the reading view otherwise shows no connection status at
  // all); the marker exists so a selection can be made only once that
  // window has passed — e2e/doc.spec.ts's annotation tests wait on it.
  const [synced, setSynced] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: docContentExtensions,
    content: initialBodyJSON,
    editable: false,
    immediatelyRender: false,
    // Same aria-label CollabEditorBody's editor already carries, so the e2e
    // suite's bodyEditor() helper (e2e/fixtures.ts) and the .tiptap-ordering
    // convention (CLAUDE.md) both work for a doc's reading view for free.
    editorProps: { attributes: { "aria-label": "Post body", role: "textbox" } },
    onCreate: () => setReady(true),
    onSelectionUpdate: ({ editor: liveEditor }) => {
      const { from, to, empty } = liveEditor.state.selection;
      const container = containerRef.current;
      if (empty || !container) {
        setPending(null);
        return;
      }
      const quotedText = liveEditor.state.doc.textBetween(from, to, " ");
      if (!quotedText.trim()) {
        setPending(null);
        return;
      }
      const coords = liveEditor.view.coordsAtPos(to);
      const containerRect = container.getBoundingClientRect();
      setPending({
        from,
        to,
        quotedText,
        top: coords.bottom - containerRect.top,
        left: coords.left - containerRect.left,
      });
    },
  });

  // The ydoc "update" handler below is registered once, inside an effect
  // that only re-runs on docId change — it needs whatever `editor` is
  // *at the time an update arrives*, not whatever it was when the effect
  // was set up (which is likely still null, since useEditor isn't
  // synchronously ready). A ref sidesteps the stale-closure trap without
  // making the connection effect itself depend on `editor`'s identity.
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // undefined (the prop's unset state) means "no scrub bar mounted yet" —
  // deliberately distinct from null (mounted, but at the live/latest
  // position) so this effect only ever fires once scrubbing has actually
  // produced a historical body to show.
  useEffect(() => {
    if (overrideBodyJSON) {
      editor?.commands.setContent(overrideBodyJSON, { emitUpdate: false });
    }
  }, [editor, overrideBodyJSON]);

  useEffect(() => {
    if (!pending) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPending(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [pending]);

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
            editorRef.current?.commands.setContent(result.bodyJSON, { emitUpdate: false });
          } else {
            setError(result.error);
          }
        });

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: documentName,
          document: ydoc,
          token: fetchToken,
          onSynced: () => setSynced(true),
        });
      } catch {
        // Read-only and best-effort: the server-rendered staticBody/initial
        // editor content is already showing correct (if potentially stale)
        // content, so a failure to establish the live tap just means it
        // stays static rather than surfacing an error the reader can't act on.
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

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {synced && <span data-testid="live-doc-synced" style={{ display: "none" }} />}
      <div style={{ display: ready ? "none" : "block" }}>{staticBody}</div>
      <div className={proseStyles.prose} style={{ display: ready ? "block" : "none" }}>
        <EditorContent editor={editor} />
      </div>
      {pending && (
        <AnnotationPopover
          docId={docId}
          top={pending.top}
          left={pending.left}
          from={pending.from}
          to={pending.to}
          quotedText={pending.quotedText}
          onPosted={() => setPending(null)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
