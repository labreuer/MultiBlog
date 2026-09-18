// PLAN.md §23h — what a rendered quotation says about its source. Browser-safe
// (a plain type and a lookup): the server resolves citations per anchor row
// (`describeQuoteTargets`, comment-quote-data.ts) and hands them to
// CommentBody, which renders inside client components too.

export type CommentQuoteCitation = {
  anchorId: string;
  /** "the post", "Jane Doe's comment", … — never the quoted words themselves. */
  label: string;
  /** Where the quoted passage lives, or null when the target is no longer public (§23e). */
  href: string | null;
  /**
   * True when the pinned version is not the target's newest — a comment
   * quoted before it was edited (§23h's "quoted an earlier version").
   */
  stale: boolean;
};

export type CommentQuoteCitations = Record<string, CommentQuoteCitation>;
