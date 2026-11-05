import { Node, mergeAttributes } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { chipKind } from "./registry";
import { chipRenderings, chipsIn, UNKNOWN_CHIP } from "./renderings";
import {
  CHIP_ANCHOR_TEXT,
  ENTITY_CHIP,
  type ChipAttrs,
  type ChipContext,
  type ChipRendering,
  type ChipStyles,
} from "./types";

// docs/ENTITY_CHIPS.md, step 1 — the one node every chip kind is stored as.
// It holds identity and nothing else: the chip kind, an instance id, and the
// kind's own fields. What it shows is computed (renderings.ts) and reaches a
// live editor as node decorations, so a rename, a restyle or a renumbering
// changes labels without changing the document.
//
// One definition for every user of the schema. The node view and the plugins
// only ever run inside an editor, so the servers that decode a ydoc with this
// in their extension list build neither.

/** What a surface's renderings are computed from, beside the document itself. */
export type ChipInputs = { styles: ChipStyles; context: ChipContext };

const NO_INPUTS: ChipInputs = { styles: {}, context: {} };

type ChipPluginState = { inputs: ChipInputs; decorations: DecorationSet; byIid: Map<string, ChipRendering> };

export const entityChipKey = new PluginKey<ChipPluginState>("entityChip");

/** Gives a live editor new styles or a new context; every chip's label is recomputed. */
export function setChipInputs(view: EditorView, inputs: ChipInputs): void {
  view.dispatch(view.state.tr.setMeta(entityChipKey, inputs));
}

/** The rendering a live editor currently shows for the chip with this instance id. */
export function chipRenderingIn(state: EditorState, iid: string): ChipRendering | null {
  return entityChipKey.getState(state)?.byIid.get(iid) ?? null;
}

// A rendering rides to its node view as a node decoration's spec. Flat
// fields, because ProseMirror compares two decorations' specs one level deep
// to decide whether a node view needs its `update` called: a chip whose
// rendering didn't change is left alone, and one that did is redrawn even
// when the transaction never touched its paragraph (a renumbering).
type ChipDecorationSpec = { chipLabel: string; chipHref: string | null; chipStatus: ChipRendering["status"] };

function compute(doc: PMNode, inputs: ChipInputs): Pick<ChipPluginState, "decorations" | "byIid"> {
  const chips = chipsIn(doc);
  const renderings = chipRenderings(chips, inputs.styles, inputs.context);
  const byIid = new Map<string, ChipRendering>();
  const decorations = chips.map((chip, index) => {
    const rendering = renderings[index];
    if (!byIid.has(chip.iid)) byIid.set(chip.iid, rendering);
    const spec: ChipDecorationSpec = {
      chipLabel: rendering.label,
      chipHref: rendering.href,
      chipStatus: rendering.status,
    };
    return Decoration.node(chip.pos, chip.pos + 1, {}, spec);
  });
  return { decorations: DecorationSet.create(doc, decorations), byIid };
}

function renderingFrom(decorations: readonly Decoration[]): ChipRendering | null {
  for (const decoration of decorations) {
    const spec = decoration.spec as Partial<ChipDecorationSpec>;
    if (typeof spec.chipLabel === "string") {
      // A live editor is a doc's own view and never needs the post's link.
      return { label: spec.chipLabel, href: spec.chipHref ?? null, postHref: null, status: spec.chipStatus ?? "unknown" };
    }
  }
  return null;
}

/** A fresh instance id. Random, since it only has to be unique within one doc. */
export function newChipIid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

// Bounds what a chip of a kind this build doesn't know may carry in from a
// paste. A known kind's validator is the real check; this only keeps an
// unknown one from being a way to store a document's worth of anything.
const MAX_UNKNOWN_DATA_LENGTH = 4096;

/**
 * A chip's attributes as every way in stores them, or null when they are not
 * a chip: a known kind's fields go through its validator, and an unknown
 * kind's are kept as they are, so a build that predates a chip kind never
 * rewrites that kind's chips.
 */
export function conformChipAttrs(attrs: { kind: unknown; iid: unknown; data: unknown }): ChipAttrs | null {
  if (typeof attrs.kind !== "string" || attrs.kind === "" || attrs.kind.length > 64) return null;
  const iid = typeof attrs.iid === "string" && attrs.iid.length <= 64 ? attrs.iid : "";
  const kind = chipKind(attrs.kind);
  if (kind) {
    const data = kind.validate(attrs.data);
    return data === null ? null : { kind: attrs.kind, iid, data: data as Record<string, unknown> };
  }
  if (typeof attrs.data !== "object" || attrs.data === null || Array.isArray(attrs.data)) return null;
  if (JSON.stringify(attrs.data).length > MAX_UNKNOWN_DATA_LENGTH) return null;
  return { kind: attrs.kind, iid, data: attrs.data as Record<string, unknown> };
}

function attrsFromElement(element: HTMLElement): ChipAttrs | null {
  let data: unknown;
  try {
    data = JSON.parse(element.getAttribute("data-chip") ?? "{}");
  } catch {
    return null;
  }
  return conformChipAttrs({
    kind: element.getAttribute("data-entity-chip"),
    iid: element.getAttribute("data-iid"),
    data,
  });
}

/** Whether a transaction's steps put a chip into the document. Cheap, and false for ordinary typing. */
function insertsChip(tr: Transaction): boolean {
  return tr.steps.some((step) => {
    const slice = (step as { slice?: { content: PMNode["content"] } }).slice;
    if (!slice) return false;
    let found = false;
    slice.content.descendants((node) => {
      if (node.type.name === ENTITY_CHIP) found = true;
      return !found;
    });
    return found;
  });
}

/**
 * Whether a transaction puts a chip in or takes one out: the only document
 * changes that can alter a rendering, since a chip's label reads nothing of
 * the text around it. False for ordinary typing, at the cost of looking at
 * the few positions each step replaced.
 */
function touchesChip(tr: Transaction): boolean {
  if (insertsChip(tr)) return true;
  return tr.steps.some((step, index) => {
    let found = false;
    step.getMap().forEach((oldStart, oldEnd) => {
      if (found || oldEnd <= oldStart) return;
      tr.docs[index].nodesBetween(oldStart, oldEnd, (node) => {
        if (node.type.name === ENTITY_CHIP) found = true;
        return !found;
      });
    });
    return found;
  });
}

/** The ranges `transactions` inserted, in the positions of the document they end at. */
function insertedRanges(transactions: readonly Transaction[]): [number, number][] {
  const ranges: [number, number][] = [];
  transactions.forEach((tr, t) => {
    tr.steps.forEach((step, s) => {
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        let from = tr.mapping.slice(s + 1).map(newStart, 1);
        let to = tr.mapping.slice(s + 1).map(newEnd, -1);
        for (const later of transactions.slice(t + 1)) {
          from = later.mapping.map(from, 1);
          to = later.mapping.map(to, -1);
        }
        if (to > from) ranges.push([from, to]);
      });
    });
  });
  return ranges;
}

/**
 * The instance-id repair (docs/ENTITY_CHIPS.md, step 1, item 3), as the
 * transaction to append, or null when there is nothing to repair.
 *
 * A chip put in with no instance id gets one. A chip put in with an id the
 * document already holds, a pasted copy, gets a fresh one, and the chip that
 * was there keeps its own, since stored anchors name it. Cut and paste
 * removes the original first, so the pasted chip collides with nothing and
 * keeps its id; so does a chip an undo restores.
 *
 * Only for this client's own insertions. A remote change is the other
 * client's to repair, and two clients repairing one chip would each write a
 * different id.
 */
export function repairChipIids(transactions: readonly Transaction[], newState: EditorState): Transaction | null {
  const local = transactions.filter((tr) => tr.docChanged && !isChangeOrigin(tr));
  if (!local.some(insertsChip)) return null;

  const inserted = insertedRanges(local);
  const isInserted = (pos: number) => inserted.some(([from, to]) => pos >= from && pos < to);

  const byIid = new Map<string, number[]>();
  newState.doc.descendants((node, pos) => {
    if (node.type.name !== ENTITY_CHIP) return !node.isLeaf;
    const iid = String(node.attrs.iid ?? "");
    const positions = byIid.get(iid);
    if (positions) positions.push(pos);
    else byIid.set(iid, [pos]);
    return false;
  });

  let tr: Transaction | null = null;
  for (const [iid, positions] of byIid) {
    if (iid !== "" && positions.length === 1) continue;
    // The one that keeps the id: a chip that was already there, else the first.
    const keeper = iid === "" ? -1 : (positions.find((pos) => !isInserted(pos)) ?? positions[0]);
    for (const pos of positions) {
      if (pos === keeper) continue;
      let fresh = newChipIid();
      while (byIid.has(fresh)) fresh = newChipIid();
      tr = (tr ?? newState.tr).setNodeAttribute(pos, "iid", fresh);
    }
  }
  return tr;
}

/**
 * The plugin behind a live editor's chips: their renderings as node
 * decorations, recomputed when the inputs change or a chip comes or goes, and
 * the instance-id repair.
 */
export function entityChipPlugin(initial: ChipInputs): Plugin<ChipPluginState> {
  return new Plugin<ChipPluginState>({
    key: entityChipKey,
    state: {
      init: (_config, state) => ({ inputs: initial, ...compute(state.doc, initial) }),
      apply(tr, previous) {
        const inputs = (tr.getMeta(entityChipKey) as ChipInputs | undefined) ?? previous.inputs;
        if (inputs === previous.inputs) {
          if (!tr.docChanged) return previous;
          // Typing beside chips changes no rendering, so the set is mapped
          // rather than rebuilt. A rebuilt set is a new object all the way
          // down, and ProseMirror then compares every block's decorations on
          // every keystroke; a mapped one shares what the edit didn't reach.
          if (!touchesChip(tr)) {
            return { ...previous, decorations: previous.decorations.map(tr.mapping, tr.doc) };
          }
        }
        return { inputs, ...compute(tr.doc, inputs) };
      },
    },
    props: {
      decorations: (state) => entityChipKey.getState(state)?.decorations,
    },
    appendTransaction: (transactions, _oldState, newState) => repairChipIids(transactions, newState),
  });
}

export const EntityChip = Node.create({
  name: ENTITY_CHIP,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      /** The styles and context a surface already has when its editor is built, so its first paint shows labels. */
      inputs: NO_INPUTS as ChipInputs,
    };
  },

  // The three attributes never change (docs/ENTITY_CHIPS.md, rule 6): a new
  // chip kind, or a new field on one, lives in `data` and changes no schema.
  // Each has a default so that no chip can fail to build for a missing one.
  addAttributes() {
    return {
      kind: {
        default: "",
        parseHTML: (element) => attrsFromElement(element)?.kind ?? "",
        renderHTML: (attributes) => ({ "data-entity-chip": attributes.kind }),
      },
      iid: {
        default: "",
        parseHTML: (element) => attrsFromElement(element)?.iid ?? "",
        renderHTML: (attributes) => ({ "data-iid": attributes.iid }),
      },
      data: {
        default: {},
        parseHTML: (element) => attrsFromElement(element)?.data ?? {},
        renderHTML: (attributes) => ({ "data-chip": JSON.stringify(attributes.data ?? {}) }),
      },
    };
  },

  // Above Link's `a[href]`: a reading view draws a live chip as a link, and
  // copied from there it must come back a chip. The label inside the element
  // is never read: a chip's attributes are its identity, and its text is
  // computed.
  parseHTML() {
    return [
      {
        tag: "[data-entity-chip]",
        priority: 1000,
        getAttrs: (element) => (attrsFromElement(element) ? null : false),
      },
    ];
  },

  // The label is included for whatever reads the HTML as text: the clipboard's
  // HTML flavour, pasted somewhere that knows nothing of chips.
  renderHTML({ node, HTMLAttributes }) {
    const label = this.editor ? (chipRenderingIn(this.editor.state, node.attrs.iid)?.label ?? "") : "";
    return ["span", mergeAttributes(HTMLAttributes, { class: "entity-chip" }), label];
  },

  // TipTap's text serializer, behind `editor.getText()` and the clipboard's
  // plain-text flavour: the label, since this is text for a person.
  renderText({ node }) {
    return this.editor ? (chipRenderingIn(this.editor.state, node.attrs.iid)?.label ?? "") : "";
  },

  // ProseMirror's `leafText`, behind `textBetween` and so behind every stored
  // quote: the anchor text, never the label. Set here because TipTap's
  // `renderText` above becomes the spec's `toText`, which `textBetween` never
  // reads.
  extendNodeSchema(extension) {
    return extension.name === ENTITY_CHIP ? { leafText: () => CHIP_ANCHOR_TEXT } : {};
  },

  addNodeView() {
    return ({ node, decorations }) => {
      const dom = document.createElement("span");
      dom.className = "entity-chip";
      dom.contentEditable = "false";
      dom.dataset.entityChip = node.attrs.kind;
      dom.dataset.iid = node.attrs.iid;
      const draw = (current: readonly Decoration[]) => {
        const rendering = renderingFrom(current) ?? UNKNOWN_CHIP;
        if (dom.textContent !== rendering.label) dom.textContent = rendering.label;
        dom.dataset.status = rendering.status;
        if (rendering.href) dom.dataset.href = rendering.href;
        else delete dom.dataset.href;
      };
      draw(decorations);
      return {
        dom,
        update(updated, current) {
          if (updated.type.name !== ENTITY_CHIP) return false;
          dom.dataset.entityChip = updated.attrs.kind;
          dom.dataset.iid = updated.attrs.iid;
          draw(current);
          return true;
        },
        // The label is ours to draw; nothing typed can land inside it.
        ignoreMutation: () => true,
      };
    };
  },

  addProseMirrorPlugins() {
    return [entityChipPlugin(this.options.inputs)];
  },
});
