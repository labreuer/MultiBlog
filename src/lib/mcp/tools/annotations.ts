import { z } from "zod";
import { MAX_MARKDOWN_BYTES } from "@/lib/markdown-import";
import { onceWithin } from "@/lib/api/idempotency";
import { defineTool, listedName, objectRef, quoteFields, versionString } from "../tool";
import { annotateFor, editAnnotationFor } from "../annotation-writes";

// docs/MCP.md §9 — add_note and edit_note. A note Claude writes is
// LIVE, never RAISED (raising emails its body off the instance) and never
// resolved (a person's act). Acting on a note means replying to it: what was
// done, and a link to the passage or the doc it went into.

const body = z.string().min(1).max(MAX_MARKDOWN_BYTES).describe("Markdown.");

export const addNoteTool = defineTool({
  name: "add_note",
  scope: "WRITE",
  description:
    `Add a note — an annotation, a comment on a passage, a highlight with words — on a doc or PDF, or reply to one. It is LIVE at once, never raised or emailed. on: the doc or PDF, or an annotation's id or card URL to reply to it. With a quote, the note anchors on that passage: a section by its heading's text, a claim by its sentence, a long passage by its first and last words (start, end), each copied from a format:"text" ${listedName("read")}; prefix/suffix when it repeats. On a doc, send \`version\`, the read's; on a PDF, page or label narrows it; in a reply, the quote is inside the parent's body. Without a quote the note is on the whole doc, or answers its parent as a whole. A quote that isn't there is no_match with near misses, never a note on the whole. When you act on someone's note — edit the passage, write a doc from it — reply to it saying what was done, with a link.`,
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
    return onceWithin(ctx.token.id, "add_note", rest, idempotencyKey, () => annotateFor(ctx, rest)) as Promise<never>;
  },
});

export const editNoteTool = defineTool({
  name: "edit_note",
  scope: "WRITE",
  description:
    "Edit, reword or revise a note you wrote — a posted annotation: the new body in Markdown, recorded as its next version. Every version is kept, and an edit made in the first three minutes after posting isn't marked as one. Words that survive keep their marks.",
  input: z.strictObject({ id: z.string().min(1).max(64).describe("The annotation's id."), body }),
  output: z.looseObject({ id: z.string(), card: z.string() }),
  readOnly: false,
  destructive: true,
  searchHint: "annotation note edit reword revise",
  async run(args, ctx) {
    return editAnnotationFor(ctx, args) as Promise<never>;
  },
});
