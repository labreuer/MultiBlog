// A minimal, dependency-free .docx writer — the .docx counterpart of
// scripts/make-test-pdf.ts, and hand-rolled for the same reasons (PLAN.md §19
// Phase 1): a fixture and the expectation it is asserted against should come
// from one place, and the repo should stay free of binary blobs whose
// provenance nobody can check.
//
// A .docx is an OPC package: a zip holding [Content_Types].xml, a relationship
// part, and word/document.xml. This writes exactly those three, stored rather
// than deflated — a store-only zip needs no compressor, and nothing in this
// codebase reads the entries back, so the extra bytes buy simplicity.
//
// What it is *for* is narrow, and deliberately so. The upload path checks a
// .docx only for being a zip (src/lib/docx-validate.ts), so what a spec needs
// is (a) something that really is a valid package, and (b) a way to produce
// bytes that are not. It is not a Word-compatibility fixture: no Word document
// is this bare, and if a .docx ever gains a reading surface, that surface wants
// testing against files real editors wrote, not against this.
//
// Usage: `npx tsx scripts/make-test-docx.ts out.docx` writes the sample; the
// e2e fixtures import buildTestDocx directly.

import { writeFileSync } from "node:fs";

/** CRC-32 (IEEE), which every zip entry header carries. Table built once, on first use. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type Entry = { name: string; bytes: Uint8Array };

/**
 * A store-only zip. No compression, no data descriptors, no zip64 — the parts
 * below are a few hundred bytes each, so none of that is reachable.
 */
function buildZip(entries: readonly Entry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // "PK\x03\x04" — the signature the upload check looks for
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method 0 = stored
    local.setUint16(10, 0, true); // mod time
    local.setUint16(12, 0x21, true); // mod date — 1980-01-01, so the bytes are reproducible
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.bytes.length, true);
    local.setUint32(22, entry.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra field length

    const header = new Uint8Array(local.buffer);
    chunks.push(header, name, entry.bytes);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true); // version made by
    dir.setUint16(6, 20, true); // version needed
    dir.setUint16(8, 0, true);
    dir.setUint16(10, 0, true);
    dir.setUint16(12, 0, true);
    dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, entry.bytes.length, true);
    dir.setUint32(24, entry.bytes.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint16(30, 0, true);
    dir.setUint16(32, 0, true); // comment length
    dir.setUint16(34, 0, true); // disk number
    dir.setUint16(36, 0, true); // internal attrs
    dir.setUint32(38, 0, true); // external attrs
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);

    offset += header.length + name.length + entry.bytes.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** Escapes the five XML metacharacters — paragraph text comes from a spec, so it can contain anything. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A valid .docx holding one paragraph per string. */
export function buildTestDocx(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`)
    .join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;

  const encoder = new TextEncoder();
  return buildZip([
    { name: "[Content_Types].xml", bytes: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", bytes: encoder.encode(RELS) },
    { name: "word/document.xml", bytes: encoder.encode(document) },
  ]);
}

/** The sample the CLI writes, and what specs use when the text doesn't matter. */
export const SAMPLE_DOCX_PARAGRAPHS: readonly string[] = [
  "A test document, written by scripts/make-test-docx.ts.",
  "The quick brown fox jumps over the lazy dog.",
];

// CLI entry, for producing a sample by hand. Guarded on argv rather than
// `require.main === module` or `import.meta.url`, for the reason
// scripts/make-test-pdf.ts records: this file is imported by the e2e fixtures
// *and* run by tsx, which transpiles to CJS while Next's own build is ESM.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/make-test-docx.ts")) {
  const out = process.argv[2] ?? "test.docx";
  writeFileSync(out, buildTestDocx(SAMPLE_DOCX_PARAGRAPHS));
  console.log(`Wrote ${out}`);
}
