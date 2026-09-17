import { prisma } from "./prisma";
import type { AnchorTarget } from "./anchors";
import { isCommentPublic } from "./comment-authz";

// PLAN.md §23e — the audience rule, the one genuinely new permission in §23.
//
//   You may quote into a comment only what everyone who can see that comment
//   may already read.
//
// Not "what the quoter may read". A quotation copies the quoted words into
// the comment's own body and renders them to the comment's whole audience, so
// quoting a SHARED doc into a public post's comments *publishes* it. The gate
// is on the host surface's audience, and today the only host surface is a
// published post's comment thread, whose audience is the public — so this is
// "is the target public", asked of the resolved target.
//
// Load-bearing rather than belt-and-braces (the §20m precedent): it asks a
// different question from every read gate in the codebase, and it runs at
// post time on the server and again at render, since a target can stop being
// public after the fact — in which case the citation degrades (§23h) and the
// words, already public when quoted, stay in the body.

export type QuoteHost = { kind: "post-comments"; postId: string };

/**
 * Whether `target` may be quoted into `host`. Null-safe on a target naming
 * nothing: an id for a row that does not exist is refused, and reveals
 * nothing about what does.
 */
export async function canQuoteTargetInto(target: AnchorTarget, host: QuoteHost): Promise<boolean> {
  void host; // One host kind today; the parameter is the rule's shape, not its use.
  switch (target.kind) {
    case "post": {
      const post = await prisma.post.findUnique({
        where: { id: target.id },
        select: { publishedAt: true, publishEventId: true },
      });
      // Published, with something to quote against — the same test
      // submitComment applies before accepting a comment at all.
      return !!post && post.publishedAt !== null && post.publishedAt <= new Date() && post.publishEventId !== null;
    }
    case "comment": {
      const comment = await prisma.comment.findUnique({
        where: { id: target.id },
        select: {
          status: true,
          deletedAt: true,
          commenter: { select: { userId: true } },
          thread: { select: { post: { select: { id: true, publishedAt: true } } } },
        },
      });
      return !!comment && isCommentPublic(comment);
    }
    // §23e's table: a doc has no public tier at all (§12e), an annotation
    // inherits its container's, and a file is refused until §19 grows a
    // publicly-readable tier (§23k). The columns exist because the envelope is
    // shared; this gate is what keeps them empty.
    case "doc":
    case "annotation":
    case "file":
      return false;
  }
}
