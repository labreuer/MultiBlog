import { z } from "zod";
import { onceWithin } from "@/lib/api/idempotency";
import { findReferences } from "@/lib/reference-data";
import { createReference, referencePath } from "@/lib/reference-write";
import { entryText } from "@/lib/references/entry";
import { defineTool, listedName } from "../tool";

// docs/CITATIONS.md, "MCP" — the reference library from a machine client:
// look a work up, and add one. Editing a reference stays in the UI.

const MAX_RESULTS = 20;

export const findReferencesTool = defineTool({
  name: "find_refs",
  scope: "READ",
  description:
    "Look up works in the reference library — books, articles and chapters that can be cited — by key, title, author, year, or an exact DOI or ISBN. Answers each one's key, its bibliography entry and its page. Look here before adding a work: the library holds each one once.",
  input: z.strictObject({ query: z.string().min(1).max(200).describe("Words of a key, title or author's name; or a DOI or ISBN.") }),
  output: z.object({
    references: z.array(
      z.object({ key: z.string(), entry: z.string(), url: z.string(), short: z.string().optional(), hasFile: z.boolean().optional() }),
    ),
  }),
  readOnly: true,
  destructive: false,
  searchHint: "reference citation bibliography book article work DOI ISBN library",
  async run(args) {
    const found = await findReferences(args.query, MAX_RESULTS);
    return {
      references: found.map((reference) => ({
        key: reference.key,
        entry: entryText(reference.item),
        url: referencePath(reference.key),
        ...(reference.short ? { short: reference.short } : {}),
        ...(reference.fileId ? { hasFile: true } : {}),
      })),
    };
  },
});

const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe("Only to repeat a write on purpose: any string not used before. A repeat without one is refused as already_done.");

export const createReferenceTool = defineTool({
  name: "create_ref",
  scope: "WRITE",
  description: `Add a work to the reference library, from its CSL-JSON record. Search with ${listedName("find_refs")} first: a work already there is refused as duplicate, by its DOI or ISBN, with the key to use instead. A DOI or ISBN that fails its check is refused as invalid. Answers the key the work was given.`,
  input: z.strictObject({
    csl: z
      .looseObject({ type: z.string().optional(), title: z.string() })
      .describe(
        'A CSL-JSON item: type (book, chapter, article-journal, …), title, author and editor as [{family, given}], issued as {"date-parts": [[year]]}, container-title, publisher, publisher-place, volume, issue, page, DOI, ISBN, URL.',
      ),
    key: z.string().min(1).max(80).optional().describe("The citation key, such as radner2012; made from the first author and the year when absent."),
    short: z.string().min(1).max(40).optional().describe("An abbreviation a short citation shows, such as BU."),
    idempotencyKey,
  }),
  output: z.object({ key: z.string(), url: z.string(), entry: z.string() }),
  readOnly: false,
  destructive: false,
  searchHint: "add reference citation bibliography book article work library",
  async run(args, ctx) {
    const { idempotencyKey: key, ...rest } = args;
    return onceWithin(ctx.token.id, "create_ref", rest, key, async () => {
      const created = await createReference(ctx.actor, { csl: rest.csl, key: rest.key, short: rest.short });
      const [reference] = await findReferences(created.key, 1);
      return { key: created.key, url: referencePath(created.key), entry: reference ? entryText(reference.item) : "" };
    }) as Promise<never>;
  },
});
