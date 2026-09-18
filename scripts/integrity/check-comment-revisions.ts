// Verifies that `comment.body` still means what PLAN.md §22c says it means —
// the newest `comment_revision` row's text — plus the two structural
// properties the silence rule rests on.
//
// Why this needs a check at all: `comment.body` is now a *cache*. It and the
// revision row are written in one transaction by `submitComment` and
// `editComment`, so unlike `doc.prose_json` there is no legitimate staleness
// window and any divergence is a fault rather than lag. But nothing
// recomputes it on read — every reader path in the app reads the column, which
// is exactly why adding history changed no query — so a divergence is silent
// by construction. The comment keeps rendering, the history view shows a
// "current" version that is not what is on screen, and nothing fails.
//
// It also checks what the history *view* needs to be trustworthy:
//
//   - **Dense, 1-based `revision_no`.** §22b's rule pairs each version with
//     its successor, so a gap makes one version look like it survived until
//     whenever the next surviving one was written — which can turn a visible
//     edit silent or the reverse. The unique index enforces no duplicates; it
//     cannot enforce density.
//   - **Revision 1 posted when the comment did.** `postedAt` is what the
//     grace window is measured from, and the loaders take it from
//     `comment.created_at` while the history list orders by revision. If
//     those disagree the window is measured from one moment and applied to
//     another.
//   - **Every comment has at least one revision.** The add_comment_revisions
//     backfill covered every row including soft-deleted ones; a comment with
//     none would render with no history and no marker however often it had
//     been edited.
//
// Reads only, no transaction, safe to run any time — unlike the doc-side
// checks there is no "mid-editing-session" caveat, because a comment has no
// live substrate that legitimately runs ahead of its cache.
//
// Usage:
//   npx tsx scripts/integrity/check-comment-revisions.ts
//   ... --post <id>      only comments on one post
//   ... --verbose        also print each comment that passed
//
// Exits non-zero on any finding. Every finding here is an ERROR: none of them
// has a benign reading.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const postIndex = args.indexOf("--post");
const postId = postIndex >= 0 ? args[postIndex + 1] : null;

function bodyTextOf(body: unknown): string {
  return (body as { text?: string } | null)?.text ?? "";
}

type Finding = { commentId: string; check: string; detail: string };

async function main() {
  const comments = await prisma.comment.findMany({
    where: postId ? { thread: { postId } } : {},
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      body: true,
      createdAt: true,
      editedAt: true,
      revisions: { orderBy: { revisionNo: "asc" }, select: { revisionNo: true, body: true, createdAt: true } },
    },
  });

  const findings: Finding[] = [];

  for (const comment of comments) {
    const revisions = comment.revisions;

    if (revisions.length === 0) {
      findings.push({
        commentId: comment.id,
        check: "no-revisions",
        detail: "comment has no comment_revision rows at all (the backfill covered every row that existed)",
      });
      continue;
    }

    // 1. body is the newest revision.
    const newest = revisions[revisions.length - 1];
    const cached = bodyTextOf(comment.body);
    const stored = bodyTextOf(newest.body);
    if (cached !== stored) {
      findings.push({
        commentId: comment.id,
        check: "body-cache",
        detail:
          `comment.body is not revision ${newest.revisionNo}'s text — ` +
          `column ${JSON.stringify(cached.slice(0, 60))} vs. revision ${JSON.stringify(stored.slice(0, 60))}`,
      });
    }

    // 2. Dense, 1-based numbering.
    const expected = revisions.map((_, index) => index + 1);
    const actual = revisions.map((r) => r.revisionNo);
    if (actual.join(",") !== expected.join(",")) {
      findings.push({
        commentId: comment.id,
        check: "revision-numbering",
        detail: `revision_no is not dense and 1-based: [${actual.join(", ")}]`,
      });
    }

    // 3. Revision 1 is the comment's own creation time. Written by the same
    //    transaction, or by a backfill that copied created_at, so exact
    //    equality is the honest comparison rather than a tolerance.
    const first = revisions[0];
    if (first.createdAt.getTime() !== comment.createdAt.getTime()) {
      findings.push({
        commentId: comment.id,
        check: "posted-at",
        detail:
          `revision 1 is stamped ${first.createdAt.toISOString()} but the comment was created ` +
          `${comment.createdAt.toISOString()} — the grace window would be measured from the wrong moment`,
      });
    }

    // 4. editedAt agrees with the revision count. An edited comment has more
    //    than one revision and vice versa; either half failing means one of
    //    the two writers ran without the other.
    const edited = comment.editedAt !== null;
    if (edited !== (revisions.length > 1)) {
      findings.push({
        commentId: comment.id,
        check: "edited-at",
        detail: edited
          ? `edited_at is set but there is only one revision`
          : `there are ${revisions.length} revisions but edited_at is null`,
      });
    }

    if (verbose && !findings.some((f) => f.commentId === comment.id)) {
      console.log(`  ok    ${comment.id} — ${revisions.length} revision(s)`);
    }
  }

  console.log(`\n${comments.length} comment(s) checked — ${findings.length} finding(s)`);
  for (const finding of findings) {
    console.log(`  ERROR ${finding.commentId} [${finding.check}]\n          ${finding.detail}`);
  }

  await prisma.$disconnect();
  process.exit(findings.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
