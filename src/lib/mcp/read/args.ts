import { z } from "zod";
import { objectRef, versionString } from "../tool";

// docs/MCP.md §15 — `read`'s arguments. The tool's description is cut at
// 2,048 characters and its schema reaches the model whole, so the detail of
// each URL form and option lives here, on its parameter.

/** A writer, by author slug, or `true` for the actor alone in `awaiting`. */
const slugList = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "an author slug")).min(1).max(20);

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day, YYYY-MM-DD");

export const threadsFilter = z
  .strictObject({
    by: slugList.optional().describe("Threads with an entry by any of these writers."),
    notBy: slugList.optional().describe("Threads none of these writers has touched."),
    awaiting: z
      .union([z.literal(true), slugList])
      .optional()
      .describe("Threads whose latest activity is by none of these writers; true means you. The reply queue."),
    activeSince: dayString.optional().describe("Threads with a post, or an edit readers are told about, on or after this day."),
    status: z.enum(["LIVE", "RAISED"]).optional(),
    limit: z.number().int().min(1).max(100).optional().describe("Threads per page, 20 by default."),
    cursor: z.string().max(200).optional(),
  })
  .describe("Filters and paging for the annotation threads `include` asks for, or that /annotations lists.");

export const listPaging = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(200).optional(),
});

export const readInput = z.strictObject({
  url: objectRef.describe(
    "What to read: /doc/<slug> (or its id, or /edit); /pdf/<slug>, with #page=N for a page or a fragment link's #page=N&text=… for its passage; /files/<slug>; /annotations; /link/<id> or a URL with ?sel=<id>; a doc or PDF URL with an annotation card's #fragment for that thread; a post's path or /post/<id>/edit, with a comment card's #fragment for that comment; /tag/<slug>; /authors/<slug>. Past slugs work.",
  ),
  format: z.enum(["markdown", "text"]).optional().describe("Doc and post bodies: markdown (default), or text, which a quote can be copied from exactly."),
  whole: z.boolean().optional().describe("A doc whole up to 200,000 characters; without it, one over 40,000 answers with its outline."),
  outline: z.boolean().optional().describe("The outline even when the doc is short."),
  depth: z.number().int().min(1).max(6).optional().describe("Outline levels to keep, counted from the shallowest; for a doc or a PDF."),
  section: z
    .union([z.string().min(1).max(500), z.number().int().min(1)])
    .optional()
    .describe("A doc section by its heading's text or block number; with outline:true, the headings inside it."),
  from: z.number().int().min(1).optional().describe("First block, numbered as the outline numbers them."),
  to: z.number().int().min(1).optional().describe("Last block, inclusive."),
  around: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("Every occurrence of this quote, with the blocks (doc) or ~300 characters (PDF) around it: whether, and where, it really is."),
  prefix: z.string().max(500).optional().describe("With around: words just before the quote."),
  suffix: z.string().max(500).optional().describe("With around: words just after the quote."),
  context: z.number().int().min(0).max(5).optional().describe("With around, on a doc: blocks either side, 1 by default."),
  occurrences: z.number().int().min(1).max(10).optional().describe("With around: how many occurrences, 5 by default."),
  since: versionString.optional().describe("What changed in a doc since this version: each changed block as a word diff naming who added what."),
  page: z.number().int().min(1).optional().describe("A PDF page by its 1-based sheet number."),
  pages: z
    .string()
    .regex(/^\d+(-\d+)?$/, "N or N-M")
    .optional()
    .describe("A range of PDF sheets, N-M."),
  label: z.string().min(1).max(50).optional().describe("Every PDF page carrying this printed label."),
  entry: z.string().min(1).max(500).optional().describe("A PDF outline entry, by title: its pages' text."),
  include: z
    .array(z.enum(["annotations", "links", "comments"]))
    .min(1)
    .max(3)
    .optional()
    .describe("What hangs off a doc or PDF (annotations, links into it) or a post (comments), each paged on its own."),
  threads: threadsFilter.optional(),
  links: listPaging.optional().describe("Paging for include:[\"links\"]."),
  history: z.boolean().optional().describe("A comment's or annotation's earlier versions, as readers are shown them."),
});

export type ReadArgs = z.infer<typeof readInput>;

/** The bound on a read with no range, about 10,000 tokens (docs/MCP.md §4). */
export const DEFAULT_READ_CHARS = 40_000;
/** The bound itself, `whole: true` and any range: what `read` declares as its maximum result size. */
export const MAX_READ_CHARS = 200_000;
