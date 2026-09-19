// PLAN.md §24c — CSV, hand-rolled. RFC 4180 is the whole grammar: fields
// split by a delimiter, records by CRLF (LF and a lone CR accepted on
// read), a field holding the delimiter, a quote or a line break wrapped in
// quotes with its quotes doubled. docs/research/tables.md, "The library
// question", is why this is sixty lines and not a dependency: nothing
// CSV-shaped is installed, the grammar is small, and `test:unit` exists for
// exactly a pure function whose rejection surface is the point.
//
// String arrays in and out, nothing about tables — table-grid.ts turns a
// rectangle into a node, and table-codecs.ts joins the two.

export class CsvParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(`${message} (line ${line}).`);
    this.name = "CsvParseError";
  }
}

const BOM = "﻿";

/**
 * Comma or semicolon, by which the first line has more of. A European
 * locale's spreadsheet writes "CSV" with semicolons because its decimal
 * separator is the comma, and silently importing every such row as one
 * cell is the outcome this exists to avoid. Tabs are deliberately not on
 * the list.
 */
export function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.replace(BOM, "").split(/\r\n|\r|\n/, 1)[0] ?? "";
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") commas++;
    else if (!quoted && ch === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

/**
 * Records as rows of fields. A leading BOM is stripped; a trailing line
 * break ends the last record rather than opening an empty one; a blank
 * line elsewhere is one empty field, as the RFC reads it (the grid pads
 * it). Throws CsvParseError for an unterminated quote, a character after a
 * closing quote, or a file with nothing in it.
 */
export function parseCsv(text: string, delimiter: string = detectDelimiter(text)): string[][] {
  if (text.startsWith(BOM)) text = text.slice(1);
  if (!text.trim()) throw new CsvParseError("The file is empty", 1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let line = 1;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // A quote is only a quote at the start of a field.
      if (field !== "") throw new CsvParseError("A quote in the middle of an unquoted field", line);
      i++;
      let closed = false;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (c === "\n") line++;
        else if (c === "\r" && text[i + 1] !== "\n") line++;
        field += c;
        i++;
      }
      if (!closed) throw new CsvParseError("A quoted field is never closed", line);
      // Only a delimiter, a line break or the end may follow a closing quote.
      if (i < n && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") {
        throw new CsvParseError("Text after a closing quote", line);
      }
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      line++;
      continue;
    }
    field += ch;
    i++;
  }
  // The last record, unless the text ended on a line break.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function formatField(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Rows joined with CRLF, quoted only where the RFC requires. The BOM is on
 * by default: without it Excel on Windows reads UTF-8 as the legacy code
 * page. Values are written intact — a field starting with `=` is not
 * quote-prefixed against spreadsheet formula injection, because that would
 * change the data on a round trip and the xlsx codec (typed cells) would
 * not do it, leaving the same table exported two ways with different
 * contents. docs/research/tables.md, "Encoding and delimiters".
 */
export function formatCsv(rows: string[][], { bom = true, delimiter = "," }: { bom?: boolean; delimiter?: string } = {}): string {
  const body = rows.map((row) => row.map((v) => formatField(v, delimiter)).join(delimiter)).join("\r\n");
  return (bom ? BOM : "") + body + (rows.length ? "\r\n" : "");
}
