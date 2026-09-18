// A comment's permalink fragment on its post page — `#<name>-<timestamp>`,
// the id CommentNode gives the timestamp link. Pure and browser-safe, here
// rather than inside CommentNode so a server-side citation
// (comment-quote-data.ts) can point at a comment with the same fragment the
// page renders, and the two cannot drift.
//
// Down to the second is enough that a collision would mean the same person
// posted twice in the same second, which shouldn't happen; not worth guarding.
export function commentAnchorName(displayName: string, createdAt: string | Date): string {
  const name = displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const timestamp = new Date(createdAt).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${name || "comment"}-${timestamp}`;
}
