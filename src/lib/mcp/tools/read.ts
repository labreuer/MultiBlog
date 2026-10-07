import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { tagBySlug } from "@/lib/tag-data";
import { ApiError, invalid, notFound } from "@/lib/api/errors";
import { displayNameOf } from "@/lib/display-name";
import type { DocState } from "@/lib/doc-state";
import type { BlockSpan } from "@/lib/doc-text";
import { defineTool, type McpContext, type ToolResult } from "../tool";
import { parse, readableDocByParam, readableFileBySlug, refuseRef } from "../resolve";
import { isViewerFragment } from "../url";
import { MAX_READ_CHARS, readInput, type ReadArgs } from "../read/args";
import { readDoc } from "../read/doc";
import { readPdf } from "../read/pdf";
import { allThreads, annotationByFragment, containerThreads, oneThread } from "../read/threads";
import { linksInto, readLink } from "../read/links";
import { readPost } from "../read/posts";
import { runSearch } from "./search";

// docs/MCP.md §15, "What `read` takes" — any MultiBlog URL on this instance,
// absolute or as a path, past slugs followed as each reading route follows
// them; and an id, for what has no URL of its own (an annotation).

/** What `include` adds to a doc or PDF read, each list paged on its own (§9, §10). */
async function containerExtras(
  ctx: McpContext,
  container: { kind: "doc"; id: string; state: DocState } | { kind: "file"; id: string },
  args: ReadArgs,
  span: BlockSpan | null,
): Promise<ToolResult> {
  const include = args.include ?? [];
  if (include.includes("comments")) throw invalid("comments hang off a post; a doc or PDF includes annotations and links.");
  if (args.threads && !include.includes("annotations")) throw invalid('threads filters what include:["annotations"] lists.');
  if (args.links && !include.includes("links")) throw invalid('links pages what include:["links"] lists.');
  const out: ToolResult = {};
  if (include.includes("annotations")) {
    out.threads = await containerThreads(
      ctx,
      container.kind === "doc" ? { kind: "doc", docId: container.id, state: container.state } : { kind: "file", fileId: container.id },
      args,
      span,
    );
  }
  if (include.includes("links")) out.links = await linksInto(ctx, container, args);
  return out;
}

async function readTag(ctx: McpContext, slug: string): Promise<ToolResult> {
  let tag = await tagBySlug(slug);
  if (!tag) {
    const moved = await prisma.tagSlugHistory.findUnique({ where: { slug }, select: { tag: { select: { slug: true, deletedAt: true } } } });
    if (moved && moved.tag.deletedAt === null) tag = await tagBySlug(moved.tag.slug);
  }
  if (!tag) throw notFound("That tag");
  const listing = await runSearch(ctx, { tags: [tag.slug] });
  return {
    kind: "tag",
    url: `/tag/${tag.slug}`,
    name: tag.name,
    ...(tag.description ? { description: tag.description } : {}),
    ...listing,
  };
}

/**
 * /authors/<slug>: the person's name and slug, and what search lists for
 * them. A nameless account is never read here: its slug is made from its
 * email (user-slug.ts), and the author page names nobody without a name.
 */
async function readAuthor(ctx: McpContext, slug: string): Promise<ToolResult> {
  let user = await prisma.user.findUnique({ where: { slug }, select: { name: true, slug: true } });
  if (!user) {
    const moved = await prisma.userSlugHistory.findFirst({
      where: { slug, user: { deletedByUserId: null } },
      select: { user: { select: { name: true, slug: true } } },
    });
    user = moved?.user ?? null;
  }
  if (!user || !user.name?.trim()) throw notFound("That author");
  let listing: ToolResult;
  try {
    listing = await runSearch(ctx, { authors: [user.slug] });
  } catch (err) {
    // Not on this viewer's author picker: nothing they can read names them.
    if (err instanceof ApiError && err.code === "unknown_author") listing = { sections: [] };
    else throw err;
  }
  return { kind: "author", url: `/authors/${user.slug}`, name: displayNameOf(user), slug: user.slug, ...listing };
}

/** A bare id: an annotation's thread, a link, a doc, a file or a post — whichever kind holds it. */
async function readById(ctx: McpContext, id: string, args: ReadArgs): Promise<ToolResult> {
  const [annotation, link, doc, file, post] = await Promise.all([
    prisma.annotation.findUnique({ where: { id }, select: { id: true } }),
    prisma.anchoredLink.findUnique({ where: { id }, select: { id: true } }),
    prisma.doc.findUnique({ where: { id }, select: { id: true } }),
    prisma.storedFile.findUnique({ where: { id }, select: { id: true } }),
    prisma.post.findUnique({ where: { id }, select: { id: true } }),
  ]);
  if (annotation) return oneThread(ctx, id, args);
  if (link) return readLink(ctx, id);
  if (doc) return readDocRef(ctx, id, "", args);
  if (file) return readFileRef(ctx, id, "", args);
  if (post) return readPost(ctx, { id }, "", args);
  throw notFound("Anything with that id");
}

async function readDocRef(ctx: McpContext, param: string, fragment: string, args: ReadArgs): Promise<ToolResult> {
  const doc = await readableDocByParam(ctx.actor, param);
  if (fragment) {
    const id = await annotationByFragment({ docId: doc.id }, fragment);
    if (!id) throw notFound("An annotation with that card fragment");
    return oneThread(ctx, id, args);
  }
  return readDoc(ctx, doc, args, (state, span) => containerExtras(ctx, { kind: "doc", id: doc.id, state }, args, span));
}

async function readFileRef(ctx: McpContext, slug: string, fragment: string, args: ReadArgs): Promise<ToolResult> {
  const file = await readableFileBySlug(ctx.actor, slug);
  if (fragment && !isViewerFragment(fragment)) {
    const id = await annotationByFragment({ fileId: file.id }, fragment);
    if (!id) throw notFound("An annotation with that card fragment");
    return oneThread(ctx, id, args);
  }
  return readPdf(ctx, file, args, fragment, () => containerExtras(ctx, { kind: "file", id: file.id }, args, null));
}

export const readTool = defineTool({
  name: "read",
  scope: "READ",
  description:
    "Read anything in MultiBlog by its URL (see the url parameter for every form), or an annotation by its id. A doc comes whole up to 40,000 characters; a longer one answers with its outline (headings, block numbers, section sizes), and you then read a section by heading or a run of blocks — or pass whole:true for up to 200,000. Each read carries `version`; send it back with a quote you anchor, or ask what changed `since` it. format:\"text\" gives text a quote can be copied from exactly. around:<quote> answers whether and where a quote really is, with the passage around it. include adds a doc's or PDF's annotation threads (filtered under threads, e.g. awaiting:true for the notes waiting on you) or the links into it, or a post's comments. Reads in one turn run in parallel.",
  input: readInput,
  output: z.looseObject({ kind: z.string().optional() }),
  readOnly: true,
  destructive: false,
  alwaysLoad: true,
  maxResultSizeChars: MAX_READ_CHARS,
  searchHint: "open url doc pdf page outline section blocks quote around thread annotation link post comment tag",
  async run(args, ctx) {
    const parsed = parse(args.url);
    switch (parsed.kind) {
      case "doc":
        return readDocRef(ctx, parsed.param, parsed.fragment, args);
      case "pdf":
        return readFileRef(ctx, parsed.slug, parsed.fragment, args);
      case "file":
        return readFileRef(ctx, parsed.slug, "", args);
      case "annotations":
        return allThreads(ctx, args);
      case "link":
        return readLink(ctx, parsed.id);
      case "post":
        return readPost(ctx, { slug: parsed.slug }, parsed.fragment, args);
      case "post-id":
        return readPost(ctx, { id: parsed.id }, parsed.fragment, args);
      case "tag":
        return readTag(ctx, parsed.slug);
      case "author":
        return readAuthor(ctx, parsed.slug);
      case "id":
        return readById(ctx, parsed.id, args);
      default:
        return refuseRef(parsed, args.url);
    }
  },
});
