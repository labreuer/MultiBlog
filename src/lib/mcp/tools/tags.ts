import { z } from "zod";
import { MAX_TAG_NAME_LENGTH } from "@/lib/tag-write";
import { defineTool, objectRef } from "../tool";
import { tagToolFor, untagFor } from "../tag-writes";

// docs/MCP.md §11, §15 — tag and untag. A repeat changes nothing more by the
// write's nature (a term is found by name, an assignment by tagger), so
// neither takes an idempotency key.

const target = objectRef.describe(
  "What to tag: a doc, a PDF or file, a draft post, an annotation (its id or card URL) or a comment (its card URL).",
);
const tags = z.array(z.string().min(1).max(MAX_TAG_NAME_LENGTH)).min(1).max(20);

export const tagTool = defineTool({
  name: "tag",
  scope: "WRITE",
  description:
    "Tag something with terms by name; a name no term has yet mints one (find_tags shows the vocabulary — prefer an existing term). Not a published or scheduled post: its tags are public at once, and only a person's manage token tags one.",
  input: z.strictObject({ target, tags: tags.describe("Term names; new ones are minted.") }),
  output: z.looseObject({ target: z.string() }),
  readOnly: false,
  destructive: false,
  searchHint: "tag label term categorize",
  async run(args, ctx) {
    return tagToolFor(ctx, args) as Promise<never>;
  },
});

export const untagTool = defineTool({
  name: "untag",
  scope: "WRITE",
  description:
    "Remove your own tags from something, by term name or slug; anyone:true removes everyone's, for an admin or editor. Tagging again puts one back.",
  input: z.strictObject({ target, tags, anyone: z.boolean().optional() }),
  output: z.looseObject({ target: z.string(), removed: z.array(z.string()) }),
  readOnly: false,
  destructive: true,
  searchHint: "untag remove tag term",
  async run(args, ctx) {
    return untagFor(ctx, args) as Promise<never>;
  },
});
