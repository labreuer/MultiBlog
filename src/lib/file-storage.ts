import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatBytes, type UploadKind } from "./file-format";

// PLAN.md §19 — where an uploaded file's bytes actually live, and the only
// module that knows. Everything else addresses a file by its sha256.
//
// Server-only, by the same convention src/lib/avatar.ts uses: the `node:`
// imports above have no browser equivalent, so nothing here may be reached
// from a `"use client"` component. The browser-safe half (formatBytes, the
// upload endpoint's shape) is src/lib/file-format.ts, which is why the size
// formatter this file's error messages use is imported rather than defined
// here — /files renders the same strings client-side.
//
// **On disk rather than in Postgres.** Prisma cannot stream a
// `Bytes` column, so a 50MB PDF in the database would be read whole into Node's
// heap on upload and again on every one of PDF.js's range requests — see
// StoredFile's comment in schema.prisma for the full argument, and UserAvatar
// for the case where a blob column *is* right (10KB, served whole).
//
// **Content-addressed.** A file's path is a pure function of its sha256, which
// buys three things at once: the URL for a given set of bytes is immutable (so
// the download route can answer `immutable` and use the hash as its ETag),
// two uploads of the same PDF store one copy, and docs/PDF.md's "DocId is a
// content hash of the PDF bytes" is satisfied without inventing a second
// identifier. The cost is that deleting a StoredFile row must not blindly
// delete its bytes — another row may share them (see deleteBytesIfUnreferenced).

/** Default when FILE_STORAGE_DIR is unset — a gitignored directory beside the repo's other local state. */
const DEFAULT_STORAGE_DIR = ".file-storage";

// The one guard that bounds ingestion cost. Bytes, not pixels: unlike an image
// (where src/lib/avatar.ts caps decoded pixels because byte size predicts
// decode cost badly), a PDF's cost here is dominated by transfer and disk, both
// of which are linear in bytes.
//
// Read per call rather than captured at module load so a deployment can change
// it with a restart and no rebuild — the same property SITE_BANNER has, and the
// reason this is a bare env var rather than a NEXT_PUBLIC_ one. The browser
// learns the number from /api/files/limits instead, which is also what makes
// the client-side pre-check and the server's enforcement provably the same
// number rather than two constants that can drift.
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function maxUploadBytes(): number {
  const raw = process.env.FILE_MAX_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_UPLOAD_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[file-storage] FILE_MAX_UPLOAD_BYTES=${raw} isn't a positive number — using the default.`);
    return DEFAULT_MAX_UPLOAD_BYTES;
  }
  return Math.floor(parsed);
}

export function storageDir(): string {
  // The two cases are split apart, rather than the tidier
  // `resolve(process.env.FILE_STORAGE_DIR || DEFAULT_STORAGE_DIR)`, for the sake
  // of the *build* — at runtime the two forms are identical. Next traces each
  // route's file dependencies (NFT) by statically evaluating path expressions,
  // and the `||` form collapses to a single *partly* known value: a relative
  // path with an unknown component, which the tracer anchors at `process.cwd()`
  // and then traces as a glob over the whole project. The upload route's NFT
  // list therefore claimed every file in the repo, next.config.ts included, and
  // `next build` warned that "the whole project was traced unintentionally".
  // Split, each branch is something the tracer can settle: a fully known
  // `<root>/.file-storage` — runtime state, not a build input, and normally
  // absent at build time — or a fully unknown path, which it declines to trace
  // rather than guessing.
  //
  // The `/* turbopackIgnore: true */` comment that warning itself prescribes
  // does **not** work here; measured against next@16.2.11, it is honoured on
  // `require`/`import` and not on a `node:path` call. Nor does setting
  // FILE_STORAGE_DIR silence it — a bare env var is never inlined into server
  // code, so the tracer sees an unknown either way.
  const configured = process.env.FILE_STORAGE_DIR;
  return configured ? resolve(configured) : resolve(DEFAULT_STORAGE_DIR);
}

// Two levels: <dir>/<first two hex chars>/<full hash>. The fan-out exists
// because some filesystems degrade badly on a directory with tens of thousands
// of entries; two hex chars gives 256 buckets, which is plenty at this scale
// and costs one extra mkdir.
export function storagePathFor(sha256: string): string {
  return join(storageDir(), sha256.slice(0, 2), sha256);
}

/** A rejected upload, with a message safe to show the uploader. */
export class UploadError extends Error {
  constructor(
    message: string,
    /** HTTP status the route should answer with. */
    readonly status: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export type StoredBytes = {
  sha256: string;
  byteSize: number;
  /** True when these exact bytes were already on disk — a second uploader of the same PDF. */
  deduped: boolean;
};

/** PDF magic number. A file that doesn't start with this is rejected before anything else touches it. */
// The first bytes each accepted format must start with, checked as the body
// streams past (PLAN.md §19 Phase 1). Kept here rather than in file-format.ts
// because file-format.ts is imported by client components, and a magic number
// is a server-side concern the browser has no use for.
//
// This is the *whole* format check for a .docx, and a first gate for a PDF —
// which is parsed properly after storing, because its page text is what a
// later annotation anchors into. A .docx has no such reader yet, so being a
// real OPC package (a zip) is all there is to confirm; anything stricter would
// reject documents Word, LibreOffice and Pages all write differently and we
// can hold perfectly well.
const MAGIC: Record<UploadKind, string> = {
  // "%PDF-"
  pdf: "%PDF-",
  // "PK\u0003\u0004" — the local file header every zip entry starts with.
  docx: "PK\u0003\u0004",
};

// Streams a request body to disk, hashing as it goes.
//
// The shape matters more than it looks. `await request.formData()` or
// `arrayBuffer()` would buffer the whole upload in memory, which at the 50MB
// cap is exactly what this design exists to avoid — so the body arrives as raw
// bytes (not multipart) and is consumed a chunk at a time, with the hash and
// the byte count built incrementally and the limit enforced *mid-stream* rather
// than from a Content-Length header a client controls.
//
// Written to a temp file first and renamed into place only once the whole body
// has arrived and validated. A rename within a filesystem is atomic, so a
// reader can never observe a half-written file at a content-addressed path —
// which would be the one genuinely corrupting failure here, since that path
// claims to be those exact bytes forever after. The temp file lives inside
// storageDir() itself (a `.tmp-` prefixed sibling of the hash buckets), not
// os.tmpdir() — FILE_STORAGE_DIR is routinely a separate mount from /tmp in
// deployment, and rename() across filesystems fails with EXDEV rather than
// falling back to a copy.
/** One phrasing for both the mid-stream and too-short rejections. */
function wrongFormatMessage(kind: UploadKind | null): string {
  return kind === "docx" ? "That doesn't look like a .docx file." : "That doesn't look like a PDF file.";
}

export async function storeUploadStream(
  body: ReadableStream<Uint8Array>,
  options: { maxBytes?: number; kind?: UploadKind | null } = {},
): Promise<StoredBytes> {
  const maxBytes = options.maxBytes ?? maxUploadBytes();
  // `kind: null` skips the check outright, for a caller that has already
  // decided what the bytes are.
  const kind = options.kind === undefined ? "pdf" : options.kind;
  const magic = kind ? MAGIC[kind] : null;

  await mkdir(storageDir(), { recursive: true });
  const tempPath = join(storageDir(), `.tmp-upload-${randomUUID()}`);
  const handle = await open(tempPath, "wx");

  const hash = createHash("sha256");
  let byteSize = 0;
  let head = Buffer.alloc(0);
  let headChecked = magic === null;

  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      byteSize += value.byteLength;
      if (byteSize > maxBytes) {
        // Cancel rather than drain: there is no reason to receive the rest of a
        // body that is already rejected, and cancelling lets the client learn
        // early instead of after uploading 200MB.
        await reader.cancel().catch(() => {});
        throw new UploadError(
          `That file is larger than the ${formatBytes(maxBytes)} limit for this site.`,
          413,
        );
      }

      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!headChecked) {
        head = head.length === 0 ? Buffer.from(chunk) : Buffer.concat([head, chunk]);
        if (magic && head.length >= magic.length) {
          if (head.subarray(0, magic.length).toString("latin1") !== magic) {
            await reader.cancel().catch(() => {});
            throw new UploadError(wrongFormatMessage(kind), 415);
          }
          headChecked = true;
        }
      }

      hash.update(chunk);
      // Awaited per chunk, which is the backpressure: the next read doesn't
      // start until this write lands, so a fast uploader can't outrun the disk
      // and build an unbounded queue in memory.
      await handle.write(chunk);
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }

  await handle.close();

  if (byteSize === 0) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new UploadError("That file is empty.", 400);
  }
  if (!headChecked) {
    // Shorter than the magic itself, and therefore never checked above.
    await rm(tempPath, { force: true }).catch(() => {});
    throw new UploadError(wrongFormatMessage(kind), 415);
  }

  const sha256 = hash.digest("hex");
  const finalPath = storagePathFor(sha256);
  await mkdir(join(storageDir(), sha256.slice(0, 2)), { recursive: true });

  const already = await stat(finalPath).then(
    (s) => s.isFile(),
    () => false,
  );
  if (already) {
    // Same bytes already stored — by definition identical, since the path *is*
    // the hash. Drop the copy we just made rather than overwriting: an
    // overwrite would briefly truncate a file other rows are serving.
    await rm(tempPath, { force: true }).catch(() => {});
    return { sha256, byteSize, deduped: true };
  }

  await rename(tempPath, finalPath);
  return { sha256, byteSize, deduped: false };
}

/** Byte length on disk, or null if these bytes aren't stored. */
export async function storedByteSize(sha256: string): Promise<number | null> {
  return stat(storagePathFor(sha256)).then(
    (s) => (s.isFile() ? s.size : null),
    () => null,
  );
}

// A Node read stream over a byte range, for the download route's Range support.
// `end` is inclusive, matching both the HTTP Range header and
// createReadStream's own convention — deliberately not converted, so the route
// can pass the parsed header values straight through.
export function readStoredBytes(sha256: string, range?: { start: number; end: number }) {
  return createReadStream(storagePathFor(sha256), range ? { start: range.start, end: range.end } : undefined);
}

// Deletes the bytes for `sha256` **only if** no live StoredFile row still
// points at them. Content addressing means two rows can legitimately share one
// blob (the same paper uploaded by two people, with different titles and
// bylines), so an unconditional delete on row deletion would break the other
// one's downloads.
//
// Takes the surviving-reference count as an argument rather than querying:
// this module has no business importing Prisma, and the caller is already
// inside the transaction that knows the answer.
export async function deleteBytesIfUnreferenced(sha256: string, remainingReferences: number): Promise<void> {
  if (remainingReferences > 0) return;
  await rm(storagePathFor(sha256), { force: true }).catch((err) => {
    // Losing the bytes' *deletion* is not worth failing the caller's mutation
    // over — the row is gone either way, and an orphaned blob is recoverable
    // garbage rather than a correctness problem.
    console.error(`[file-storage] couldn't remove bytes for ${sha256}:`, err);
  });
}
