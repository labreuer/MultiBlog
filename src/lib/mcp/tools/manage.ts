import { z } from "zod";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canUserEditDoc, canUserReadDoc } from "@/lib/doc-authz";
import { canUserManageFile, canUserReadFile } from "@/lib/file-authz";
import { resolveDocParam, resolveDocSlugHistory } from "@/lib/resolve-doc-param";
import { resolveFileParam } from "@/lib/file-slug";
import { setDocByline, setDocDeleted, setDocRecord, setDocSlug, setDocVisibility } from "@/lib/doc-manage";
import { setFileDeleted, setFileOwners, setFileSlug, setFileVisibility } from "@/lib/file-manage";
import { setAnnotationDeleted } from "@/lib/annotation-manage";
import { setLinkDeleted } from "@/lib/anchored-link-write";
import { displayNameOf } from "@/lib/display-name";
import { invalid, notFound } from "@/lib/api/errors";
import { defineTool, objectRef, type McpContext, type ToolResult } from "../tool";
import { parse } from "../resolve";
import { isViewerFragment } from "../url";
import { annotationByFragment } from "../read/threads";
import { resolveTagTarget, tagFor } from "../tag-writes";

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

const people = z.array(z.string().min(1).max(64)).min(1).max(20);

const input = z.strictObject({
  target: objectRef.describe("The doc, file, post, annotation or link to change."),
  visibility: z.enum(["PRIVATE", "SHARED"]).optional().describe("A doc's or file's."),
  slug: z.string().min(1).max(200).optional().describe("A doc's or file's."),
  byline: people.optional().describe("A doc's whole byline, in order, as user ids from find_users."),
  owners: people.optional().describe("A file's whole owner list, in order, as user ids from find_users."),
  allowRemovals: z
    .boolean()
    .optional()
    .describe("Let byline or owners leave someone off — which takes away their access to a PRIVATE doc or file."),
  record: z.boolean().optional().describe("Whether a doc is a record (an imported chat), which edit_doc refuses."),
  tags: z.array(z.string().min(1).max(80)).min(1).max(20).optional().describe("Terms to put on a published or scheduled post."),
  delete: z.boolean().optional().describe("Soft-delete it."),
  restore: z.boolean().optional().describe("Restore a soft-deleted one."),
});
type Args = z.infer<typeof input>;

const FIELDS = ["visibility", "slug", "byline", "owners", "record", "tags", "delete", "restore"] as const;
const ALLOWED: Record<"doc" | "file" | "post" | "annotation" | "link", readonly (typeof FIELDS)[number][]> = {
  doc: ["visibility", "slug", "byline", "record", "delete", "restore"],
  file: ["visibility", "slug", "owners", "delete", "restore"],
  post: ["tags"],
  annotation: ["delete", "restore"],
  link: ["delete", "restore"],
};

function onlyFieldsFor(kind: keyof typeof ALLOWED, args: Args) {
  const stray = FIELDS.filter((field) => args[field] !== undefined && !ALLOWED[kind].includes(field));
  if (stray.length > 0) throw invalid(`A ${kind} takes ${ALLOWED[kind].join(", ")}; not ${stray.join(", ")}.`);
}

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

/** A file likewise: by id, or by slug (live first, then past slugs, then a deleted row holding it). */
async function managedFile(ctx: McpContext, param: string): Promise<{ id: string } | null> {
  const select = { id: true, visibility: true, deletedByUserId: true } as const;
  const file =
    (await prismaIncludingDeleted.storedFile.findUnique({ where: { id: param }, select })) ?? (await resolveFileParam(param, select))?.file ?? null;
  if (!file) return null;
  const visible =
    (file.deletedByUserId === null && (await canUserReadFile(ctx.actor.userId, ctx.actor.role, file))) ||
    (await canUserManageFile(ctx.actor.userId, ctx.actor.role, file.id));
  return visible ? { id: file.id } : null;
}

async function manageDoc(ctx: McpContext, docId: string, args: Args): Promise<ToolResult> {
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
      authors: { orderBy: { bylineOrder: "asc" }, select: { user: { select: { name: true } } } },
    },
  });
  const after = slug ?? doc?.slug ?? (await prismaIncludingDeleted.doc.findUnique({ where: { id: docId }, select: { slug: true } }))?.slug;
  return {
    url: `/doc/${after}`,
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

async function manageFile(ctx: McpContext, fileId: string, args: Args): Promise<ToolResult> {
  const changed: string[] = [];
  const notes: string[] = [];
  if (args.restore) {
    const restored = await setFileDeleted(ctx.actor, fileId, false);
    changed.push("restored");
    if (restored.renamedFrom) notes.push(`Its url was taken while it was deleted, so it is now ${restored.slug}.`);
  }
  if (args.visibility !== undefined) {
    await setFileVisibility(ctx.actor, fileId, args.visibility);
    changed.push("visibility");
  }
  if (args.owners !== undefined) {
    await setFileOwners(ctx.actor, fileId, args.owners, { allowRemovals: args.allowRemovals });
    changed.push("owners");
  }
  if (args.slug !== undefined) {
    await setFileSlug(ctx.actor, fileId, args.slug);
    changed.push("slug");
  }
  if (args.delete) {
    await setFileDeleted(ctx.actor, fileId, true);
    changed.push("deleted");
  }
  const file = await prismaIncludingDeleted.storedFile.findUnique({
    where: { id: fileId },
    select: {
      slug: true,
      visibility: true,
      pageCount: true,
      deletedAt: true,
      owners: { orderBy: { ownerOrder: "asc" }, select: { user: { select: { name: true } } } },
    },
  });
  return {
    url: `/${file?.pageCount !== null ? "pdf" : "files"}/${file?.slug}`,
    changed,
    visibility: file?.visibility,
    owners: file?.owners.map((o) => displayNameOf(o.user)).join(", "),
    ...(file?.deletedAt ? { deleted: true } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** An annotation by id or card URL, found deleted or not, and not_found to anyone who can't read it. */
async function managedAnnotation(ctx: McpContext, ref: string): Promise<string | null> {
  const parsed = parse(ref);
  let id: string | null = null;
  if (parsed.kind === "id") id = parsed.id;
  else if (parsed.kind === "doc" && parsed.fragment) {
    const doc = await managedDoc(ctx, parsed.param);
    id = doc ? await annotationByFragment({ docId: doc.id }, parsed.fragment) : null;
  } else if (parsed.kind === "pdf" && parsed.fragment && !isViewerFragment(parsed.fragment)) {
    const file = await managedFile(ctx, parsed.slug);
    id = file ? await annotationByFragment({ fileId: file.id }, parsed.fragment) : null;
  }
  if (!id) return null;
  const annotation = await prisma.annotation.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, doc: { select: { id: true, visibility: true } }, file: { select: { id: true, visibility: true } } },
  });
  if (!annotation) return null;
  // Readable as its container is, and a DRAFT as its writer's alone.
  const readable =
    annotation.status === "DRAFT"
      ? annotation.userId === ctx.actor.userId
      : annotation.doc
        ? await canUserReadDoc(ctx.actor.userId, ctx.actor.role, annotation.doc)
        : annotation.file
          ? await canUserReadFile(ctx.actor.userId, ctx.actor.role, annotation.file)
          : false;
  return readable ? annotation.id : null;
}

export const manageTool = defineTool({
  name: "manage",
  scope: "MANAGE",
  description:
    "Change who can see or reach something, or take it away: a doc's or file's visibility and slug; a doc's byline or a file's owners (ordered user ids from find_users; allowRemovals to leave someone off, which takes a PRIVATE one away from them); whether a doc is a record; tags on a published or scheduled post; delete or restore a doc, file, annotation or link. Each call prompts the person, whatever their settings. Prefer leaving these to a person in MultiBlog itself.",
  input,
  output: z.looseObject({ changed: z.array(z.string()) }),
  readOnly: false,
  destructive: true,
  forcePrompt: true,
  searchHint: "visibility share private byline owners slug delete restore record publish tag manage",
  run: (args, ctx) => runManage(ctx, args) as Promise<never>,
});

async function runManage(ctx: McpContext, args: Args): Promise<ToolResult> {
  if (args.delete && args.restore) throw invalid("delete and restore undo each other; send one.");
  if (!FIELDS.some((field) => args[field] !== undefined)) throw invalid("Say what to change.");
  const parsed = parse(args.target);

  if (parsed.kind === "link" || (parsed.kind === "id" && (await prisma.anchoredLink.findUnique({ where: { id: parsed.id }, select: { id: true } })))) {
    onlyFieldsFor("link", args);
    const id = parsed.kind === "link" ? parsed.id : (parsed as { id: string }).id;
    if (!(await prisma.anchoredLink.findUnique({ where: { id }, select: { id: true } }))) throw notFound("That link");
    await setLinkDeleted(ctx.actor, id, !!args.delete);
    return { url: `/link/${id}`, changed: [args.delete ? "deleted" : "restored"] };
  }
  if (parsed.kind === "post" || parsed.kind === "post-id") {
    if (parsed.fragment) throw invalid("manage tags a post itself, not a comment on it.");
    onlyFieldsFor("post", args);
    const resolved = await resolveTagTarget(ctx, args.target);
    const result = await tagFor(ctx, resolved, args.tags!);
    return { ...result, changed: ["tags"] };
  }
  const isAnnotationRef =
    (parsed.kind === "doc" && parsed.fragment !== "") ||
    (parsed.kind === "pdf" && parsed.fragment !== "" && !isViewerFragment(parsed.fragment)) ||
    (parsed.kind === "id" && (await prisma.annotation.findUnique({ where: { id: parsed.id }, select: { id: true } })) !== null);
  if (isAnnotationRef) {
    onlyFieldsFor("annotation", args);
    const id = await managedAnnotation(ctx, args.target);
    if (!id) throw notFound("That annotation");
    await setAnnotationDeleted(ctx.actor, id, !!args.delete);
    return { id, changed: [args.delete ? "deleted" : "restored"] };
  }
  if (parsed.kind === "pdf" || parsed.kind === "file") {
    onlyFieldsFor("file", args);
    const file = await managedFile(ctx, parsed.slug);
    if (!file) throw notFound("That file");
    return manageFile(ctx, file.id, args);
  }
  if (parsed.kind === "doc" || parsed.kind === "id") {
    const param = parsed.kind === "doc" ? parsed.param : parsed.id;
    const doc = await managedDoc(ctx, param);
    if (doc) {
      onlyFieldsFor("doc", args);
      return manageDoc(ctx, doc.id, args);
    }
    if (parsed.kind === "id") {
      const file = await managedFile(ctx, parsed.id);
      if (file) {
        onlyFieldsFor("file", args);
        return manageFile(ctx, file.id, args);
      }
      if (await prisma.post.findUnique({ where: { id: parsed.id }, select: { id: true } })) {
        return runManage(ctx, { ...args, target: `/post/${parsed.id}/edit` });
      }
    }
    throw notFound(parsed.kind === "doc" ? "That doc" : "Anything with that id");
  }
  throw invalid("manage takes a doc, a file, a post, an annotation (its id or card URL) or a link.");
}
