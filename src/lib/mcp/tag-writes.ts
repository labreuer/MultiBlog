import { prisma } from "@/lib/prisma";
import { derivePostStatus } from "@/lib/post-status";
import { targetToColumns, type AnchorTarget } from "@/lib/anchors";
import { canCurateTags } from "@/lib/role-checks";
import { tagsForTarget } from "@/lib/tag-data";
import { tagSlugFromHistory } from "@/lib/tag-slug";
import { applyTags, mintTag, normalizeTagName, removeTagAssignment } from "@/lib/tag-write";
import { ApiError, forbidden, invalid, notFound } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "./tool";
import { parse, readableDocByParam, readableFileBySlug } from "./resolve";
import { isViewerFragment } from "./url";
import { annotationByFragment } from "./read/threads";
import { commentIdByFragment, readablePost } from "./read/posts";

// docs/MCP.md §11 — tag and untag, over src/lib/tag-write.ts. What they add
// to the shared bodies is the resolution of a URL to the thing it names, and
// two refusals of their own:
//
// - **A published or scheduled post** is refused under `write`: its chips
//   are on a public, statically generated page (or will be, with nobody
//   acting again), and a term's name is free text, so a planted instruction
//   could carry words read in a PRIVATE doc onto the open web. `manage` tags
//   one, and prompts.
// - **An annotation on a deleted container**, which `canUserTagTarget`'s
//   annotation arm doesn't check: it reads the container through a relation,
//   where the soft-delete filter doesn't reach.

export type TagTarget = { target: AnchorTarget; url: string; publicPost: boolean };

async function annotationTarget(annotationId: string): Promise<TagTarget> {
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { id: true, status: true, deletedByUserId: true, docId: true, fileId: true },
  });
  if (!annotation || annotation.status === "DRAFT" || annotation.deletedByUserId !== null) throw notFound("That annotation");
  const live = annotation.docId
    ? await prisma.doc.findUnique({ where: { id: annotation.docId }, select: { id: true } })
    : await prisma.storedFile.findUnique({ where: { id: annotation.fileId! }, select: { id: true } });
  if (!live) throw notFound("That annotation");
  return { target: { kind: "annotation", id: annotation.id }, url: annotation.id, publicPost: false };
}

async function postTarget(ctx: McpContext, by: { slug: string } | { id: string }, fragment: string): Promise<TagTarget> {
  const post = await readablePost(ctx, by);
  if (!post) throw notFound("That post");
  if (fragment) {
    const commentId = await commentIdByFragment(post.id, fragment);
    if (!commentId) throw notFound("That comment");
    return { target: { kind: "comment", id: commentId }, url: commentId, publicPost: false };
  }
  return {
    target: { kind: "post", id: post.id },
    url: `/post/${post.id}/edit`,
    publicPost: derivePostStatus(post) !== "draft",
  };
}

/**
 * What a URL or id names, for tagging: a doc, a file, a post, an annotation
 * (by id, or its card's URL) or a comment (by its card's URL). Each is found
 * through its own read rule; `applyTags` runs the tag gate on top.
 */
export async function resolveTagTarget(ctx: McpContext, ref: string): Promise<TagTarget> {
  const parsed = parse(ref);
  switch (parsed.kind) {
    case "doc": {
      const doc = await readableDocByParam(ctx.actor, parsed.param);
      if (parsed.fragment) {
        const id = await annotationByFragment({ docId: doc.id }, parsed.fragment);
        if (!id) throw notFound("An annotation with that card fragment");
        return annotationTarget(id);
      }
      return { target: { kind: "doc", id: doc.id }, url: `/doc/${doc.slug}`, publicPost: false };
    }
    case "pdf":
    case "file": {
      const file = await readableFileBySlug(ctx.actor, parsed.slug);
      if (parsed.kind === "pdf" && parsed.fragment && !isViewerFragment(parsed.fragment)) {
        const id = await annotationByFragment({ fileId: file.id }, parsed.fragment);
        if (!id) throw notFound("An annotation with that card fragment");
        return annotationTarget(id);
      }
      return { target: { kind: "file", id: file.id }, url: `/${parsed.kind === "pdf" ? "pdf" : "files"}/${file.slug}`, publicPost: false };
    }
    case "post":
      return postTarget(ctx, { slug: parsed.slug }, parsed.fragment);
    case "post-id":
      return postTarget(ctx, { id: parsed.id }, parsed.fragment);
    case "id": {
      const id = parsed.id;
      const [annotation, doc, file, post, comment] = await Promise.all([
        prisma.annotation.findUnique({ where: { id }, select: { id: true } }),
        prisma.doc.findUnique({ where: { id }, select: { id: true } }),
        prisma.storedFile.findUnique({ where: { id }, select: { id: true } }),
        prisma.post.findUnique({ where: { id }, select: { id: true } }),
        prisma.comment.findUnique({ where: { id }, select: { id: true } }),
      ]);
      if (annotation) return annotationTarget(id);
      if (doc) return resolveTagTarget(ctx, `/doc/${id}`);
      if (file) return resolveTagTarget(ctx, `/files/${id}`);
      if (post) return postTarget(ctx, { id }, "");
      if (comment) return { target: { kind: "comment", id }, url: id, publicPost: false };
      throw notFound("Anything with that id");
    }
    default:
      throw invalid("tag takes a doc, a PDF or file, a post, an annotation (its id or card URL) or a comment (its card URL).");
  }
}

/** The tags now on a target, as a read shows them. */
async function chipsOf(target: AnchorTarget) {
  return (await tagsForTarget(target)).map((chip) => ({ name: chip.name, slug: chip.slug }));
}

/** tag, and manage's tagging of a public post: each name minted when new, then applied in one act. */
export async function tagFor(ctx: McpContext, resolved: TagTarget, names: readonly string[]): Promise<ToolResult> {
  const wanted = [...new Set(names.map(normalizeTagName).filter((name) => name !== ""))];
  if (wanted.length === 0) throw invalid("Name at least one tag.");
  const terms = [];
  for (const name of wanted) terms.push(await mintTag(ctx.actor, name));
  const applied = new Set(await applyTags(ctx.actor, resolved.target, terms.map((t) => t.id)));
  return {
    target: resolved.url,
    applied: terms.filter((t) => applied.has(t.id)).map((t) => ({ name: t.name, url: `/tag/${t.slug}`, ...(t.created ? { new: true } : {}) })),
    ...(terms.some((t) => !applied.has(t.id)) ? { alreadyYours: terms.filter((t) => !applied.has(t.id)).map((t) => t.name) } : {}),
    tags: await chipsOf(resolved.target),
  };
}

export async function tagToolFor(ctx: McpContext, input: { target: string; tags: string[] }): Promise<ToolResult> {
  const resolved = await resolveTagTarget(ctx, input.target);
  if (resolved.publicPost) {
    throw forbidden("That post is published or scheduled, so its tags are public at once; tagging it takes the manage scope.");
  }
  return tagFor(ctx, resolved, input.tags);
}

/**
 * untag: the actor's own assignments of the named terms on the target, or —
 * with `anyone`, as ADMIN/EDITOR — everyone's. Terms are named by name or
 * slug, past slugs followed.
 */
export async function untagFor(ctx: McpContext, input: { target: string; tags: string[]; anyone?: boolean }): Promise<ToolResult> {
  if (input.anyone && !canCurateTags(ctx.actor.role)) throw forbidden("Only an admin or editor removes other people's tags.");
  const resolved = await resolveTagTarget(ctx, input.target);
  // Every term found before anything is removed, so a name that isn't one
  // refuses the call rather than leaving it half done.
  const terms: { id: string; name: string }[] = [];
  for (const ref of [...new Set(input.tags)]) {
    const moved = await tagSlugFromHistory(ref);
    const tag = await prisma.tag.findFirst({
      where: { OR: [{ name: { equals: normalizeTagName(ref), mode: "insensitive" } }, { slug: moved ?? ref }] },
      select: { id: true, name: true },
    });
    if (!tag) throw new ApiError("not_found", `No tag is called "${ref}"; find_tags lists them.`);
    if (!terms.some((t) => t.id === tag.id)) terms.push(tag);
  }
  const removed: string[] = [];
  const notTagged: string[] = [];
  for (const tag of terms) {
    const anchors = await prisma.tagAnchor.findMany({
      where: {
        ...targetToColumns(resolved.target),
        assignment: { tagId: tag.id, deletedAt: null, ...(input.anyone ? {} : { userId: ctx.actor.userId }) },
      },
      select: { assignmentId: true },
    });
    if (anchors.length === 0) {
      notTagged.push(tag.name);
      continue;
    }
    for (const { assignmentId } of anchors) await removeTagAssignment(ctx.actor, assignmentId);
    removed.push(tag.name);
  }
  return {
    target: resolved.url,
    removed,
    ...(notTagged.length > 0 ? { notTagged } : {}),
    tags: await chipsOf(resolved.target),
  };
}
