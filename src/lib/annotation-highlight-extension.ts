import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { resolveAnchorInDoc, type AnchorRange } from "./anchors";
import { buildSegments } from "./decoration-segments";

// PLAN.md §13o — the inline highlight for a **column-anchored** annotation
// (one written from a reading view), and the live resolution behind it.
//
// A mark-anchored annotation needs none of this: the mark is content, so it
// renders itself and moves with its text for free (§12i). A stored offset
// moves with nothing, so this plugin re-resolves on every transaction and
// draws the result as a decoration — the same display-only layer
// quote-highlight-extension.ts gives a post comment, which is exactly the
// mechanism a reading-view annotation now shares with one.
//
// Why the ranges live in plugin state rather than being recomputed inside
// `decorations()`: two other things need the same answer (both margin-note
// rails, via annotation-marks.ts's resolveAnnotationRanges), and recomputing
// it per consumer would multiply the one genuinely expensive step below by
// however many of them there are.

export type AnnotationAnchorInput = {
  /** The root annotation's id — the same value a mark would carry. For a link part, the anchor row's id. */
  id: string;
  from: number;
  to: number;
  /** Derived server-side at post time; here it is what re-finds the range. */
  quotedText: string;
  /** Author color for an annotation; absent for a link part, whose paint is a class, not a per-author tint. */
  color?: string;
  // docs/ANCHORED_LINKS.md — an anchored-link part rides the same plugin
  // state and per-transaction resolve pass as an annotation range, so twenty
  // link ranges cost what twenty more annotations would (annotation-marks.ts's
  // "one pass for every id" rule). What differs is only presentation and
  // routing, which is what this field keys: the decoration class, and which
  // of the two range maps the id lands in.
  kind?: "annotation" | "link";
};

type TrackedAnchor = AnnotationAnchorInput & {
  /** Where it is *now*, or null once it has failed a full-document search. */
  resolved: AnchorRange | null;
};

export type AnnotationHighlightState = {
  anchors: TrackedAnchor[];
  /** Annotation ids only — the map every §13o consumer already reads. */
  ranges: Map<string, AnchorRange>;
  /** Anchored-link part row ids, kept apart so a rail card and a thread jump can't mistake one for the other. */
  linkRanges: Map<string, AnchorRange>;
};

export const annotationHighlightKey = new PluginKey<AnnotationHighlightState>("annotationHighlight");

/**
 * Replaces the anchor set — call whenever the server's annotation list
 * changes (a post, a delete, any `router.refresh()`). Also the *only* thing
 * that gives a detached anchor another chance to re-attach; see the note on
 * `apply` below for why that isn't attempted per keystroke.
 */
export function setAnnotationAnchors(view: EditorView, anchors: AnnotationAnchorInput[]): void {
  view.dispatch(view.state.tr.setMeta(annotationHighlightKey, anchors));
}

/** Where each column-anchored annotation currently sits, or an empty map on an editor without this plugin. */
export function getAnnotationAnchorRanges(state: EditorState): Map<string, AnchorRange> {
  return annotationHighlightKey.getState(state)?.ranges ?? new Map();
}

/** Where each anchored-link part currently sits (docs/ANCHORED_LINKS.md), keyed by anchor row id. */
export function getAnchoredLinkRanges(state: EditorState): Map<string, AnchorRange> {
  return annotationHighlightKey.getState(state)?.linkRanges ?? new Map();
}

/**
 * The column-anchored subset of a page's annotation entries, in the shape
 * this plugin tracks.
 *
 * Lives here, not beside `AnnotationEntry` in AnnotationList.tsx, because
 * both doc pages call it from a **server** component and that file is
 * `"use client"` — importing a function across that boundary fails at
 * runtime, not at build ("attempted to call … from the server"). The
 * parameter is structural for the same reason: `src/lib` doesn't import from
 * `src/components` (CLAUDE.md), and `AnnotationEntry` satisfies this shape
 * without either side naming the other.
 */
export function annotationAnchorInputs(
  entries: { threadId: string; quotedText: string; anchorFrom: number | null; anchorTo: number | null; color: string }[],
): AnnotationAnchorInput[] {
  return entries
    .filter((entry) => entry.anchorFrom !== null && entry.anchorTo !== null && entry.quotedText !== "")
    .map((entry) => ({
      id: entry.threadId,
      from: entry.anchorFrom!,
      to: entry.anchorTo!,
      quotedText: entry.quotedText,
      color: entry.color,
    }));
}

/**
 * An anchored link's DOC_RANGE parts in the shape this plugin tracks
 * (docs/ANCHORED_LINKS.md). Structural parameter for the same reason as
 * above — `AnchoredLinkPart` (anchored-link-data.ts) satisfies it without
 * this browser-safe file importing a Prisma-touching one. PDF_TEXT parts
 * (null offsets) fall out here; theirs is the anno-layer's job.
 */
export function anchoredLinkAnchorInputs(
  parts: { anchorId: string; from: number | null; to: number | null; quotedText: string }[],
): AnnotationAnchorInput[] {
  return parts
    .filter((part) => part.from !== null && part.to !== null && part.quotedText !== "")
    .map((part) => ({
      id: part.anchorId,
      from: part.from!,
      to: part.to!,
      quotedText: part.quotedText,
      kind: "link" as const,
    }));
}

// A full re-resolve, with no idea where anything was: the initial pass, and
// every explicit anchor push.
function resolveAll(anchors: AnnotationAnchorInput[], doc: PMNode): TrackedAnchor[] {
  return anchors.map((anchor) => ({ ...anchor, resolved: resolveAnchorInDoc(doc, anchor.from, anchor.to, anchor.quotedText) }));
}

// The per-transaction pass, which is where all the cost would be if it were
// written naively. Three tiers, and the ordering is the whole point:
//
//  1. **Map through the transaction.** An ordinary edit carries a mapping, so
//     the previous range moves for free — biased away from the range
//     (`map(from, 1)` / `map(to, -1)`, the same convention anchor-remap.ts
//     uses) so text typed against a boundary isn't pulled into a quote that
//     is supposed to be stable. Verified against quotedText, since a mapping
//     says where the positions went, not whether the words survived.
//  2. **Search near where it was.** The reading views push remote updates in
//     with `setContent`, which replaces the document wholesale and makes the
//     mapping meaningless (COLLAB.md §4's trap). But the text has usually
//     barely moved, so the window is sized by how much the document's own
//     size changed — a keystroke elsewhere gives a window of a few dozen
//     positions instead of a scan of the whole document.
//  3. **A full scan**, once, and if that fails the anchor is left detached
//     and *not* retried on later transactions. Retrying would mean an
//     O(document × quote) scan per keystroke, forever, for an annotation
//     whose text is genuinely gone — the exact cost tier 2 exists to avoid,
//     reintroduced by the case least likely to repay it. Detachment is
//     re-evaluated on the next anchor push instead, which is the doc-side
//     equivalent of the post side re-testing a DETACHED thread at the next
//     publish rather than continuously (COLLAB.md §1).
function reresolve(anchors: TrackedAnchor[], tr: Transaction, oldSize: number, newDoc: PMNode): TrackedAnchor[] {
  const radius = Math.abs(newDoc.content.size - oldSize) + NEARBY_PAD;
  return anchors.map((anchor) => {
    if (!anchor.resolved) return anchor;
    const from = tr.mapping.map(anchor.resolved.from, 1);
    const to = tr.mapping.map(anchor.resolved.to, -1);
    if (to > from && to <= newDoc.content.size && newDoc.textBetween(from, to, " ") === anchor.quotedText) {
      return { ...anchor, resolved: { from, to } };
    }
    return {
      ...anchor,
      resolved: resolveAnchorInDoc(newDoc, from, to, anchor.quotedText, { pos: anchor.resolved.from, radius }),
    };
  });
}

/** Slack around the size-delta window, so a same-length edit still has somewhere to look. */
const NEARBY_PAD = 64;

function rangeMaps(anchors: TrackedAnchor[]): Pick<AnnotationHighlightState, "ranges" | "linkRanges"> {
  const ranges = new Map<string, AnchorRange>();
  const linkRanges = new Map<string, AnchorRange>();
  for (const anchor of anchors) {
    if (!anchor.resolved) continue;
    (anchor.kind === "link" ? linkRanges : ranges).set(anchor.id, anchor.resolved);
  }
  return { ranges, linkRanges };
}

export const AnnotationHighlight = Extension.create<{ anchors: AnnotationAnchorInput[] }>({
  name: "annotationHighlight",

  addOptions() {
    return { anchors: [] };
  },

  addProseMirrorPlugins() {
    const initial = this.options.anchors;

    return [
      new Plugin<AnnotationHighlightState>({
        key: annotationHighlightKey,
        state: {
          init: (_config, state) => {
            const anchors = resolveAll(initial, state.doc);
            return { anchors, ...rangeMaps(anchors) };
          },
          apply(tr, value, oldState, newState) {
            const meta = tr.getMeta(annotationHighlightKey) as AnnotationAnchorInput[] | undefined;
            if (meta !== undefined) {
              const anchors = resolveAll(meta, newState.doc);
              return { anchors, ...rangeMaps(anchors) };
            }
            if (!tr.docChanged) return value;
            const anchors = reresolve(value.anchors, tr, oldState.doc.content.size, newState.doc);
            return { anchors, ...rangeMaps(anchors) };
          },
        },
        props: {
          decorations(state) {
            const current = annotationHighlightKey.getState(state);
            if (!current || current.anchors.length === 0) return null;

            // Pre-split rather than one decoration per anchor: overlapping
            // inline decorations silently drop each other's data-* attributes
            // (decoration-segments.ts). The mark path gets overlap for free
            // from `excludes: ""` and needs no such handling — which is why
            // the attribute here is plural (`data-annotation-ids`) where the
            // mark's is singular, the same split quote-highlight-extension.ts
            // already has against it.
            //
            // Both kinds go through **one** buildSegments pass rather than one
            // per kind, for the same reason: an annotation range overlapping a
            // link range is two decorations fighting over one span, so it
            // has to become one segment carrying both classes — a background
            // wash *and* an outline compose; two overlapping inline
            // decorations don't.
            const decorations = buildSegments(
              current.anchors
                .filter((a) => a.resolved)
                .map((a) => ({
                  id: a.id,
                  from: a.resolved!.from,
                  to: a.resolved!.to,
                  color: a.kind === "link" ? null : (a.color ?? null),
                  kind: a.kind ?? ("annotation" as const),
                })),
              state.doc.content.size,
            ).map((segment) => {
              const annotationSources = segment.sources.filter((s) => s.kind !== "link");
              const linkSources = segment.sources.filter((s) => s.kind === "link");
              const annotationColors = new Set(annotationSources.map((s) => s.color));
              return Decoration.inline(segment.from, segment.to, {
                class: [
                  annotationSources.length > 0 ? "annotation-highlight" : null,
                  linkSources.length > 0 ? "anchored-link-highlight" : null,
                ]
                  .filter(Boolean)
                  .join(" "),
                ...(annotationSources.length > 0
                  ? { "data-annotation-ids": annotationSources.map((s) => s.id).join(" ") }
                  : {}),
                ...(linkSources.length > 0
                  ? { "data-anchored-link-ids": linkSources.map((s) => s.id).join(" ") }
                  : {}),
                // Null exactly when annotations by different authors overlap
                // here: one span, one background, so it goes to the neutral
                // fallback rather than arbitrarily picking an author. Link
                // sources are excluded from the vote — their paint is the
                // class, not a tint — so a link part over one author's
                // annotation doesn't gray it out.
                ...(annotationSources.length > 0 && annotationColors.size === 1 && annotationSources[0].color
                  ? { style: `--thread-color:${annotationSources[0].color}` }
                  : {}),
              });
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
