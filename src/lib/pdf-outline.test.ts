import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeNodeAt,
  ancestorIdsOf,
  childrenOf,
  defaultExpanded,
  destPageTarget,
  destinationYFromTop,
  flattenOutline,
  isVisible,
  refKey,
  visibleAncestorOf,
  visibleOrder,
  type OutlineNode,
  type PdfOutlineItem,
} from "./pdf-outline";

// PLAN.md §19b. What is worth pinning here is the *rejection* surface — a
// destination array is a hand-written structure out of somebody else's file
// generator, and every arm below is a shape a real PDF has been seen to carry.
// The highlight rules get the same treatment because their failure mode is a
// plausible-looking wrong answer rather than a crash.

const PAGE_HEIGHT = 792;

// ---- destination arithmetic -------------------------------------------------

test("XYZ takes its top, converted out of PDF user space", () => {
  assert.equal(destinationYFromTop([{ num: 4, gen: 0 }, { name: "XYZ" }, 72, 700, null], PAGE_HEIGHT), 92);
});

test("XYZ with a null top — 'keep the current position' — lands at the page top", () => {
  assert.equal(destinationYFromTop([{ num: 4, gen: 0 }, { name: "XYZ" }, 72, null, null], PAGE_HEIGHT), 0);
});

test("FitH and FitBH take the second slot", () => {
  assert.equal(destinationYFromTop([0, { name: "FitH" }, 692], PAGE_HEIGHT), 100);
  assert.equal(destinationYFromTop([0, { name: "FitBH" }, 692], PAGE_HEIGHT), 100);
});

test("FitR takes the rectangle's top edge, not its bottom", () => {
  assert.equal(destinationYFromTop([0, { name: "FitR" }, 10, 100, 500, 592], PAGE_HEIGHT), 200);
});

test("the whole-page fits carry no vertical position", () => {
  for (const name of ["Fit", "FitB", "FitV", "FitBV"]) {
    assert.equal(destinationYFromTop([0, { name }, 0], PAGE_HEIGHT), 0, name);
  }
});

test("a name arriving as a bare string is still read", () => {
  assert.equal(destinationYFromTop([0, "FitH", 692], PAGE_HEIGHT), 100);
});

test("a truncated, unnamed or nonsense destination lands at the page top rather than NaN", () => {
  assert.equal(destinationYFromTop([], PAGE_HEIGHT), 0);
  assert.equal(destinationYFromTop([0], PAGE_HEIGHT), 0);
  assert.equal(destinationYFromTop([0, { name: "XYZ" }], PAGE_HEIGHT), 0);
  assert.equal(destinationYFromTop([0, null, 700], PAGE_HEIGHT), 0);
  assert.equal(destinationYFromTop([0, { name: "XYZ" }, 72, "700", null], PAGE_HEIGHT), 0);
  assert.equal(destinationYFromTop([0, { name: "FitH" }, Number.NaN], PAGE_HEIGHT), 0);
});

test("a y outside the page is clamped to it, either end", () => {
  assert.equal(destinationYFromTop([0, { name: "FitH" }, 5000], PAGE_HEIGHT), 0);
  assert.equal(destinationYFromTop([0, { name: "FitH" }, -5000], PAGE_HEIGHT), PAGE_HEIGHT);
});

// ---- the page target --------------------------------------------------------

test("an inline destination's integer page index is taken as one", () => {
  assert.deepEqual(destPageTarget([2, { name: "Fit" }]), { kind: "index", pageIndex: 2 });
});

test("a page ref is reported as a ref — never mistaken for an index", () => {
  const ref = { num: 12, gen: 0 };
  assert.deepEqual(destPageTarget([ref, { name: "XYZ" }, 0, 0, null]), { kind: "ref", ref });
  assert.equal(refKey(ref), "12R0");
});

test("a destination that is not an array, is empty, or leads with junk resolves to nothing", () => {
  assert.equal(destPageTarget(null), null);
  assert.equal(destPageTarget("SomeNamedDestination"), null);
  assert.equal(destPageTarget([]), null);
  assert.equal(destPageTarget([{ name: "Fit" }]), null);
  assert.equal(destPageTarget([-1, { name: "Fit" }]), null);
  assert.equal(destPageTarget([1.5, { name: "Fit" }]), null);
});

// ---- flattening -------------------------------------------------------------

/** Three chapters, the second with two sections, the first section with one part. */
const SAMPLE: PdfOutlineItem[] = [
  { title: "Front matter", dest: [0, { name: "Fit" }], url: null, count: 0 },
  {
    title: "  Chapter one  ",
    dest: [1, { name: "Fit" }],
    url: null,
    count: -2,
    items: [
      {
        title: "Section 1.1",
        dest: [2, { name: "Fit" }],
        url: null,
        count: 1,
        items: [{ title: "Part 1.1.1", dest: [3, { name: "Fit" }], url: null }],
      },
      { title: "Section 1.2", dest: [4, { name: "Fit" }], url: null },
    ],
  },
  { title: "Elsewhere", dest: null, url: "https://example.invalid/", count: 0 },
];

/** Positions the sample by page, one page per unit of fraction — easy arithmetic. */
function flattenSample(): OutlineNode[] {
  return flattenOutline(
    SAMPLE,
    (item) => {
      const target = destPageTarget(item.dest);
      return target?.kind === "index" ? { pageIndex: target.pageIndex, yFromTop: 0 } : null;
    },
    (position) => position.pageIndex / 10,
  );
}

test("flattening assigns path ids, depths and parents", () => {
  const nodes = flattenSample();
  assert.deepEqual(
    nodes.map((node) => [node.id, node.parentId, node.depth]),
    [
      ["0", null, 0],
      ["1", null, 0],
      ["1.0", "1", 1],
      ["1.0.0", "1.0", 2],
      ["1.1", "1", 1],
      ["2", null, 0],
    ],
  );
});

test("titles are trimmed, and an unresolvable entry keeps its row with no position", () => {
  const nodes = flattenSample();
  assert.equal(nodes[1].title, "Chapter one");
  const elsewhere = nodes[nodes.length - 1];
  assert.equal(elsewhere.position, null);
  assert.equal(elsewhere.fraction, null);
  assert.equal(elsewhere.url, "https://example.invalid/");
});

test("hasChildren follows the tree, and childrenOf re-forms it", () => {
  const nodes = flattenSample();
  assert.deepEqual(
    childrenOf(nodes, "1").map((node) => node.title),
    ["Section 1.1", "Section 1.2"],
  );
  assert.deepEqual(
    childrenOf(nodes, null).map((node) => node.title),
    ["Front matter", "Chapter one", "Elsewhere"],
  );
  assert.equal(nodes.find((node) => node.id === "1.1")?.hasChildren, false);
});

// ---- expansion --------------------------------------------------------------

test("ancestorIdsOf walks outward from the root, excluding the node itself", () => {
  assert.deepEqual(ancestorIdsOf("1.0.0"), ["1", "1.0"]);
  assert.deepEqual(ancestorIdsOf("3"), []);
});

test("a negative /Count is honoured — except at the top level, which always opens", () => {
  const expanded = defaultExpanded(flattenSample());
  // "Chapter one" carries count -2 but is top level, so it opens anyway.
  assert.ok(expanded.has("1"));
  // Its section carries a positive count and opens on the document's say-so.
  assert.ok(expanded.has("1.0"));
  // Leaves are never in the set — there is nothing to open.
  assert.ok(!expanded.has("1.0.0"));
  assert.ok(!expanded.has("0"));
});

test("a nested negative /Count stays closed", () => {
  const nodes = flattenOutline(
    [
      {
        title: "Chapter",
        dest: null,
        url: null,
        count: 1,
        items: [
          {
            title: "Closed section",
            dest: null,
            url: null,
            count: -3,
            items: [{ title: "Hidden part", dest: null, url: null }],
          },
        ],
      },
    ],
    () => null,
    () => 0,
  );
  const expanded = defaultExpanded(nodes);
  assert.ok(expanded.has("0"));
  assert.ok(!expanded.has("0.0"));
  assert.ok(isVisible("0.0", expanded));
  assert.ok(!isVisible("0.0.0", expanded));
});

test("visibleOrder renders exactly the rows whose every ancestor is open", () => {
  const nodes = flattenSample();
  assert.deepEqual(
    visibleOrder(nodes, new Set(["1"])).map((node) => node.id),
    ["0", "1", "1.0", "1.1", "2"],
  );
  assert.deepEqual(
    visibleOrder(nodes, new Set(["1", "1.0"])).map((node) => node.id),
    ["0", "1", "1.0", "1.0.0", "1.1", "2"],
  );
  assert.deepEqual(
    visibleOrder(nodes, new Set()).map((node) => node.id),
    ["0", "1", "2"],
  );
});

// ---- which row is current ---------------------------------------------------

test("the current entry is the last one at or above the reading line", () => {
  const nodes = flattenSample();
  // Pages 0..4 at fractions 0, .1, .2, .3, .4.
  assert.equal(activeNodeAt(nodes, 0.25)?.id, "1.0");
  assert.equal(activeNodeAt(nodes, 0.35)?.id, "1.0.0");
  // Well past the last positioned entry, it stays current — a section runs
  // until the next one starts, not until the next screenful.
  assert.equal(activeNodeAt(nodes, 0.99)?.id, "1.1");
});

test("an entry exactly on the line is current", () => {
  assert.equal(activeNodeAt(flattenSample(), 0.2)?.id, "1.0");
});

test("above the first entry, nothing is current", () => {
  const nodes = flattenOutline(
    [{ title: "Chapter one", dest: [1, { name: "Fit" }], url: null }],
    () => ({ pageIndex: 1, yFromTop: 0 }),
    () => 0.5,
  );
  assert.equal(activeNodeAt(nodes, 0.4), null);
});

test("on a tie the deeper entry wins — a chapter and its first section share a page", () => {
  const nodes = flattenOutline(
    [
      {
        title: "Chapter",
        dest: null,
        url: null,
        items: [{ title: "First section", dest: null, url: null }],
      },
    ],
    () => ({ pageIndex: 3, yFromTop: 0 }),
    () => 0.3,
  );
  assert.equal(activeNodeAt(nodes, 0.5)?.id, "0.0");
});

test("entries with no position are never current, whatever the line", () => {
  const nodes = flattenOutline(
    [
      { title: "Broken", dest: null, url: null },
      { title: "Real", dest: [0, { name: "Fit" }], url: null },
    ],
    (item) => (item.dest ? { pageIndex: 0, yFromTop: 0 } : null),
    () => 0.1,
  );
  assert.equal(activeNodeAt(nodes, 0.9)?.title, "Real");
});

test("a non-monotonic outline is ordered by position, not by the tree", () => {
  // A generator that emitted its chapters out of order: entry 0 points at the
  // back of the document, entry 1 at the front.
  const nodes = flattenOutline(
    [
      { title: "Late", dest: [8, { name: "Fit" }], url: null },
      { title: "Early", dest: [2, { name: "Fit" }], url: null },
    ],
    (item) => {
      const target = destPageTarget(item.dest);
      return target?.kind === "index" ? { pageIndex: target.pageIndex, yFromTop: 0 } : null;
    },
    (position) => position.pageIndex / 10,
  );

  assert.equal(activeNodeAt(nodes, 0.5)?.title, "Early");
  assert.equal(activeNodeAt(nodes, 0.9)?.title, "Late");
});

// ---- the highlight a collapsed subtree gets ---------------------------------

test("an open tree highlights the active row itself", () => {
  assert.equal(visibleAncestorOf("1.0.0", new Set(["1", "1.0"])), "1.0.0");
});

test("a collapsed subtree passes the highlight to the outermost closed ancestor", () => {
  // "Chapter one" is closed: it lights up, not the section inside it.
  assert.equal(visibleAncestorOf("1.0.0", new Set(["1.0"])), "1");
  // Only the section is closed: the chapter is open, so the section lights up.
  assert.equal(visibleAncestorOf("1.0.0", new Set(["1"])), "1.0");
});

test("a top-level row is its own highlight, expanded or not", () => {
  assert.equal(visibleAncestorOf("2", new Set()), "2");
});
