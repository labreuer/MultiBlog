import { z } from "zod";
import { MAX_MARKDOWN_BYTES } from "@/lib/markdown-import";
import { onceWithin } from "@/lib/api/idempotency";
import { invalid } from "@/lib/api/errors";
import { defineTool, objectRef, versionString } from "../tool";
import { createDocFor, editDocFor, revertEditFor } from "../doc-writes";

// docs/MCP.md §6 — create_doc and edit_doc. Both add text, so both are
// refused as `already_done` when they repeat within a day (§4), unless the
// caller passes an idempotencyKey of its own to repeat one on purpose.

const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Only to repeat a write on purpose: any string not used before. A repeat without one is refused as already_done.");

const markdown = z.string().max(MAX_MARKDOWN_BYTES);

export const createDocTool = defineTool({
  name: "create_doc",
  scope: "WRITE",
  description:
    "Create a doc from Markdown. It is PRIVATE, with you first and the token's issuer second on its byline (issuerOnly: the issuer alone), and its text shows in your author colour. The title is `title`, or the Markdown's leading heading. Open a research summary with the prompt quoted; link whole docs as /doc/<slug>, sections with links from create_link, PDF passages with fragment links (/pdf/<slug>#page=N&text=start,end) — those are checked, and a miss is refused as no_match. For a long draft in a local file, use upload_url instead of typing it here. Answers the doc's url and version.",
  input: z.strictObject({
    markdown: markdown.min(1),
    title: z.string().min(1).max(500).optional(),
    issuerOnly: z.boolean().optional().describe("Leave yourself off the byline: the issuer alone, when they ask."),
    idempotencyKey,
  }),
  output: z.object({
    url: z.string(),
    id: z.string(),
    title: z.string(),
    byline: z.string(),
    visibility: z.string(),
    version: z.string().nullable(),
    warnings: z.array(z.string()).optional(),
  }),
  readOnly: false,
  destructive: false,
  searchHint: "new doc write markdown summary research notes",
  async run(args, ctx) {
    const { idempotencyKey: key, ...rest } = args;
    return onceWithin(ctx.token.id, "create_doc", rest, key, () => createDocFor(ctx, rest)) as Promise<never>;
  },
});

const passage = z.union([
  z.string().min(1).max(20_000).describe("The exact words, as a text read shows them."),
  z.strictObject({ start: z.string().min(1).max(500), end: z.string().min(1).max(500) }).describe("A long passage by its first and last words."),
]);

const editItem = z.union([
  z.strictObject({
    old: passage,
    new: markdown.describe("Markdown; empty deletes the passage."),
    prefix: z.string().max(500).optional(),
    suffix: z.string().max(500).optional(),
    acrossHeadings: z.boolean().optional().describe("Let a passage named by its ends run across a heading."),
  }),
  z.strictObject({ append: markdown.min(1) }),
  z.strictObject({
    insert: markdown.min(1),
    after: z.union([z.string().min(1).max(500), z.number().int().min(1)]).describe("A heading's text or block number."),
    atEnd: z.boolean().optional().describe("At the end of that heading's section rather than just under it."),
  }),
]);

export const editDocTool = defineTool({
  name: "edit_doc",
  scope: "WRITE",
  description:
    "Targeted edits to a doc you're on the byline of — never a whole-body replace. Each edit replaces a passage (old: its exact words, or {start,end} for a long one; prefix/suffix when it occurs twice) with new Markdown, appends, or inserts after a heading; title sets the title. Words that survive keep their marks — a note's highlight, a person's colour, a link; new words are yours and keep the notes of the words they replace. All-or-nothing: a passage that isn't there is no_match with near misses, one that occurs twice ambiguous. A passage named by its ends needs `version`, the read's, and is refused if someone changed it since. Answers the new version, the blocks changed (read them to check), and the notes and link parts it touched, saying whether each still resolves — acting on a note means replying to it with annotate: what was done, and a link. revert:<version> undoes one edit, dryRun:true lists its hunks first. Records (imported chats) can't be edited.",
  input: z.strictObject({
    url: objectRef.describe("The doc: /doc/<slug> or its id."),
    version: versionString.optional().describe("The version you read the passages at; needed for any named by start and end."),
    edits: z.array(editItem).min(1).max(50).optional(),
    title: z.string().max(500).optional(),
    revert: versionString.optional().describe("An edit's version, as edit_doc answered it: undo that edit."),
    hunks: z.array(z.number().int().min(1)).max(500).optional().describe("With revert: just these hunks, numbered as dryRun lists them."),
    dryRun: z.boolean().optional().describe("With revert: list the hunks, change nothing."),
    idempotencyKey,
  }),
  output: z.looseObject({}),
  readOnly: false,
  destructive: true,
  searchHint: "edit revise rewrite replace append insert title doc revert",
  async run(args, ctx) {
    if (args.revert !== undefined) {
      if (args.edits !== undefined || args.title !== undefined) throw invalid("revert undoes one edit; send it on its own.");
      if (args.dryRun) return revertEditFor(ctx, { url: args.url, revert: args.revert, dryRun: true });
      const { idempotencyKey: key, ...rest } = args;
      return onceWithin(ctx.token.id, "edit_doc", rest, key, () =>
        revertEditFor(ctx, { url: args.url, revert: args.revert!, hunks: args.hunks }),
      );
    }
    if (args.hunks !== undefined || args.dryRun !== undefined) throw invalid("hunks and dryRun go with revert.");
    const { idempotencyKey: key, ...rest } = args;
    return onceWithin(ctx.token.id, "edit_doc", rest, key, () =>
      editDocFor(ctx, { url: args.url, version: args.version, edits: args.edits, title: args.title }),
    );
  },
});
