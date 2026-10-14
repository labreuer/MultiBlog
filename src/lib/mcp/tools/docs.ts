import { z } from "zod";
import { MAX_MARKDOWN_BYTES } from "@/lib/markdown-import";
import { onceWithin } from "@/lib/api/idempotency";
import { invalid } from "@/lib/api/errors";
import { defineTool, listedName, objectRef, versionString } from "../tool";
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
  description: (who) => {
    const byline = who.issuerOnByline
      ? `you, ${who.actor}, first and ${who.issuer} second — or them alone, with issuerOnly, when they ask`
      : `you, ${who.actor}`;
    return `Write a new doc from Markdown: a research summary, notes, a draft. It is PRIVATE, with ${byline} on its byline, and its text shows in your author colour. The title is \`title\`, or the Markdown's leading heading. A summary opens with the prompt that asked for it, quoted. Link a whole doc as /doc/<slug>; a section or a claim in a doc with a /link/<id> from ${listedName("create_link")}, anchored on the heading's text or the claim's sentence; a PDF passage with a fragment link, /pdf/<slug>#page=N&text=start,end. Fragment links are checked, and a miss is refused as no_match. For a long draft in a local file, ${listedName("upload")} sends it without typing it here. Answers the doc's url and version.`;
  },
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
  description: `Edit a doc you're on the byline of: revise or rewrite a passage, append, insert after a heading, retitle it, or revert an edit — targeted edits, never a whole-body replace. Each edit replaces a passage (old: its exact words, from a format:"text" read, or {start,end} for a long one; prefix/suffix when it occurs twice) with new Markdown, appends, or inserts after a heading; title sets the title. Words that survive keep their marks — a note's highlight, a person's colour, a link; new words are yours and keep the notes of the words they replace. All-or-nothing: a passage that isn't there is no_match with near misses, one that occurs twice ambiguous. A passage named by its ends needs \`version\`, the read's, and is refused if someone changed it since. Answers the new version, the blocks changed (read them to check), and the notes and link parts it touched, saying whether each still resolves. When an edit does what someone's note asked, reply to the note with ${listedName("add_note")}: what was done, and a link. revert:<version> undoes one edit, dryRun:true lists its hunks first. Records (imported chats) can't be edited.`,
  input: z.strictObject({
    url: objectRef.describe("The doc: /doc/<slug> or its id."),
    version: versionString.optional().describe("The version you read the passages at; needed for any named by start and end."),
    edits: z.array(editItem).min(1).max(50).optional(),
    title: z.string().max(500).optional(),
    revert: versionString.optional().describe(`An edit's version, as ${listedName("edit_doc")} answered it: undo that edit.`),
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
