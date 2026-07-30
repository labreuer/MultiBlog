import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { buildSegments } from "./decoration-segments";
import { SAFE_COLOR } from "./safe-css";

// PLAN.md §14e — a resolved (anchored, on-screen) doc link: positions
// already computed against the *current* document by the caller
// (doc-link-anchor.ts's resolveAnchor/createDocLinkResolver), not by this
// plugin. An unanchored link — resolveAnchor returned `{ anchored: false }`
// — never becomes one of these; it stays visible in the group panel (§14h)
// but paints nothing here.
export type ResolvedDocLink = {
  id: string;
  groupId: string;
  from: number;
  to: number;
  color: string;
  mine: boolean;
};

export type DocLinkPluginState = {
  links: ResolvedDocLink[];
  activeGroupId: string | null;
};

export const docLinkKey = new PluginKey<DocLinkPluginState>("docLink");

const EMPTY_STATE: DocLinkPluginState = { links: [], activeGroupId: null };

// Link data enters through this meta-tagged transaction, not addOptions —
// see the extension's own header comment for why (quote-highlight's bake-
// at-construction approach is wrong for something that changes as often as
// a doc link does).
export function setDocLinks(view: EditorView, next: DocLinkPluginState): void {
  view.dispatch(view.state.tr.setMeta(docLinkKey, next));
}

export type DocLinkOptions = {
  // PLAN.md §14j — fired with every anchored link covering the clicked
  // position (never zero; handleClick returns false and never calls this
  // when there are none). Configured once with a stable indirection
  // (`(hits, pos) => onHitRef.current(hits, pos)`) exactly like
  // QuoteHighlight's onIndicatorClick would need to be, but isn't, because
  // that one never changes after mount — this one has to see the *current*
  // activeGroupId and docId, which do.
  onHit: (hits: ResolvedDocLink[], pos: number) => void;
  // Whether this editor instance is a write surface. A click inside a
  // highlight is also a click placing the caret; read mode (editable:
  // false) can safely swallow it (return true), but write mode must not —
  // returning true there would eat every click into linked text. No
  // surface in this build sets this true (write-column highlighting was
  // never added, §14m-adjacent — see PLAN.md §14 "As built"), but the
  // option exists so the plugin is correct if one is.
  editable: boolean;
};

// PLAN.md §14e — the decoration layer over already-resolved doc-link
// ranges. Built on pending-annotation-extension.ts's meta-tagged-
// transaction skeleton rather than quote-highlight-extension.ts's baked-in-
// at-construction options: a doc link's set changes continuously as the
// user works, and recreating the editor (the useEditor dep-array trick
// quote-highlight relies on) would tear down the write column's
// Collaboration binding.
//
// Resolving stored anchors against the current document (findQuoteOccurrences,
// the drift policy in doc-link-anchor.ts) happens OUTSIDE this plugin, at the
// single content-change choke point in the caller (LiveDocBody's setContent
// handler) — decorations() below runs on every view update including bare
// cursor moves, so an O(n·m) re-find inside it would be a per-keystroke path.
// This plugin only ever draws from `links`, which already carry positions.
export const DocLink = Extension.create<DocLinkOptions>({
  name: "docLink",

  addOptions() {
    return { onHit: () => {}, editable: false };
  },

  addProseMirrorPlugins() {
    const { onHit, editable } = this.options;

    return [
      new Plugin<DocLinkPluginState>({
        key: docLinkKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, value) {
            const meta = tr.getMeta(docLinkKey) as DocLinkPluginState | undefined;
            if (meta) return meta;
            if (!tr.docChanged) return value;
            // The write column's ordinary transactions map through here
            // (bias -1 on `from`, +1 on `to`, as PendingAnnotation does) —
            // a rough, best-effort tracking of an in-progress edit between
            // the debounced re-resolves that actually persist a correction
            // (§14d/§14e). A range that collapses is dropped rather than
            // kept at a zero-width point.
            const links = value.links
              .map((link) => ({
                ...link,
                from: tr.mapping.map(link.from, -1),
                to: tr.mapping.map(link.to, 1),
              }))
              .filter((link) => link.to > link.from);
            return { ...value, links };
          },
        },
        props: {
          decorations(state) {
            const { links, activeGroupId } = docLinkKey.getState(state) ?? EMPTY_STATE;
            const docSize = state.doc.content.size;
            const decorations: Decoration[] = [];

            const segments = buildSegments(
              links.map((link) => ({ ...link, color: SAFE_COLOR.test(link.color) ? link.color : null })),
              docSize,
            );

            for (const segment of segments) {
              const groupIds = Array.from(new Set(segment.sources.map((s) => s.groupId)));
              const active = activeGroupId !== null && groupIds.includes(activeGroupId);
              decorations.push(
                Decoration.inline(segment.from, segment.to, {
                  class: active ? "doc-link-highlight doc-link-active" : "doc-link-highlight",
                  "data-doc-link-ids": segment.ids.join(" "),
                  "data-doc-link-group-ids": groupIds.join(" "),
                  ...(segment.color ? { style: `--doc-link-color:${segment.color}` } : {}),
                }),
              );
            }

            return DecorationSet.create(state.doc, decorations);
          },
          // PLAN.md §14j — routed over resolved plugin-state positions,
          // never DOM data-* attributes, so the logic and the paint can't
          // disagree. Only fires when mousedown/mouseup land together, so
          // a drag-select ending inside a highlight correctly falls through
          // to onSelectionUpdate (the create-a-new-link path) instead.
          handleClick(view, pos) {
            const { links } = docLinkKey.getState(view.state) ?? EMPTY_STATE;
            const hits = links.filter((l) => pos >= l.from && pos < l.to);
            if (hits.length === 0) return false;
            onHit(hits, pos);
            return !editable;
          },
        },
      }),
    ];
  },
});
