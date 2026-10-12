import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { canUserEditDoc, canUserReadDoc } from "@/lib/doc-authz";
import { resolveDocParam, resolveDocSlugHistory } from "@/lib/resolve-doc-param";
import { setDocByline, setDocDeleted, setDocRecord, setDocSlug, setDocVisibility } from "@/lib/doc-manage";
import { displayNameOf } from "@/lib/display-name";
import { invalid, notFound } from "@/lib/api/errors";
import { defineTool, objectRef, type McpContext, type ToolResult } from "../tool";
import { parse } from "../resolve";

// docs/MCP.md §3, §15 — `manage`: what changes who can see something, or
// takes it away. A doc's or file's visibility, slug, byline or owners, and
// whether a doc is a record; tagging a published or scheduled post; deleting
// or restoring a doc, file, annotation or link.
//
// **The `manage` scope, which Claude's token never has**: Claude reads text
// other people wrote, public commenters included, and an instruction planted
// there must not be able to change who can see something. It forces a prompt
// in Claude Code on every call: an audience that has been widened has
// already seen the doc, and someone taken off a PRIVATE byline can't get
// back in.

const input = z.strictObject({
  target: objectRef.describe("The doc, file, annotation or link to change."),
  visibility: z.enum(["PRIVATE", "SHARED"]).optional(),
  slug: z.string().min(1).max(200).optional(),
  byline: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(20)
    .optional()
    .describe("A doc's whole byline, in order, as user ids from find_users."),
  allowRemovals: z
    .boolean()
    .optional()
    .describe("Let byline or owners leave someone off — which takes away their access to a PRIVATE doc or file."),
  record: z.boolean().optional().describe("Whether a doc is a record (an imported chat), which edit_doc refuses."),
  delete: z.boolean().optional().describe("Soft-delete it."),
  restore: z.boolean().optional().describe("Restore a soft-deleted one."),
});

/** A doc for `manage`: found through past slugs and deleted rows alike, and not_found to anyone who can neither read nor edit it. */
async function managedDoc(ctx: McpContext, param: string): Promise<{ id: string; slug: string } | null> {
  const select = { id: true, slug: true, visibility: true, deletedByUserId: true } as const;
  let doc = await resolveDocParam(param, select);
  if (!doc) {
    const moved = await resolveDocSlugHistory(param);
    doc = moved ? await resolveDocParam(moved.id, select) : null;
  }
  if (!doc) return null;
  const visible =
    (doc.deletedByUserId === null && (await canUserReadDoc(ctx.actor.userId, ctx.actor.role, doc))) ||
    (await canUserEditDoc(ctx.actor.userId, ctx.actor.role, doc.id, { includeDeleted: true }));
  return visible ? { id: doc.id, slug: doc.slug } : null;
}

async function manageDoc(ctx: McpContext, docId: string, args: z.infer<typeof input>): Promise<ToolResult> {
  const changed: string[] = [];
  if (args.restore) {
    await setDocDeleted(ctx.actor, docId, false);
    changed.push("restored");
  }
  if (args.visibility !== undefined) {
    await setDocVisibility(ctx.actor, docId, args.visibility);
    changed.push("visibility");
  }
  if (args.byline !== undefined) {
    await setDocByline(ctx.actor, docId, args.byline, { allowRemovals: args.allowRemovals });
    changed.push("byline");
  }
  if (args.record !== undefined) {
    await setDocRecord(ctx.actor, docId, args.record);
    changed.push("record");
  }
  let slug: string | null = null;
  if (args.slug !== undefined) {
    slug = await setDocSlug(ctx.actor, docId, args.slug);
    changed.push("slug");
  }
  if (args.delete) {
    await setDocDeleted(ctx.actor, docId, true);
    changed.push("deleted");
  }
  const doc = await prisma.doc.findFirst({
    where: { id: docId },
    select: {
      slug: true,
      visibility: true,
      record: true,
      deletedAt: true,
      authors: { orderBy: { bylineOrder: "asc" }, select: { user: { select: { name: true } } } },
    },
  });
  return {
    url: `/doc/${slug ?? doc?.slug}`,
    changed,
    ...(doc
      ? {
          visibility: doc.visibility,
          byline: doc.authors.map((a) => displayNameOf(a.user)).join(", "),
          ...(doc.record ? { record: true } : {}),
        }
      : { deleted: true }),
  };
}

export const manageTool = defineTool({
  name: "manage",
  scope: "MANAGE",
  description:
    "Change who can see or reach something, or take it away: a doc's visibility, slug, byline (ordered user ids from find_users; allowRemovals to leave someone off, which takes a PRIVATE doc away from them) and record flag; delete or restore. Each call prompts the person, whatever their settings. Prefer leaving these to a person in MultiBlog itself.",
  input,
  output: z.looseObject({ url: z.string(), changed: z.array(z.string()) }),
  readOnly: false,
  destructive: true,
  forcePrompt: true,
  searchHint: "visibility share private byline owners slug delete restore record manage",
  async run(args, ctx) {
    if (args.delete && args.restore) throw invalid("delete and restore undo each other; send one.");
    const fields = ["visibility", "slug", "byline", "record", "delete", "restore"] as const;
    if (!fields.some((field) => args[field] !== undefined)) throw invalid("Say what to change.");
    const parsed = parse(args.target);
    const param = parsed.kind === "doc" ? parsed.param : parsed.kind === "id" ? parsed.id : null;
    if (param === null) throw invalid("manage takes a doc for now: /doc/<slug> or its id.");
    const doc = await managedDoc(ctx, param);
    if (!doc) throw notFound("That doc");
    return manageDoc(ctx, doc.id, args) as Promise<never>;
  },
});
