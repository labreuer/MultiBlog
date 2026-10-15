import { crc32 } from "node:zlib";

// A minimal ZIP writer — the skill's container (docs/MCP.md §21, "The
// skill"), which claude.ai takes as a ZIP holding the skill's folder. Stored
// entries only, since a skill is a few kilobytes of text; no Zip64, no
// dependency for sixty lines of format, as tar.ts is for the export.
//
// Server-only for its CRC; zip.test.ts checks an archive with the system's
// own `unzip` where there is one.

const encoder = new TextEncoder();

/** ZIP's own epoch, 1980-01-01, as an MS-DOS date: fixed, so the same files always make the same bytes. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const VERSION = 20;
/** "Made by" Unix, so an extractor takes the mode bits from the external attributes. */
const MADE_BY = (3 << 8) | VERSION;
const UTF8_NAMES = 0x0800;

export type ZipEntry = {
  /** A path inside the archive; one ending in `/` is a directory, with no content. */
  name: string;
  content?: Uint8Array;
};

/** The archive's bytes, each entry stored as it is, in the order given. */
export function zipStored(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const isDir = entry.name.endsWith("/");
    const content = isDir ? new Uint8Array() : (entry.content ?? new Uint8Array());
    const crc = crc32(content) >>> 0;

    const local = new Uint8Array(30 + name.length + content.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, VERSION, true);
    l.setUint16(6, UTF8_NAMES, true);
    l.setUint16(8, 0, true); // stored
    l.setUint16(10, 0, true); // time
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, content.length, true);
    l.setUint32(22, content.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(content, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, MADE_BY, true);
    c.setUint16(6, VERSION, true);
    c.setUint16(8, UTF8_NAMES, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, content.length, true);
    c.setUint32(24, content.length, true);
    c.setUint16(28, name.length, true);
    // Extra field, comment, disk number and internal attributes stay zero.
    c.setUint32(38, (((isDir ? 0o40755 : 0o100644) << 16) | (isDir ? 0x10 : 0)) >>> 0, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const directorySize = centrals.reduce((n, part) => n + part.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);

  const out = new Uint8Array(offset + directorySize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
