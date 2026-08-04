"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import { DocLink, setDocLinks, type ResolvedDocLink } from "@/lib/doc-link-extension";
import { createDocLinkResolver, captureAnchor, type DocLinkInput } from "@/lib/doc-link-anchor";
import { useLiveDocContent } from "@/lib/use-live-doc-content";
import { useSelectionPopover } from "@/lib/use-selection-popover";
import { useDocPresence } from "@/components/annotation/doc-presence-context";
import DocLinkPopover from "./DocLinkPopover";
import DocLinkChooser from "./DocLinkChooser";
import proseStyles from "@/styles/prose.module.css";

type Props = {
  docId: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
  userColor: string;
  // See CollabEditorBody's identical prop — PLAN.md §14f. Required here, not
  // defaulted: this page has two of these, and telling them apart is the whole
  // reason the prop exists.
  ariaLabel: string;
  // PLAN.md §14g — hoisted mode, always. DocColumn owns the Y.Doc and provider
  // so that toggling this column to write mode doesn't tear down the
  // websocket; unlike /doc/[slug]'s surface, this one never owns its own.
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  // PLAN.md §14e — doc links anchored to *this* doc, already carrying their
  // cascaded color; resolved against the current document (and re-resolved on
  // every content change) rather than trusted at whatever positions were
  // captured at creation time.
  docLinks: DocLinkInput[];
  // Which group's links should paint darker (§14h) — null means none. Also
  // what a newly created link (via DocLinkPopover, §14i) joins, when set.
  activeGroupId: string | null;
  // Fired once DocLinkPopover successfully saves a new link — the caller
  // (DocColumn) appends it to its own docLinks state so the new highlight
  // appears immediately, without a page reload (doc links have no live
  // propagation channel, §14a).
  onDocLinkCreated?: (link: DocLinkInput) => void;
  // PLAN.md §14j — fired when an existing link's edit popover saves or is
  // deleted, so the caller can update/remove it from the same docLinks state
  // onDocLinkCreated appends to.
  onDocLinkUpdated?: (link: DocLinkInput) => void;
  onDocLinkDeleted?: (linkId: string) => void;
  // Fired live as the edit popover's color checkbox/swatch changes, before
  // Save — lets the highlight repaint immediately without waiting on
  // updateDocLink's round trip. Only meaningful in edit mode (a link already
  // exists to repaint); the create-mode popover has nothing to preview against.
  onDocLinkColorPreview?: (linkId: string, overrideColor: string | null) => void;
  // Fired whenever a click opens a link's edit popover (directly, or via the
  // chooser) — lets the caller (SideBySideView) switch the active group to
  // match, the same "make this the active group" action the bar's dropdown
  // triggers.
  onDocLinkClicked?: (groupId: string) => void;
};

// One read-mode column of /side-by-side (PLAN.md §14f/§14i/§14j): live doc
// content, where selecting text offers to create a *doc link* rather than an
// annotation, and clicking existing linked text edits it.
//
// A sibling of DocReadingBody, not a mode of it (§14p). The two share
// everything genuinely identical — the live tap (useLiveDocContent) and the
// selection gesture (useSelectionPopover) — and nothing else, so neither
// carries a flag describing which one it is.
export default function SideBySideDocBody({
  docId,
  initialBodyJSON,
  staticBody,
  userColor,
  ariaLabel,
  ydoc,
  provider,
  docLinks,
  activeGroupId,
  onDocLinkCreated,
  onDocLinkUpdated,
  onDocLinkDeleted,
  onDocLinkColorPreview,
  onDocLinkClicked,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { setAwareness } = useDocPresence();

  // PLAN.md §14j — click-routing state: at most one of these is non-null at a
  // time. editingLink opens the same DocLinkPopover the selection flow uses,
  // but in edit mode (a linkId is present); chooser appears when a click hit
  // more than one candidate.
  const [editingLink, setEditingLink] = useState<{ link: DocLinkInput; pos: number } | null>(null);
  const [chooser, setChooser] = useState<{ candidates: DocLinkInput[]; pos: number } | null>(null);

  // One resolver instance per component instance (i.e., per docId — the whole
  // component remounts on docId change), not per render or shared page-wide:
  // doc-link-anchor.ts's memoization is keyed on (doc identity, links
  // identity), and a shared resolver across two columns would thrash between
  // two unrelated docs' doc/links pairs, defeating the cache.
  const resolverRef = useRef(createDocLinkResolver());

  // PLAN.md §14j — a stable indirection into DocLink.configure({onHit}),
  // refreshed every render so it always sees the current docLinks/
  // activeGroupId/editor without forcing the editor's extensions array (fixed
  // at construction) to be recreated.
  const onHitRef = useRef<(hits: ResolvedDocLink[], pos: number) => void>(() => {});
  // Declared here so both hooks below can take it as an input — see
  // useLiveDocContent's note on why it owns neither end of that.
  const editorRef = useRef<Editor | null>(null);

  // PLAN.md §14d/§14e — the single content-change choke point for doc-link
  // resolution, called synchronously right after every setContent so no paint
  // lands between the content change and the position fix. resolveDocLinks
  // (via resolverRef) is memoized on (doc, docLinks) identity, so calling it
  // unconditionally on every content change is cheap except on an actual
  // doc/links change. Unanchored links are dropped here, not inside the plugin
  // — an unanchored link paints nothing (§14d).
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

  const selection = useSelectionPopover({
    editorRef,
    containerRef,
    userColor,
    // The click-routing popovers are anchored to an existing link, not to a
    // live selection, but share the one placement slot — at most one popover
    // is open at a time.
    externalAnchorPos: editingLink?.pos ?? chooser?.pos ?? null,
    // Selecting a group opens the group panel above the columns, which shifts
    // this column down under an already-open popover.
    reflowKey: activeGroupId,
  });

  const { editor, ready, synced, error } = useLiveDocContent({
    docId,
    initialBodyJSON,
    ariaLabel,
    ydoc,
    provider,
    editorRef,
    setAwareness,
    // DocLink (§14e) is a decoration layer, no schema change — see the hook's
    // note on why that matters.
    // eslint-disable-next-line react-hooks/refs -- onHit is invoked by ProseMirror on a click, never during render; reaching the current handler through a ref is what lets the extensions array (read once, at construction) stay stable across renders (§14e/§14j)
    extensions: [DocLink.configure({ onHit: (hits, pos) => onHitRef.current(hits, pos), editable: false })],
    onEditorCreated: syncDocLinks,
    onSelectionUpdate: selection.capture,
    onContentPushed: (liveEditor) => {
      selection.reresolve(liveEditor);
      syncDocLinks(liveEditor);
    },
  });

  // PLAN.md §14j — routing: narrow to the active group first when it covers
  // any of the hits; otherwise (or with no active group) every hit is a
  // candidate. One candidate opens its edit popover directly; several open the
  // chooser. Refreshed every render so it always closes over the current
  // docLinks/activeGroupId.
  useEffect(() => {
    onHitRef.current = (hits, pos) => {
      const liveEditor = editorRef.current;
      if (!liveEditor || !containerRef.current) return;

      let narrowed = hits;
      if (activeGroupId) {
        const inGroup = hits.filter((h) => h.groupId === activeGroupId);
        if (inGroup.length > 0) narrowed = inGroup;
      }
      const candidates = narrowed.map((h) => docLinks.find((l) => l.id === h.id)).filter((l): l is DocLinkInput => Boolean(l));
      if (candidates.length === 0) return;

      selection.openAt(liveEditor, pos);
      if (candidates.length === 1) {
        setEditingLink({ link: candidates[0], pos });
        setChooser(null);
        onDocLinkClicked?.(candidates[0].groupId);
      } else {
        setChooser({ candidates, pos });
        setEditingLink(null);
      }
    };
  });

  // Re-pushes when the link set itself changes (a link created/edited/deleted,
  // or the active group changes) without necessarily a content change — the
  // choke point above only fires from setContent call sites.
  useEffect(() => {
    if (editor) syncDocLinks(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- syncDocLinks closes over docLinks/activeGroupId, which are already this effect's real deps
  }, [editor, docLinks, activeGroupId]);

  // Same outside-click dismissal useSelectionPopover applies to the pending
  // selection, for the two click-routing surfaces (§14j).
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

  if (error) {
    return <p style={{ color: "crimson" }}>{error}</p>;
  }

  const { pending, placement, popoverRef } = selection;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {synced && <span data-testid="live-doc-synced" style={{ display: "none" }} />}
      <div style={{ display: ready ? "none" : "block" }}>{staticBody}</div>
      {/* .noAnnotations paints over .annotation-highlight without touching the
          schema — the mark stays registered and synced regardless. See §14f
          for why dropping the mark type instead would be destructive. */}
      <div
        className={`${proseStyles.prose} ${proseStyles.noAnnotations}`}
        style={{ display: ready ? "block" : "none" }}
      >
        <EditorContent editor={editor} />
      </div>
      {pending && placement && editor && (
        <DocLinkPopover
          elementRef={popoverRef}
          docId={docId}
          top={placement.top}
          left={placement.left}
          // Recomputed from the live doc rather than carried on the pending
          // selection — before/after/blocks are only ever needed here, at the
          // moment of creation (§14i), and captureAnchor is the single place
          // that knows how to derive them.
          mark={captureAnchor(editor.state.doc, pending.from, pending.to)}
          userColor={userColor}
          activeGroupId={activeGroupId}
          onCreated={(link) => {
            selection.clear();
            onDocLinkCreated?.(link);
          }}
          onCancel={() => selection.clear()}
        />
      )}
      {editingLink && placement && (
        <DocLinkPopover
          elementRef={popoverRef}
          // Forces a remount when the click-routing target changes — without
          // this, React reuses the same instance across links (same JSX
          // position), and its text/overrideChecked/colorValue state (only ever
          // initialized once, from the initial* props) keeps showing whichever
          // link was being edited before instead of resetting. Same bug, same
          // fix, as DocLinkGroupPanel's `key` (SideBySideView.tsx).
          key={editingLink.link.id}
          docId={docId}
          top={placement.top}
          left={placement.left}
          // Only ever reached from an anchored hit (§14j's handleClick filters
          // to anchored links), so mark is never actually null here — asserted
          // rather than fabricated, since a fallback empty mark would render a
          // misleading blank "Editing link over: """.
          mark={editingLink.link.mark!}
          userColor={userColor}
          activeGroupId={activeGroupId}
          linkId={editingLink.link.id}
          initialText={editingLink.link.text}
          initialOverrideColor={editingLink.link.overrideColor}
          // Syncs app state only — does not close the popover. It fires from
          // every autosave (every debounced edit, not just an explicit Save
          // click, per PLAN.md §14i), so closing here would dismiss the
          // popover out from under a still-editing user 600ms after their
          // last keystroke. The explicit Save button closes itself instead
          // (its own onSaved below), the same way Cancel already does.
          onUpdated={(patch) => {
            const updated = { ...editingLink.link, ...patch };
            onDocLinkUpdated?.(updated);
          }}
          onSaved={() => setEditingLink(null)}
          onDeleted={() => {
            const { id } = editingLink.link;
            setEditingLink(null);
            onDocLinkDeleted?.(id);
          }}
          onCancel={() => setEditingLink(null)}
          onColorPreview={(overrideColor) => onDocLinkColorPreview?.(editingLink.link.id, overrideColor)}
        />
      )}
      {chooser && placement && (
        <DocLinkChooser
          elementRef={popoverRef}
          top={placement.top}
          left={placement.left}
          candidates={chooser.candidates}
          onSelect={(link) => {
            const { pos } = chooser;
            setChooser(null);
            setEditingLink({ link, pos });
            onDocLinkClicked?.(link.groupId);
          }}
          onCancel={() => setChooser(null)}
        />
      )}
    </div>
  );
}
