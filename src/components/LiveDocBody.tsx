"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { docContentExtensions } from "@/lib/tiptap-schema";
import { renderYdocDoc } from "@/lib/ydoc-render";
import { PendingAnnotation, setPendingAnnotation } from "@/lib/pending-annotation-extension";
import { findQuoteOccurrences } from "@/lib/quote-occurrences";
import { DocLink, setDocLinks, type ResolvedDocLink } from "@/lib/doc-link-extension";
import { createDocLinkResolver, captureAnchor, type DocLinkInput } from "@/lib/doc-link-anchor";
import AnnotationPopover from "./annotation/AnnotationPopover";
import DocLinkPopover from "./sidebyside/DocLinkPopover";
import DocLinkChooser from "./sidebyside/DocLinkChooser";
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
  // PLAN.md §14f/§14i — /side-by-side claims the selection gesture for
  // doc-link creation instead of annotation. "doclink" shows DocLinkPopover
  // on a selection instead of AnnotationPopover; "none" (Phase 2's original
  // placeholder) skips both the pending-decoration tracking and any
  // popover, and is unused now that Phase 5 wires "doclink" in.
  selectionUi?: "annotation" | "doclink" | "none";
  // Paints over .annotation-highlight (prose.module.css's .noAnnotations)
  // without touching the schema — the mark itself stays registered and
  // synced regardless. See §14f for why dropping the mark type instead
  // would be destructive.
  suppressAnnotations?: boolean;
  // PLAN.md §14g — hoisted mode. When a caller (DocColumn) already owns a
  // Y.Doc and a connected provider — because the same pair also needs to
  // support a write surface without tearing down the websocket on every
  // toggle — it passes both here and this component skips creating (and,
  // critically, destroying) its own. Absent, this behaves exactly as
  // /doc/[slug] has always used it: owns and tears down its own Y.Doc and
  // provider. Always supplied together; never toggled on one instance.
  ydoc?: Y.Doc;
  provider?: HocuspocusProvider;
  // PLAN.md §14e — doc links anchored to *this* doc, already carrying their
  // cascaded color; resolved against the current document (and re-resolved
  // on every content change) rather than trusted at whatever positions were
  // captured at creation time. Defaults to none, so /doc/[slug] (which
  // never passes this) behaves exactly as before.
  docLinks?: DocLinkInput[];
  // Which group's links should paint darker (§14h) — null means none. Also
  // what a newly created link (via DocLinkPopover, §14i) joins, when set.
  activeGroupId?: string | null;
  // Fired once DocLinkPopover successfully saves a new link — the caller
  // (DocColumn) appends it to its own docLinks state so the new highlight
  // appears immediately, without a page reload (doc links have no live
  // propagation channel, §14a).
  onDocLinkCreated?: (link: DocLinkInput) => void;
  // PLAN.md §14j — fired when an existing link's edit popover saves or is
  // deleted, so the caller can update/remove it from the same docLinks
  // state onDocLinkCreated appends to.
  onDocLinkUpdated?: (link: DocLinkInput) => void;
  onDocLinkDeleted?: (linkId: string) => void;
  // Fired live as the edit popover's color checkbox/swatch changes, before
  // Save — lets the highlight repaint immediately without waiting on
  // updateDocLink's round trip. Only meaningful in edit mode (a link
  // already exists to repaint); the create-mode popover has nothing to
  // preview against yet.
  onDocLinkColorPreview?: (linkId: string, overrideColor: string | null) => void;
  // Fired whenever a click opens a link's edit popover (directly, or via the
  // chooser) — lets the caller (SideBySideView) switch the active group to
  // match, the same "make this the active group" action the bar's dropdown
  // triggers.
  onDocLinkClicked?: (groupId: string) => void;
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
  ydoc: hoistedYdoc,
  provider: hoistedProvider,
  docLinks = [],
  activeGroupId = null,
  onDocLinkCreated,
  onDocLinkUpdated,
  onDocLinkDeleted,
  onDocLinkColorPreview,
  onDocLinkClicked,
}: Props) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  // PLAN.md §14j — click-routing state: at most one of these is non-null
  // at a time. editingLink opens the same DocLinkPopover the selection
  // flow uses, but in edit mode (a linkId is present); chooser appears
  // when a click hit more than one candidate.
  const [editingLink, setEditingLink] = useState<{ link: DocLinkInput; pos: number; top: number; left: number } | null>(
    null,
  );
  const [chooser, setChooser] = useState<{ candidates: DocLinkInput[]; pos: number; top: number; left: number } | null>(
    null,
  );
  // The provider's initial handshake applies at least one Yjs update on
  // its own — same as any later real edit — which runs the setContent
  // call below and would silently collapse a selection made in the window
  // between "editor mounted" and "live tap has synced once". No visible UI
  // for this (the reading view otherwise shows no connection status at
  // all); the marker exists so a selection can be made only once that
  // window has passed — e2e/doc.spec.ts's annotation tests wait on it.
  // Lazy initializer rather than a plain `false` — a hoisted provider
  // (§14g) may already be synced by the time this mounts (e.g. toggling
  // read → write → read reuses an already-connected provider), and setting
  // state synchronously inside the effect below for that case would trip
  // the "no setState in effect body" lint rule.
  const [synced, setSynced] = useState(() => hoistedProvider?.isSynced ?? false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { setAwareness } = useDocPresence();

  // Read inside the setContent-driven handlers below, which run outside
  // React's render cycle and would otherwise close over a stale `pending`
  // from whenever the effect/listener was first set up.
  const pendingRef = useRef<PendingSelection | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  // One resolver instance per component instance (i.e., per docId — the
  // whole component remounts on docId change), not per render or shared
  // page-wide: doc-link-anchor.ts's memoization is keyed on (doc identity,
  // links identity), and a shared resolver across two columns would thrash
  // between two unrelated docs' doc/links pairs, defeating the cache.
  const resolverRef = useRef(createDocLinkResolver());

  // PLAN.md §14j — a stable indirection into DocLink.configure({onHit}),
  // refreshed every render so it always sees the current docLinks/
  // activeGroupId/editor without forcing the editor extensions array
  // (fixed at construction) to be recreated — the same shape §14e's own
  // header comment describes for this exact callback. Declared here (an
  // empty no-op initially) so it can be referenced by useEditor's config
  // below; the real implementation is assigned once `editorRef` exists,
  // further down.
  const onHitRef = useRef<(hits: ResolvedDocLink[], pos: number) => void>(() => {});

  const editor = useEditor({
    // PendingAnnotation (PLAN.md §13f) is view-only — a decoration, not a
    // node/mark type — so appending it here doesn't touch the schema
    // docContentExtensions itself defines, and can't drift the reading
    // view's schema from the editor's or the server's. DocLink (§14e) is
    // the same: a decoration layer, no schema change. Configured with a
    // stable indirection into onHitRef (§14j) rather than reconfigured per
    // render — useEditor reads extensions once, at construction.
    extensions: [
      ...docContentExtensions,
      PendingAnnotation,
      DocLink.configure({ onHit: (hits, pos) => onHitRef.current(hits, pos), editable: false }),
    ],
    content: initialBodyJSON,
    editable: false,
    immediatelyRender: false,
    // Same aria-label CollabEditorBody's editor already carries, so the e2e
    // suite's bodyEditor() helper (e2e/fixtures.ts) and the .tiptap-ordering
    // convention (CLAUDE.md) both work for a doc's reading view for free.
    editorProps: { attributes: { "aria-label": ariaLabel, role: "textbox" } },
    onCreate: ({ editor: createdEditor }) => {
      setReady(true);
      syncDocLinks(createdEditor);
    },
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
      // Viewport-relative, not container-relative — the popover is
      // `position: fixed` (§14i) specifically so it isn't clipped by
      // `.scroller`'s `overflow-y: auto` (which forces overflow-x to clip
      // too) when a selection near a column's right edge would otherwise
      // need to spill into the other column to stay readable.
      const coords = liveEditor.view.coordsAtPos(to);
      setPending({
        from,
        to,
        quotedText,
        top: coords.bottom,
        left: coords.left,
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

  // PLAN.md §14j — the real onHitRef implementation, refreshed every render
  // so it always closes over the current docLinks/activeGroupId. Routing:
  // narrow to the active group first when it covers any of the hits;
  // otherwise (or with no active group) every hit is a candidate. One
  // candidate opens its edit popover directly; several open the chooser.
  useEffect(() => {
    onHitRef.current = (hits, pos) => {
      const liveEditor = editorRef.current;
      const container = containerRef.current;
      if (!liveEditor || !container) return;
      // Viewport-relative — see the onSelectionUpdate handler above.
      const coords = liveEditor.view.coordsAtPos(pos);
      const top = coords.bottom;
      const left = coords.left;

      let narrowed = hits;
      if (activeGroupId) {
        const inGroup = hits.filter((h) => h.groupId === activeGroupId);
        if (inGroup.length > 0) narrowed = inGroup;
      }
      const candidates = narrowed.map((h) => docLinks.find((l) => l.id === h.id)).filter((l): l is DocLinkInput => Boolean(l));
      if (candidates.length === 0) return;

      if (candidates.length === 1) {
        setEditingLink({ link: candidates[0], pos, top, left });
        setChooser(null);
        onDocLinkClicked?.(candidates[0].groupId);
      } else {
        setChooser({ candidates, pos, top, left });
        setEditingLink(null);
      }
    };
  });

  // A click that opens a popover here can also switch the active group
  // (onDocLinkClicked, above) — which can open/resize the group panel
  // above the columns and shift this column down. `pending`/`editingLink`'s
  // top/left were measured *before* that shift (coordsAtPos is called
  // synchronously inside the click handler, ahead of the re-render that
  // adds the panel), so `position: fixed`'s viewport coordinates would
  // otherwise stay pinned to the pre-shift spot — landing on whatever now
  // occupies that vacated space instead of tracking the anchor. A
  // `position: absolute` popover self-corrected here for free (its
  // container moved with it); re-measuring after the shift settles is
  // fixed's equivalent. useLayoutEffect, not useEffect, so the correction
  // lands before the browser paints the stale position.
  useLayoutEffect(() => {
    const liveEditor = editorRef.current;
    if (!liveEditor) return;
    if (pending) {
      const coords = liveEditor.view.coordsAtPos(pending.to);
      if (coords.bottom !== pending.top || coords.left !== pending.left) {
        setPending((prev) => (prev ? { ...prev, top: coords.bottom, left: coords.left } : prev));
      }
    }
    if (editingLink) {
      const coords = liveEditor.view.coordsAtPos(editingLink.pos);
      if (coords.bottom !== editingLink.top || coords.left !== editingLink.left) {
        setEditingLink((prev) => (prev ? { ...prev, top: coords.bottom, left: coords.left } : prev));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-measuring in response to activeGroupId's own reflow; pending/editingLink read via current value, not tracked as triggers (they're what this effect updates)
  }, [activeGroupId]);

  // Only constructed when nothing was hoisted in — see the Props comment.
  // Declared here (rather than beside the connection effect further down)
  // so the hoisted "sync once on mount" effect just below can reference it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ownYdoc = useMemo(() => (hoistedYdoc ? null : new Y.Doc()), [docId, hoistedYdoc]);
  const ydoc = hoistedYdoc ?? ownYdoc!;

  // PLAN.md §14g — hoisted mode's "sync once on mount" counterpart to the
  // "update" listener registered below: the shared Y.Doc already holds
  // every change applied while some *other* instance of this component (or
  // the write editor) was mounted against it, so a read → write → read
  // toggle remounts this component fresh with useEditor's `content` fixed
  // at whatever initialBodyJSON was at first page load. This corrects that
  // once `editor` itself exists — which useEditor doesn't guarantee is true
  // in the same tick as this component's other effects, so it can't be
  // folded into the connection effect below (which closes over editorRef,
  // not editor, and races ahead of useEditor's own construction on a fresh
  // mount with nothing like the token fetch's network delay to wait out).
  // The queueMicrotask indirection is only there to keep this out of the
  // "no setState synchronously in an effect body" lint rule's sights —
  // functionally it still runs before the next paint.
  useEffect(() => {
    if (!hoistedProvider || !editor) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const result = renderYdocDoc(ydoc);
      if (result.ok) {
        editor.commands.setContent(result.bodyJSON, { emitUpdate: false });
        reresolvePending(editor);
        syncDocLinks(editor);
      } else {
        setError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reresolvePending closes over pendingRef/userColor, not state that should retrigger this
  }, [editor, hoistedProvider, ydoc]);

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
      // Viewport-relative — see the onSelectionUpdate handler above.
      const coords = liveEditor.view.coordsAtPos(to);
      const next: PendingSelection = {
        from,
        to,
        quotedText: current.quotedText,
        top: coords.bottom,
        left: coords.left,
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

  // PLAN.md §14d/§14e — the single content-change choke point for doc-link
  // resolution: called synchronously right after every setContent, so no
  // paint lands between the content change and the position fix.
  // resolveDocLinks (via resolverRef) is memoized on (doc, docLinks)
  // identity, so calling this unconditionally on every content change is
  // cheap except on an actual doc/links change. Unanchored links are
  // dropped here, not inside the plugin — an unanchored link paints
  // nothing (§14d: it stays visible only in the group panel, added later).
  function syncDocLinks(liveEditor: Editor) {
    const resolved = resolverRef.current(liveEditor.state.doc, docLinks);
    const links: ResolvedDocLink[] = [];
    for (const link of docLinks) {
      const anchor = resolved.get(link.id);
      if (anchor?.anchored) {
        links.push({ id: link.id, groupId: link.groupId, from: anchor.from, to: anchor.to, color: link.color, mine: link.mine });
      }
    }
    setDocLinks(liveEditor.view, { links, activeGroupId });
  }

  // Re-pushes when the link set itself changes (a link created/edited/
  // deleted, or the active group changes) without necessarily a content
  // change — the effect above only fires from setContent call sites.
  useEffect(() => {
    if (editor) syncDocLinks(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncDocLinks closes over docLinks/activeGroupId, which are already this effect's real deps
  }, [editor, docLinks, activeGroupId]);

  // undefined (the prop's unset state) means "no scrub bar mounted yet" —
  // deliberately distinct from null (mounted, but at the live/latest
  // position) so this effect only ever fires once scrubbing has actually
  // produced a historical body to show.
  useEffect(() => {
    if (overrideBodyJSON && editor) {
      editor.commands.setContent(overrideBodyJSON, { emitUpdate: false });
      reresolvePending(editor);
      syncDocLinks(editor);
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

  // Same outside-click dismissal as the pending-selection popover above,
  // for the two click-routing surfaces (§14j).
  useEffect(() => {
    if (!editingLink && !chooser) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setEditingLink(null);
        setChooser(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [editingLink, chooser]);

  useEffect(() => {
    function applyUpdate() {
      const result = renderYdocDoc(ydoc);
      if (result.ok) {
        editorRef.current?.commands.setContent(result.bodyJSON, { emitUpdate: false });
        if (editorRef.current) {
          reresolvePending(editorRef.current);
          syncDocLinks(editorRef.current);
        }
      } else {
        setError(result.error);
      }
    }

    // Hoisted mode (PLAN.md §14g) — the caller (DocColumn) owns the Y.Doc
    // and provider's connection lifecycle across read/write toggles, so
    // this effect only wires (and, critically, un-wires) its own update
    // listener rather than destroying either. Registering `ydoc.on` and
    // relying on `ydoc.destroy()` to implicitly drop it — what the
    // owned-provider branch below does — would leak a listener here, since
    // in hoisted mode this component doesn't control when (or whether) the
    // doc is ever destroyed: a read → write → read cycle would otherwise
    // call setContent on an editor this instance already unmounted.
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
  }, [docId, ydoc, hoistedProvider]);

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
      {selectionUi === "doclink" && pending && editorRef.current && (
        <DocLinkPopover
          docId={docId}
          top={pending.top}
          left={pending.left}
          // Recomputed from the live doc rather than carried on
          // PendingSelection — before/after/blocks are only ever needed
          // here, at the moment of creation (§14i), and captureAnchor is
          // the single place that knows how to derive them.
          mark={captureAnchor(editorRef.current.state.doc, pending.from, pending.to)}
          userColor={userColor}
          activeGroupId={activeGroupId}
          onCreated={(link) => {
            setPending(null);
            if (editorRef.current) setPendingAnnotation(editorRef.current.view, null);
            onDocLinkCreated?.(link);
          }}
          onCancel={() => {
            setPending(null);
            if (editorRef.current) setPendingAnnotation(editorRef.current.view, null);
          }}
        />
      )}
      {editingLink && (
        <DocLinkPopover
          // Forces a remount when the click-routing target changes —
          // without this, React reuses the same instance across links (same
          // JSX position), and its text/overrideChecked/colorValue state
          // (only ever initialized once, from the initial* props) keeps
          // showing whichever link was being edited before instead of
          // resetting. Same bug, same fix, as DocLinkGroupPanel's `key`
          // (SideBySideView.tsx) — clicking a highlight while a different
          // link's popover is already open updated the quoted-text preview
          // (read straight from editingLink.link on every render) but left
          // the note and override checkbox/color frozen on the first link.
          key={editingLink.link.id}
          docId={docId}
          top={editingLink.top}
          left={editingLink.left}
          // Only ever reached from an anchored hit (§14j's handleClick
          // filters to l.anchored), so mark is never actually null here —
          // asserted rather than fabricated, since a fallback empty mark
          // would render a misleading blank "Editing link over: """.
          mark={editingLink.link.mark!}
          userColor={userColor}
          activeGroupId={activeGroupId}
          linkId={editingLink.link.id}
          initialText={editingLink.link.text}
          initialOverrideColor={editingLink.link.overrideColor}
          onUpdated={(patch) => {
            const updated = { ...editingLink.link, ...patch };
            setEditingLink(null);
            onDocLinkUpdated?.(updated);
          }}
          onDeleted={() => {
            const { id } = editingLink.link;
            setEditingLink(null);
            onDocLinkDeleted?.(id);
          }}
          onCancel={() => setEditingLink(null)}
          onColorPreview={(overrideColor) => onDocLinkColorPreview?.(editingLink.link.id, overrideColor)}
        />
      )}
      {chooser && (
        <DocLinkChooser
          top={chooser.top}
          left={chooser.left}
          candidates={chooser.candidates}
          onSelect={(link) => {
            const { pos, top, left } = chooser;
            setChooser(null);
            setEditingLink({ link, pos, top, left });
            onDocLinkClicked?.(link.groupId);
          }}
          onCancel={() => setChooser(null)}
        />
      )}
    </div>
  );
}
