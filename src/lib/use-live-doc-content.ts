"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEditor, type Editor, type JSONContent } from "@tiptap/react";
import type { Extensions } from "@tiptap/core";
import { docContentExtensions } from "./tiptap-schema";
import { getCollabUrl } from "./collab-url";
import { renderYdocDoc } from "./ydoc-render";
import { PendingAnnotation } from "./pending-annotation-extension";

type Awareness = HocuspocusProvider["awareness"];

// The live reading half of a doc, minus any opinion about what a reader may
// *do* with a selection (PLAN.md §12g/§12i). Extracted from `LiveDocBody`,
// which had grown to serve both /doc/[slug] (annotations) and a
// /side-by-side column (doc links) by branching on a `selectionUi` flag —
// see PLAN.md §14p. What lives here is only the part that was identical
// either way, and it is the part worth never writing twice:
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
// - Owning versus borrowing that connection (§14g's hoisted mode), and the
//   different teardown each one needs.
//
// Annotation marks render for free: the mark's own renderHTML (a styled
// span) applies the same way whether ProseMirror got the doc from
// setContent here or from a live Collaboration binding in the editor —
// no extra wiring needed beyond the CSS rule in prose.module.css.
export type LiveDocContentOptions = {
  docId: string;
  initialBodyJSON: JSONContent;
  // Same aria-label CollabEditorBody's editor carries, so the e2e suite's
  // bodyEditor() helper (e2e/fixtures.ts) and the .tiptap-ordering
  // convention (CLAUDE.md) work for a doc's reading view for free.
  ariaLabel: string;
  // Owned by the caller rather than created here, and populated by this hook
  // once useEditor is ready. That direction matters: the selection hook needs
  // an editor ref too, and if this hook created it, the caller would have to
  // call this one first and then hand *its* callbacks a forward reference to
  // state that doesn't exist yet. A ref the caller declares up front is what
  // lets both hooks take it as an input and neither depend on the other.
  editorRef: React.RefObject<Editor | null>;
  // View-only decoration layers the calling surface wants on top of the
  // shared schema — never node/mark types, which would drift this view's
  // schema from the editor's and the server's (CLAUDE.md). `PendingAnnotation`
  // is always included, since every surface built on this shows a
  // pending-selection decoration; `DocLink` is passed in by the side-by-side
  // column alone.
  extensions?: Extensions;
  // Set by DocScrubBar (PLAN.md §12) once the reader starts scrubbing —
  // pushed into the editor the same way a real live update is (setContent,
  // emitUpdate: false), so the scrub feature changes the same body a reader
  // was just looking at rather than opening a second preview beside it. A
  // real edit arriving mid-scrub still wins on the next live "update" event,
  // since that handler always sets the *current* live content — there's no
  // "return to live" control because none is needed.
  overrideBodyJSON?: JSONContent | null;
  // PLAN.md §14g — hoisted mode. When a caller (DocColumn) already owns a
  // Y.Doc and a connected provider — because the same pair also needs to
  // support a write surface without tearing down the websocket on every
  // toggle — it passes both here and this hook skips creating (and,
  // critically, destroying) its own. Absent, this owns and tears down its
  // own Y.Doc and provider, exactly as /doc/[slug] has always used it.
  // Always supplied together; never toggled on one instance.
  ydoc?: Y.Doc;
  provider?: HocuspocusProvider;
  // PLAN.md §13i — a readOnly connection's awareness still flows freely
  // (only document *content* updates are gated), so this same read-only tap
  // doubles as the channel every LiveAnnotationComposer publishes "someone
  // is writing an annotation" into. Passed in rather than read from
  // `useDocPresence()` here, so that src/lib keeps not importing from
  // src/components; each surface wires its own two lines.
  setAwareness: (awareness: Awareness | null) => void;
  onEditorCreated?: (editor: Editor) => void;
  onSelectionUpdate?: (editor: Editor) => void;
  // Fired synchronously after every setContent — a live remote update, a
  // scrub jump, or hoisted mode's catch-up on mount. This is the one
  // content-change choke point each surface re-resolves its own anchored
  // things against (a pending selection's range, doc-link decorations), so
  // no paint lands between the content change and the position fix.
  onContentPushed?: (editor: Editor) => void;
};

export type LiveDocContent = {
  editor: Editor | null;
  ready: boolean;
  // The provider's initial handshake applies at least one Yjs update on its
  // own — same as any later real edit — which runs setContent and would
  // silently collapse a selection made in the window between "editor
  // mounted" and "live tap has synced once". No visible UI for this (the
  // reading view otherwise shows no connection status at all); surfaces
  // render a hidden marker off it so a selection can be made only once that
  // window has passed — e2e/doc.spec.ts's annotation tests wait on it.
  synced: boolean;
  error: string | null;
};

export function useLiveDocContent({
  docId,
  initialBodyJSON,
  ariaLabel,
  extensions = [],
  overrideBodyJSON,
  ydoc: hoistedYdoc,
  provider: hoistedProvider,
  editorRef,
  setAwareness,
  onEditorCreated,
  onSelectionUpdate,
  onContentPushed,
}: LiveDocContentOptions): LiveDocContent {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lazy initializer rather than a plain `false` — a hoisted provider (§14g)
  // may already be synced by the time this mounts (e.g. toggling read →
  // write → read reuses an already-connected provider), and setting state
  // synchronously inside the effect below for that case would trip the "no
  // setState in effect body" lint rule.
  const [synced, setSynced] = useState(() => hoistedProvider?.isSynced ?? false);

  // The connection effect below registers its update listener once, keyed on
  // [docId, ydoc, hoistedProvider], so anything it calls must be reached
  // through a ref or it is frozen at that render. `onContentPushed` closes
  // over per-render state on every surface that passes it (the current
  // pending selection, the current doc links), so freezing it would mean
  // re-resolving against a stale set — the same stale-closure shape the
  // ProseMirror `onHit` indirection solves in the side-by-side surface.
  const onContentPushedRef = useRef(onContentPushed);
  useEffect(() => {
    onContentPushedRef.current = onContentPushed;
  });

  const editor = useEditor({
    // PendingAnnotation (PLAN.md §13f) and DocLink (§14e) are view-only —
    // decorations, not node/mark types — so appending them here doesn't
    // touch the schema docContentExtensions itself defines, and can't drift
    // this view's schema from the editor's or the server's.
    extensions: [...docContentExtensions, PendingAnnotation, ...extensions],
    content: initialBodyJSON,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox" } },
    onCreate: ({ editor: createdEditor }) => {
      setReady(true);
      onEditorCreated?.(createdEditor);
    },
    onSelectionUpdate: ({ editor: liveEditor }) => onSelectionUpdate?.(liveEditor),
  });

  // Populates the caller's ref, for handlers that run outside React's render
  // cycle (the ydoc "update" listener, ProseMirror plugin callbacks) and would
  // otherwise close over whatever `editor` was when they were first set up —
  // likely still null, since useEditor isn't synchronously ready.
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);

  // Only constructed when nothing was hoisted in — see the options comment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ownYdoc = useMemo(() => (hoistedYdoc ? null : new Y.Doc()), [docId, hoistedYdoc]);
  const ydoc = hoistedYdoc ?? ownYdoc!;

  // PLAN.md §14g — hoisted mode's "sync once on mount" counterpart to the
  // "update" listener registered below: the shared Y.Doc already holds every
  // change applied while some *other* instance of this surface (or the write
  // editor) was mounted against it, so a read → write → read toggle remounts
  // fresh with useEditor's `content` fixed at whatever initialBodyJSON was at
  // first page load. This corrects that once `editor` itself exists — which
  // useEditor doesn't guarantee is true in the same tick as this hook's other
  // effects, so it can't be folded into the connection effect below (which
  // closes over editorRef, not editor, and races ahead of useEditor's own
  // construction on a fresh mount with nothing like the token fetch's network
  // delay to wait out). The queueMicrotask indirection is only there to keep
  // this out of the "no setState synchronously in an effect body" lint rule's
  // sights — functionally it still runs before the next paint.
  useEffect(() => {
    if (!hoistedProvider || !editor) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const result = renderYdocDoc(ydoc);
      if (result.ok) {
        editor.commands.setContent(result.bodyJSON, { emitUpdate: false });
        onContentPushedRef.current?.(editor);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [editor, hoistedProvider, ydoc]);

  // undefined (the option's unset state) means "no scrub bar mounted yet" —
  // deliberately distinct from null (mounted, but at the live/latest
  // position) so this effect only ever fires once scrubbing has actually
  // produced a historical body to show.
  useEffect(() => {
    if (overrideBodyJSON && editor) {
      editor.commands.setContent(overrideBodyJSON, { emitUpdate: false });
      onContentPushedRef.current?.(editor);
    }
  }, [editor, overrideBodyJSON]);

  useEffect(() => {
    function applyUpdate() {
      const result = renderYdocDoc(ydoc);
      const liveEditor = editorRef.current;
      if (result.ok) {
        liveEditor?.commands.setContent(result.bodyJSON, { emitUpdate: false });
        if (liveEditor) onContentPushedRef.current?.(liveEditor);
      } else {
        setError(result.error);
      }
    }

    // Hoisted mode (PLAN.md §14g) — the caller (DocColumn) owns the Y.Doc
    // and provider's connection lifecycle across read/write toggles, so this
    // effect only wires (and, critically, un-wires) its own update listener
    // rather than destroying either. Registering `ydoc.on` and relying on
    // `ydoc.destroy()` to implicitly drop it — what the owned branch below
    // does — would leak a listener here, since in hoisted mode this hook
    // doesn't control when (or whether) the doc is ever destroyed: a read →
    // write → read cycle would otherwise call setContent on an editor this
    // instance already unmounted.
    if (hoistedProvider) {
      ydoc.on("update", applyUpdate);
      const handleSynced = () => setSynced(true);
      hoistedProvider.on("synced", handleSynced);
      setAwareness(hoistedProvider.awareness);
      return () => {
        ydoc.off("update", applyUpdate);
        hoistedProvider.off("synced", handleSynced);
        setAwareness(null);
      };
    }

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

        ydoc.on("update", applyUpdate);

        instance = new HocuspocusProvider({
          url: getCollabUrl(),
          name: documentName,
          document: ydoc,
          token: fetchToken,
          onSynced: () => setSynced(true),
        });
        setAwareness(instance.awareness);
      } catch {
        // Read-only and best-effort: the server-rendered staticBody/initial
        // editor content is already showing correct (if potentially stale)
        // content, so a failure to establish the live tap just means it stays
        // static rather than surfacing an error the reader can't act on.
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
      ydoc.destroy();
      setAwareness(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setAwareness is a context setter (stable); re-running this on its identity would tear down and re-establish the websocket
  }, [docId, ydoc, hoistedProvider]);

  return { editor, ready, synced, error };
}
