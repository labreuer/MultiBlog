// docs/CITATIONS.md, "The import box" — an import's records cut into the
// batches the browser sends, one server action each. Pure and browser-safe,
// so the browser and its test cut alike; the server holds a batch to the same
// two bounds (reference-write.ts, `importBatchOf`).

/** At most this many records in a batch. */
export const BATCH_RECORDS = 100;
/**
 * And at most this many bytes as UTF-8, half of Next's 1 MB body limit,
 * which counts bytes: a record may be 20,000 characters and a character
 * three bytes, so a hundred of the largest would not fit.
 */
export const BATCH_BYTES = 500_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an import may be sent, from its first receipt on the server and
 * from its start in the browser, which offers an unfinished one to resume
 * for as long. A batch past it is refused.
 */
export const IMPORT_RESUMABLE_MS = 6 * DAY_MS;

/**
 * How long the server keeps an import's receipts: a day past the last batch
 * it accepts, so no receipt is deleted while its import may still be sent.
 * Without its receipt, a resent record could no longer be told from a new one.
 */
export const IMPORT_KEPT_MS = 7 * DAY_MS;

const encoder = new TextEncoder();

/** `records` in order, cut so no batch passes either bound. A record too large to go in any batch is a batch of its own, for the server to refuse. */
export function cutBatches<T>(records: readonly T[], maxRecords = BATCH_RECORDS, maxBytes = BATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  // The batch's JSON is `[` + records joined by `,` + `]`.
  let bytes = 2;
  for (const record of records) {
    const size = encoder.encode(JSON.stringify(record)).length;
    const after = bytes + size + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && (current.length >= maxRecords || after > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    bytes += size + (current.length > 0 ? 1 : 0);
    current.push(record);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
