import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState, type Plugin } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { pmDocContentSchema } from "./tiptap-schema";
import {
  AnnotationHighlight,
  annotationHighlightKey,
  getAnnotationAnchorRanges,
  type AnnotationAnchorInput,
} from "./annotation-highlight-extension";

// The plugin's own tracking, driven through a bare EditorState — no DOM, no
// editor. What is pinned here is the part resolve.test.ts can't see: which
// range each pass *starts from*. A reading view pushes content with
// `setContent`, whose mapping sends every position to the document's edges,
// and an anchor push re-resolves the whole list — so starting from the wrong
// range is what detached a multi-block annotation with nothing edited at all.

function plugin(anchors: AnnotationAnchorInput[]): Plugin {
  const configured = AnnotationHighlight.configure({ anchors });
  // addProseMirrorPlugins reads only `this.options`.
  const make = configured.config.addProseMirrorPlugins as unknown as (this: { options: unknown }) => Plugin[];
  return make.call({ options: configured.options })[0];
}

const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

// A lead-in paragraph and a nested list, the quote running into the bullets.
const PASSAGE = {
  type: "bulletList",
  content: [
    {
      type: "listItem",
      content: [
        para("Lead-in sentence."),
        {
          type: "bulletList",
          content: ["First bullet.", "Second bullet."].map((text) => ({ type: "listItem", content: [para(text)] })),
        },
      ],
    },
  ],
};

function docOf(...content: object[]): PMNode {
  return pmDocContentSchema.nodeFromJSON({ type: "doc", content });
}

// The first "Lead-in sentence." through the first "Second bullet.".
function passageRange(doc: PMNode) {
  let from = -1;
  let to = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === "Lead-in sentence." && from < 0) from = pos;
    if (node.isText && node.text === "Second bullet." && to < 0) to = pos + node.nodeSize;
  });
  return { from, to };
}

// What useLiveDocContent's `setContent` amounts to: the whole document replaced.
function pushContent(state: EditorState, doc: PMNode): EditorState {
  return state.apply(state.tr.replaceWith(0, state.doc.content.size, doc.content));
}

function stateWith(doc: PMNode): { state: EditorState; anchor: AnnotationAnchorInput } {
  const { from, to } = passageRange(doc);
  const anchor = { id: "a1", from, to, quotedText: doc.textBetween(from, to, " ") };
  assert.ok(to - from > anchor.quotedText.length, "the fixture must actually cross block boundaries");
  return { state: EditorState.create({ doc, plugins: [plugin([anchor])] }), anchor };
}

test("a cross-block anchor survives a push of unchanged content", () => {
  const doc = docOf(PASSAGE);
  const { state, anchor } = stateWith(doc);
  const after = pushContent(state, docOf(PASSAGE));
  assert.deepEqual(getAnnotationAnchorRanges(after).get("a1"), { from: anchor.from, to: anchor.to });
});

test("a cross-block anchor follows a push that moved it further than the window", () => {
  // Text added above and as much removed below: the net size change — what
  // sizes the window — is zero, while the passage moved. A catch-up after
  // FROZEN delivers exactly this, several updates as one push.
  const added = "x".repeat(200);
  const { state, anchor } = stateWith(docOf(PASSAGE, para(added)));
  const after = pushContent(state, docOf(para(added), PASSAGE));
  const shift = added.length + 2; // a paragraph of n characters is n + 2 positions
  assert.equal(after.doc.content.size, state.doc.content.size);
  assert.deepEqual(getAnnotationAnchorRanges(after).get("a1"), { from: anchor.from + shift, to: anchor.to + shift });
});

test("an anchor push starts from the tracked range, not the stored one", () => {
  // Two copies of the passage, so a whole-document search is ambiguous: the
  // only way to stay on the first after the push is to start where the
  // plugin had already followed it to. The gap keeps the second copy out of
  // the per-update window, so the edit itself is tracked unambiguously.
  const gap = para("y".repeat(200));
  const { state, anchor } = stateWith(docOf(PASSAGE, gap, PASSAGE));
  const moved = pushContent(state, docOf(para("Typed above."), PASSAGE, gap, PASSAGE));
  const tracked = getAnnotationAnchorRanges(moved).get("a1");
  assert.ok(tracked && tracked.from > anchor.from, "the edit must have moved it");

  // Someone else posts; the list arrives again with the same stored columns.
  const pushed = moved.apply(moved.tr.setMeta(annotationHighlightKey, [anchor]));
  assert.deepEqual(getAnnotationAnchorRanges(pushed).get("a1"), tracked);
});
