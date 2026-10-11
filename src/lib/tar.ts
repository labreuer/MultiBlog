// A minimal ustar writer — the export's container (docs/MCP.md §6). Regular
// files only, names under 100 bytes, which is all an export holds (`<id>.md`
// and `manifest.json`); no dependency for forty lines of format.
//
// Pure and browser-safe; tar.test.ts reads an archive back to check it.

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

/** One file's header and contents, padded to a whole number of blocks. */
export function tarEntry(name: string, content: Uint8Array, mtime: Date = new Date(0)): Uint8Array {
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 99) throw new Error(`tar entry name too long: ${name}`);
  const header = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
  header.set(nameBytes, 0);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(content.length, 12));
  put(136, octal(Math.floor(mtime.getTime() / 1000), 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\u000000");
  let sum = 0;
  for (const byte of header) sum += byte;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");

  const padded = Math.ceil(content.length / BLOCK) * BLOCK;
  const out = new Uint8Array(BLOCK + padded);
  out.set(header, 0);
  out.set(content, BLOCK);
  return out;
}

/** The two zero blocks that end an archive. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

/** An archive's files, by name — the reading half, for tests. */
export function readTar(archive: Uint8Array): Map<string, string> {
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).split("\0")[0];
    const size = parseInt(decoder.decode(header.subarray(124, 136)).split("\0")[0].trim(), 8);
    files.set(name, decoder.decode(archive.subarray(offset + BLOCK, offset + BLOCK + size)));
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}
