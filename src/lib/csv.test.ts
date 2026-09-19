import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvParseError, detectDelimiter, formatCsv, parseCsv } from "./csv";

// The RFC 4180 grammar as a table — and, more to the point, the rejection
// surface: what a file has to look like to be refused, and what a
// surprising-but-legal file parses to. docs/research/tables.md,
// "CSV import and export".

test("parses fields, quoted fields, doubled quotes and embedded line breaks", () => {
  const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","two\nlines"\r\n');
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["x, y", 'he said "hi"', "two\nlines"],
  ]);
});

test("accepts LF and a lone CR as record separators, not only CRLF", () => {
  assert.deepEqual(parseCsv("a,b\nc,d"), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(parseCsv("a,b\rc,d"), [
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("a trailing line break ends the last record rather than opening an empty one", () => {
  assert.deepEqual(parseCsv("a,b\r\n"), [["a", "b"]]);
  assert.deepEqual(parseCsv("a,b"), [["a", "b"]]);
});

test("a blank line in the middle is one empty field — the RFC's reading, padded later", () => {
  assert.deepEqual(parseCsv("a,b\n\nc,d"), [["a", "b"], [""], ["c", "d"]]);
});

test("empty fields survive at every position", () => {
  assert.deepEqual(parseCsv(",a,,b,"), [["", "a", "", "b", ""]]);
});

test("strips a leading BOM", () => {
  assert.deepEqual(parseCsv("﻿a,b"), [["a", "b"]]);
});

test("an empty or whitespace-only file is refused", () => {
  assert.throws(() => parseCsv(""), CsvParseError);
  assert.throws(() => parseCsv("﻿ \n"), CsvParseError);
});

test("an unterminated quote is refused, naming the line it opened on", () => {
  assert.throws(
    () => parseCsv('a,b\n"open,c'),
    (err: unknown) => err instanceof CsvParseError && err.line === 2,
  );
});

test("text after a closing quote is refused", () => {
  assert.throws(() => parseCsv('"a"b,c'), CsvParseError);
});

test("a quote inside an unquoted field is refused rather than swallowed", () => {
  assert.throws(() => parseCsv('ab"c,d'), CsvParseError);
});

test("ragged rows come back ragged — the grid pads, the parser reports", () => {
  assert.deepEqual(parseCsv("a,b,c\nd"), [["a", "b", "c"], ["d"]]);
});

test("detects a semicolon file by the first line, ignoring delimiters inside quotes", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a,b,c"), ",");
  assert.equal(detectDelimiter('"x;y;z",b'), ",");
  // A tie goes to the comma.
  assert.equal(detectDelimiter("a;b,c"), ",");
  assert.equal(detectDelimiter("﻿a;b"), ";");
});

test("parses a semicolon file as columns once detected", () => {
  assert.deepEqual(parseCsv("a;b\n1,5;2,5"), [
    ["a", "b"],
    ["1,5", "2,5"],
  ]);
});

test("formats with CRLF, a BOM, and quotes only where the RFC requires", () => {
  assert.equal(
    formatCsv([
      ["a", "b"],
      ["x, y", 'say "hi"', "two\nlines", "plain"],
    ]),
    '﻿a,b\r\n"x, y","say ""hi""","two\nlines",plain\r\n',
  );
});

test("leaves formula-leading values intact", () => {
  assert.equal(formatCsv([["=SUM(A1)", "+1", "-2", "@x"]], { bom: false }), "=SUM(A1),+1,-2,@x\r\n");
});

test("formatting no rows yields nothing but the BOM", () => {
  assert.equal(formatCsv([]), "﻿");
  assert.equal(formatCsv([], { bom: false }), "");
});

test("round-trips every awkward value", () => {
  const rows = [
    ["", " leading", "trailing ", '"', '""', ",", "\n", "\r\n", "a\r\nb", "ünïcødé"],
    ["=1+1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
  ];
  assert.deepEqual(parseCsv(formatCsv(rows)), rows);
});
