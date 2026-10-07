// docs/MCP.md §4 — a per-token rate limit, in memory: an instance runs one
// web process, so a map is the whole store.
//
// It is mostly there to stop a runaway loop, since decoding a long doc,
// rebuilding one to anchor in it and parsing a PDF page are each expensive.
// A token bucket rather than a fixed window, because it allows a burst:
// Claude Code runs read-only tools concurrently (§15), so a sweep arrives as
// several reads at once, and a window that refused the fourth of them would
// be refusing ordinary use.

/** How many calls a token may make at once before it has to wait for refills. */
const BURST = 40;
/** Calls per second the bucket refills at: 300 a minute, sustained. */
const REFILL_PER_SECOND = 5;

const buckets = new Map<string, { tokens: number; at: number }>();

/** Takes one call from `key`'s bucket; false when it is empty. */
export function takeRateLimit(key: string, now = Date.now()): boolean {
  const bucket = buckets.get(key) ?? { tokens: BURST, at: now };
  bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.at) / 1000) * REFILL_PER_SECOND);
  bucket.at = now;
  buckets.set(key, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
