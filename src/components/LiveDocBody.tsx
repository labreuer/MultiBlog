"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { docContentExtensions } from "@/lib/tiptap-schema";
import { renderYdocDoc } from "@/lib/ydoc-render";
import { PendingAnnotation, setPendingAnnotation } from "@/lib/pending-annotation-extension";
import { findQuoteOccurrences } from "@/lib/quote-occurrences";
import AnnotationPopover from "./annotation/AnnotationPopover";
import { useDocPresence } from "./annotation/doc-presence-context";
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
  // The viewer's own color (PLAN.md §13f), resolved server-side and passed
  // down rather than read here via useSession() — see DocView.tsx.
  userColor: string;
  // See CollabEditorBody's identical prop — PLAN.md §14f.
  ariaLabel?: string;
  // PLAN.md §14f — /side-by-side claims the selection gesture for doc-link
  // creation instead of annotation (§14i adds the doc-link popover in its
  // place; Phase 2 just suppresses this one). "none" skips both the pending-
  // decoration tracking and AnnotationPopover entirely, so a selection on
  // that page does nothing until the doc-link composer exists.
  selectionUi?: "annotation" | "none";
  // Paints over .annotation-highlight (prose.module.css's .noAnnotations)
  // without touching the schema — the mark itself stays registered and
  // synced regardless. See §14f for why dropping the mark type instead
  // would be destructive.
  suppressAnnotations?: boolean;
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
export default function LiveDocBody({
  docId,
  initialBodyJSON,
  staticBody,
  overrideBodyJSON,
  userColor,
  ariaLabel = "Post body",
  selectionUi = "annotation",
  suppressAnnotations = false,
}: Props) {
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
  const { setAwareness } = useDocPresence();

  // Read inside the setContent-driven handlers below, which run outside
  // React's render cycle and would otherwise close over a stale `pending`
  // from whenever the effect/listener was first set up.
  const pendingRef = useRef<PendingSelection | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const editor = useEditor({
    // PendingAnnotation (PLAN.md §13f) is view-only — a decoration, not a
    // node/mark type — so appending it here doesn't touch the schema
    // docContentExtensions itself defines, and can't drift the reading
    // view's schema from the editor's or the server's.
    extensions: [...docContentExtensions, PendingAnnotation],
    content: initialBodyJSON,
    editable: false,
    immediatelyRender: false,
    // Same aria-label CollabEditorBody's editor already carries, so the e2e
    // suite's bodyEditor() helper (e2e/fixtures.ts) and the .tiptap-ordering
    // convention (CLAUDE.md) both work for a doc's reading view for free.
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox" } },
    onCreate: () => setReady(true),
    onSelectionUpdate: ({ editor: liveEditor }) => {
      if (selectionUi === "none") return;
      const { from, to, empty } = liveEditor.state.selection;
      const container = containerRef.current;
      if (empty || !container) {
        setPending(null);
        setPendingAnnotation(liveEditor.view, null);
        return;
      }
      const quotedText = liveEditor.state.doc.textBetween(from, to, " ");
      if (!quotedText.trim()) {
        setPending(null);
        setPendingAnnotation(liveEditor.view, null);
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
      setPendingAnnotation(liveEditor.view, { from, to, color: userColor });
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

  // PLAN.md §13f — re-resolves the pending selection against the doc after
  // any setContent call (a live remote update or a scrub jump), both of
  // which can move or destroy the text a reader has selected out from under
  // them. The decoration's own position-mapping (pending-annotation-
  // extension.ts's `apply`) already tracks an ordinary transaction; this is
  // the explicit fallback for the case that doesn't hold — a setContent
  // call whose diff isn't a simple insert/delete around the selection.
  function reresolvePending(liveEditor: Editor) {
    const current = pendingRef.current;
    if (!current) return;
    const doc = liveEditor.state.doc;
    const stillValid = current.to <= doc.content.size && doc.textBetween(current.from, current.to, " ") === current.quotedText;
    if (stillValid) return;

    const container = containerRef.current;
    const occurrences = container ? findQuoteOccurrences(doc, current.quotedText) : [];
    if (occurrences.length === 1 && container) {
      const { from, to } = occurrences[0];
      const coords = liveEditor.view.coordsAtPos(to);
      const containerRect = container.getBoundingClientRect();
      const next: PendingSelection = {
        from,
        to,
        quotedText: current.quotedText,
        top: coords.bottom - containerRect.top,
        left: coords.left - containerRect.left,
      };
      setPending(next);
      setPendingAnnotation(liveEditor.view, { from, to, color: userColor });
    } else {
      // No unique match any more — the selected text changed underneath
      // the reader. Close the popover rather than leave it pointing at a
      // range that no longer means what it did.
      setPending(null);
      setPendingAnnotation(liveEditor.view, null);
    }
  }

  // undefined (the prop's unset state) means "no scrub bar mounted yet" —
  // deliberately distinct from null (mounted, but at the live/latest
  // position) so this effect only ever fires once scrubbing has actually
  // produced a historical body to show.
  useEffect(() => {
    if (overrideBodyJSON && editor) {
      editor.commands.setContent(overrideBodyJSON, { emitUpdate: false });
      reresolvePending(editor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reresolvePending closes over pendingRef/userColor, not state that should retrigger this
  }, [editor, overrideBodyJSON]);

  useEffect(() => {
    if (!pending) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setPending(null);
        if (editorRef.current) setPendingAnnotation(editorRef.current.view, null);
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
            if (editorRef.current) reresolvePending(editorRef.current);
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
        // PLAN.md §13i — a readOnly connection's awareness still flows
        // freely (only document *content* updates are gated), so this same
        // read-only tap doubles as the channel every LiveAnnotationComposer
        // on the page publishes "someone is writing an annotation" into.
        setAwareness(instance.awareness);
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
      setAwareness(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reresolvePending closes over pendingRef/userColor, not state that should retrigger this connection effect
  }, [docId, ydoc]);

  if (error) {
    return <p style={{ color: "crimson" }}>{error}</p>;
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {synced && <span data-testid="live-doc-synced" style={{ display: "none" }} />}
      <div style={{ display: ready ? "none" : "block" }}>{staticBody}</div>
      <div
        className={`${proseStyles.prose} ${suppressAnnotations ? proseStyles.noAnnotations : ""}`}
        style={{ display: ready ? "block" : "none" }}
      >
        <EditorContent editor={editor} />
      </div>
      {selectionUi === "annotation" && pending && (
        <AnnotationPopover
          docId={docId}
          top={pending.top}
          left={pending.left}
          from={pending.from}
          to={pending.to}
          quotedText={pending.quotedText}
          onPosted={() => {
            setPending(null);
            if (editorRef.current) setPendingAnnotation(editorRef.current.view, null);
          }}
          onCancel={() => {
            setPending(null);
            if (editorRef.current) setPendingAnnotation(editorRef.current.view, null);
          }}
        />
      )}
    </div>
  );
}
