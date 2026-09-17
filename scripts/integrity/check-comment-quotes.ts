// Verifies the pair PLAN.md §23f rests on, for every `comment_quote_anchor`
// row: the quoting body's span that names the row carries exactly the row's
// `quoted_text`, and `quoted_text` is exactly what the target says at the
// pinned version. Three copies of one string, and this is the check that they
// have not drifted.
//
// Why a check at all: the row is written once, at post or edit time, from a
// verified match (comment-quote-capture.ts), so a divergence is a fault
// somewhere in that path — or in a later edit of the quoting comment that
// rewrote the body without re-running the capture. Nothing recomputes any of
// it on read: the body renders its own words with no join (§23f's reason),
// and the citation line is resolved from the row, so a body whose blockquote
// no longer matches its row would render as if nothing were wrong.
//
// Substrates (§23d): a post target is checked against the pinned
// publication event's prose_json; a comment target against the pinned
// revision's body. Both immutable, so "exact, forever" is the standard.
// Doc, file and annotation targets have no writer (§23e) and are reported
// as WARN if a row exists at all.
//
// Reads only, no transaction, safe to run any time.
//
// Usage:
//   npx tsx scripts/integrity/check-comment-quotes.ts [--post <id>] [--verbose]
//
// Exits non-zero on any ERROR.

import "dotenv/config";
import type { JSONContent } from "@tiptap/core";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";
import { pmCommentContentSchema, pmSchema } from "../../src/lib/tiptap-schema";
import { targetFromColumns } from "../../src/lib/anchors";
import { quotedTextAt } from "../../src/lib/comment-quote-match";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const postIndex = args.indexOf("--post");
const postId = postIndex >= 0 ? args[postIndex + 1] : null;

type Finding = { anchorId: string; commentId: string; level: "ERROR" | "WARN"; check: string; detail: string };

/** The words the quoting body carries for one anchor id — a blockquote's textblocks, or a quote mark's run. */
function bodySpanText(body: JSONContent, anchorId: string): string | null {
  let found: string | null = null;
  try {
    const node = pmCommentContentSchema.nodeFromJSON(body);
    node.descendants((child, pos) => {
      if (found !== null) return false;
      if (child.type.name === "blockquote" && child.attrs.anchorId === anchorId) {
        found = child.textBetween(0, child.content.size, " ", " ");
        return false;
      }
      if (child.isText && child.marks.some((m) => m.type.name === "quote" && m.attrs.anchorId === anchorId)) {
        // Gather the whole run — adjacent text nodes may share the mark.
        let text = "";
        node.nodesBetween(pos, node.content.size, (n) => {
          if (n.isText && n.marks.some((m) => m.type.name === "quote" && m.attrs.anchorId === anchorId)) {
            text += n.text ?? "";
            return false;
          }
          return text === "";
        });
        found = text;
        return false;
      }
      return true;
    });
  } catch {
    return null;
  }
  return found;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

async function main() {
  const rows = await prisma.commentQuoteAnchor.findMany({
    where: postId ? { comment: { thread: { postId } } } : {},
    orderBy: [{ commentId: "asc" }, { partOrder: "asc" }],
    select: {
      id: true,
      commentId: true,
      docId: true,
      postId: true,
      fileId: true,
      targetAnnotationId: true,
      targetCommentId: true,
      selectorKind: true,
      anchorFrom: true,
      anchorTo: true,
      quotedText: true,
      anchoredEventId: true,
      quotedRevisionId: true,
      ydocUpdateId: true,
      comment: { select: { body: true } },
      anchoredEvent: { select: { proseJson: true } },
      quotedRevision: { select: { body: true } },
    },
  });

  const findings: Finding[] = [];
  let checked = 0;

  for (const row of rows) {
    const push = (level: Finding["level"], check: string, detail: string) =>
      findings.push({ anchorId: row.id, commentId: row.commentId, level, check, detail });

    const target = targetFromColumns(row);
    if (!target) {
      push("ERROR", "arc", "no single target column set (unreachable while the one-target CHECK holds)");
      continue;
    }
    if (target.kind !== "post" && target.kind !== "comment") {
      push("WARN", "substrate", `a ${target.kind} target has no writer (§23e) — this row came from somewhere else`);
      continue;
    }
    if (row.selectorKind !== "DOC_RANGE" || row.anchorFrom === null || row.anchorTo === null) {
      push("ERROR", "part", "a quotation without a DOC_RANGE part names no passage");
      continue;
    }
    checked++;

    // 1. The body carries the row's words.
    const inBody = bodySpanText(row.comment.body as JSONContent, row.id);
    if (inBody === null) {
      push("ERROR", "body-span", "the quoting body names no blockquote or quote mark with this anchor id");
    } else if (squash(inBody) !== squash(row.quotedText)) {
      push(
        "ERROR",
        "body-span",
        `body says ${JSON.stringify(inBody.slice(0, 60))}, row says ${JSON.stringify(row.quotedText.slice(0, 60))}`,
      );
    }

    // 2. The row's words are the target's, at the pinned version.
    let sourceJson: unknown = null;
    let sourceSchema = pmSchema;
    if (target.kind === "post") {
      if (!row.anchoredEventId) push("ERROR", "stamp", "a post quotation carries no anchored_event_id");
      sourceJson = row.anchoredEvent?.proseJson ?? null;
    } else {
      if (!row.quotedRevisionId) push("ERROR", "stamp", "a comment quotation carries no quoted_revision_id");
      sourceJson = row.quotedRevision?.body ?? null;
      sourceSchema = pmCommentContentSchema;
    }
    if (!sourceJson) {
      push("ERROR", "source", "the pinned version is gone (SetNull on the event, or a revision that no longer exists)");
      continue;
    }
    try {
      const source = sourceSchema.nodeFromJSON(sourceJson as JSONContent);
      if (row.anchorTo > source.content.size) {
        push("ERROR", "source-text", `anchor_to ${row.anchorTo} is past the pinned version's end (${source.content.size})`);
      } else {
        const atSource = quotedTextAt(source, row.anchorFrom, row.anchorTo);
        if (atSource !== row.quotedText) {
          push(
            "ERROR",
            "source-text",
            `pinned version says ${JSON.stringify(atSource.slice(0, 60))}, row says ${JSON.stringify(row.quotedText.slice(0, 60))}`,
          );
        }
      }
    } catch (err) {
      push("ERROR", "source", `the pinned version does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (verbose && !findings.some((f) => f.anchorId === row.id)) {
      console.log(`  ok    ${row.id} (${target.kind} ${target.id}) ${JSON.stringify(row.quotedText.slice(0, 50))}`);
    }
  }

  for (const finding of findings) {
    console.log(`  ${finding.level.padEnd(5)} ${finding.check.padEnd(12)} anchor ${finding.anchorId} on comment ${finding.commentId}: ${finding.detail}`);
  }
  const errors = findings.filter((f) => f.level === "ERROR").length;
  console.log(`\n${checked} quotation(s) checked of ${rows.length} row(s) — ${errors} error(s), ${findings.length - errors} warning(s)`);
  process.exitCode = errors > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
