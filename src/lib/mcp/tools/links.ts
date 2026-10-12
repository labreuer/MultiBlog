import { z } from "zod";
import { onceWithin } from "@/lib/api/idempotency";
import { LINK_NAME_MAX_LENGTH } from "@/lib/anchored-link-name";
import { defineTool, objectRef, quoteFields, versionString } from "../tool";
import { addLinkPartsFor, createLinksFor, editLinkFor } from "../link-writes";

// docs/MCP.md §10, §15 — create_link, add_link_parts, edit_link.

const part = z.strictObject({
  on: objectRef.describe("The doc or PDF the passage is in."),
  ...quoteFields,
  version: versionString.optional().describe("On a doc: the version you read the quote at."),
  page: z.number().int().min(1).optional().describe("On a PDF: the 1-based sheet the quote is on."),
  label: z.string().min(1).max(50).optional().describe("On a PDF: the printed label of the page the quote is on."),
});

const name = z.string().max(LINK_NAME_MAX_LENGTH);

export const createLinkTool = defineTool({
  name: "create_link",
  scope: "WRITE",
  description:
    "Mint anchored links — one /link/<id> URL per citation, each pointing at one or more passages in docs or PDFs, for a summary to cite before it is written. Each part is a passage by quote, as for annotate. Every part is checked first and one that isn't there refuses the call, naming it. Check read's include:[\"links\"] for a link that already anchors a passage before minting another.",
  input: z.strictObject({
    links: z
      .array(z.strictObject({ name: name.optional(), parts: z.array(part).min(1).max(20) }))
      .min(1)
      .max(50),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
  output: z.looseObject({ links: z.array(z.looseObject({ url: z.string(), parts: z.number() })) }),
  readOnly: false,
  destructive: false,
  searchHint: "cite citation anchored link passage quote mint",
  async run(args, ctx) {
    const { idempotencyKey, links } = args;
    return onceWithin(ctx.token.id, "create_link", { links }, idempotencyKey, () => createLinksFor(ctx, links)) as Promise<never>;
  },
});

export const addLinkPartsTool = defineTool({
  name: "add_link_parts",
  scope: "WRITE",
  description: "Add passages, by quote, to the end of a link you minted. Everyone following the link sees them at once.",
  input: z.strictObject({
    link: objectRef.describe("The link: its /link/<id> URL or id."),
    parts: z.array(part).min(1).max(20),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }),
  output: z.looseObject({ url: z.string(), parts: z.number() }),
  readOnly: false,
  destructive: false,
  searchHint: "anchored link add passage part",
  async run(args, ctx) {
    const { idempotencyKey, ...rest } = args;
    return onceWithin(ctx.token.id, "add_link_parts", rest, idempotencyKey, () => addLinkPartsFor(ctx, rest)) as Promise<never>;
  },
});

export const editLinkTool = defineTool({
  name: "edit_link",
  scope: "WRITE",
  description:
    "Rename a link (an empty name un-names it), or remove and reorder its parts by the numbers a read of the link shows you as its creator — order lists every part that remains. A link keeps at least one part. Nothing here keeps history, so each call prompts the person.",
  input: z.strictObject({
    link: objectRef.describe("The link: its /link/<id> URL or id."),
    name: name.optional(),
    remove: z.array(z.number().int().min(1)).max(50).optional(),
    order: z.array(z.number().int().min(1)).max(50).optional(),
  }),
  output: z.looseObject({ url: z.string(), changed: z.array(z.string()) }),
  readOnly: false,
  destructive: true,
  forcePrompt: true,
  searchHint: "anchored link rename reorder remove part",
  async run(args, ctx) {
    return editLinkFor(ctx, args) as Promise<never>;
  },
});
