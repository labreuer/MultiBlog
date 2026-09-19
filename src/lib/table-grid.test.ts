import { test } from "node:test";
import assert from "node:assert/strict";
import { pmSchema } from "./tiptap-schema";
import {
  MAX_TABLE_CELLS,
  TableTooLargeError,
  assertGridWithinCap,
  gridSize,
  gridToRectangle,
  gridToTableJson,
  padGrid,
  rectangleToGrid,
  tableJsonToGrid,
  type TableGrid,
} from "./table-grid";

// The grid's rules as a table: what a table node is built from, what one
// flattens to, and the cap. Every node built here is run through the real
// schema's `check()` — the editor's insertContent validates against that
// same schema, so a shape this test accepts is one the editor accepts.

const checked = (grid: TableGrid, opts?: { headerRow?: boolean }) => {
  const json = gridToTableJson(grid, opts);
  pmSchema.nodeFromJSON(json).check();
  return json;
};

test("builds header cells from the first row and body cells below, one paragraph per cell", () => {
  const json = checked(rectangleToGrid([["h1", "h2"], ["a", "b"]]));
  assert.equal(json.type, "table");
  assert.deepEqual(json.content?.[0], {
    type: "tableRow",
    content: [
      { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "h1" }] }] },
      { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "h2" }] }] },
    ],
  });
  assert.equal(json.content?.[1].content?.[0].type, "tableCell");
});

test("headerRow: false makes every row body cells", () => {
  const json = checked(rectangleToGrid([["h1"], ["a"]]), { headerRow: false });
  assert.equal(json.content?.[0].content?.[0].type, "tableCell");
});

test("a line break inside a field becomes a second paragraph; an empty field one empty paragraph", () => {
  const json = checked(rectangleToGrid([["one\ntwo", ""]]), { headerRow: false });
  const [multi, empty] = json.content![0].content!;
  assert.deepEqual(multi.content, [
    { type: "paragraph", content: [{ type: "text", text: "one" }] },
    { type: "paragraph", content: [{ type: "text", text: "two" }] },
  ]);
  assert.deepEqual(empty.content, [{ type: "paragraph" }]);
});

test("pads ragged rows to the widest row", () => {
  assert.deepEqual(padGrid(rectangleToGrid([["a", "b", "c"], ["d"]])), [
    [{ text: "a" }, { text: "b" }, { text: "c" }],
    [{ text: "d" }, { text: "" }, { text: "" }],
  ]);
  // A span counts for the columns it covers.
  const spanned: TableGrid = [[{ text: "wide", colspan: 3 }], [{ text: "x" }]];
  assert.equal(padGrid(spanned)[1].length, 3);
  checked(spanned);
});

test("spans and links survive into the node and back", () => {
  const grid: TableGrid = [
    [{ text: "a", colspan: 2 }, { text: "b", rowspan: 2, href: "https://example.com/" }],
    [{ text: "c" }, { text: "d" }],
  ];
  const json = checked(grid, { headerRow: false });
  assert.deepEqual(json.content![0].content![0].attrs, { colspan: 2 });
  assert.deepEqual(json.content![0].content![1].attrs, { rowspan: 2 });
  assert.deepEqual(json.content![0].content![1].content![0].content![0].marks, [
    { type: "link", attrs: { href: "https://example.com/" } },
  ]);
  assert.deepEqual(tableJsonToGrid(json), grid);
});

test("reads a node's cell text with paragraphs joined by a line break and marks dropped", () => {
  const json = {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableHeader",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }] },
              { type: "paragraph", content: [{ type: "text", text: "and" }, { type: "hardBreak" }, { type: "text", text: "break" }] },
            ],
          },
          {
            type: "tableCell",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  pmSchema.nodeFromJSON(json).check();
  assert.deepEqual(tableJsonToGrid(json), [[{ text: "bold\nand\nbreak" }, { text: "one\ntwo" }]]);
});

test("refuses to read anything but a table node", () => {
  assert.throws(() => tableJsonToGrid({ type: "paragraph" }), /Expected a table node/);
});

test("flattens spans to a rectangle: the value in the first cell, empty strings under the span", () => {
  const grid: TableGrid = [
    [{ text: "a", colspan: 2 }, { text: "b", rowspan: 2 }],
    [{ text: "c" }, { text: "d" }],
    [{ text: "e" }, { text: "f" }, { text: "g" }],
  ];
  assert.deepEqual(gridToRectangle(grid), [
    ["a", "", "b"],
    ["c", "d", ""],
    ["e", "f", "g"],
  ]);
});

test("a rowspan that reaches past the row's own cells still pads the row", () => {
  const grid: TableGrid = [[{ text: "a" }, { text: "b", rowspan: 2 }], [{ text: "c" }]];
  assert.deepEqual(gridToRectangle(grid), [
    ["a", "b"],
    ["c", ""],
  ]);
});

test("counts rows × widest row, spans by the cells they cover, and caps on the product", () => {
  assert.deepEqual(gridSize([[{ text: "a", colspan: 3 }], [{ text: "b" }]]), { rows: 2, columns: 3 });
  const fits = Array.from({ length: MAX_TABLE_CELLS / 10 }, () => Array.from({ length: 10 }, () => ({ text: "" })));
  assert.doesNotThrow(() => assertGridWithinCap(fits));
  const over = [...fits, [{ text: "" }]];
  assert.throws(() => assertGridWithinCap(over), TableTooLargeError);
  assert.throws(() => assertGridWithinCap(over), /rows × 10 columns/);
});

test("an empty grid has no table to build", () => {
  assert.throws(() => gridToTableJson([]), /no rows/);
});
