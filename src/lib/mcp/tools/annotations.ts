import { z } from "zod";
import { onceWithin } from "@/lib/api/idempotency";
import { defineTool, objectRef, quoteFields, versionString } from "../tool";
import { annotateFor, editAnnotationFor } from "../annotation-writes";

// docs/MCP.md §9 — annotate and edit_annotation. A note Claude writes is
// LIVE, never RAISED (raising emails its body off the instance) and never
// resolved (a person's act). Acting on a note means replying to it: what was
// done, and a link to the passage or the doc it went into.

const body = z.string().min(1).max(20_000).describe("Markdown; at most 5,000 characters of text.");

export const annotateTool = defineTool({
  name: "annotate",
  scope: "WRITE",
  description:
    "Post a note (LIVE, never raised or emailed) on a doc or PDF, or reply to one. on: the doc or PDF, or an annotation's id or card URL to reply to it. With a quote (its exact words, or start and end for a long passage; prefix/suffix when it repeats) the note anchors on that passage — on a doc, at `version`, the read's; on a PDF, optionally narrowed by page or label; in a reply, inside the parent's body. Without one it is on the whole doc, or answers its parent as a whole. A quote that isn't there is no_match with near misses, never a note on the whole. When you act on someone's note — edit the passage, write a doc from it — reply to it saying what was done, with a link.",
  input: z.strictObject({
    on: objectRef.describe("The doc or PDF, or the annotation to reply to (its id, or its card URL)."),
    body,
    ...quoteFields,
    version: versionString.optional().describe("On a doc: the version you read the quote at."),
    page: z.number().int().min(1).optional().describe("On a PDF: the 1-based sheet the quote is on."),
    label: z.string().min(1).max(50).optional().describe("On a PDF: the printed label of the page the quote is on."),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
  output: z.looseObject({ id: z.string(), card: z.string() }),
  readOnly: false,
  destructive: false,
  searchHint: "note annotation comment reply quote passage highlight",
  async run(args, ctx) {
    const { idempotencyKey, ...rest } = args;
    return onceWithin(ctx.token.id, "annotate", rest, idempotencyKey, () => annotateFor(ctx, rest)) as Promise<never>;
  },
});

export const editAnnotationTool = defineTool({
  name: "edit_annotation",
  scope: "WRITE",
  description:
    "Rewrite a posted annotation you wrote: the new body in Markdown, recorded as its next version (every version is kept, and an edit made in the first three minutes after posting isn't marked as one). Words that survive keep their marks.",
  input: z.strictObject({ id: z.string().min(1).max(64).describe("The annotation's id."), body }),
  output: z.looseObject({ id: z.string(), card: z.string() }),
  readOnly: false,
  destructive: true,
  searchHint: "annotation note edit reword revise",
  async run(args, ctx) {
    return editAnnotationFor(ctx, args) as Promise<never>;
  },
});
