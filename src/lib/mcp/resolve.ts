import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveDocParam, resolveDocSlugHistory } from "@/lib/resolve-doc-param";
import { resolveFileParam } from "@/lib/file-slug";
import { appUrl } from "@/lib/app-url";
import type { Actor } from "@/lib/actor";
import { ApiError, invalid, notFound } from "@/lib/api/errors";
import { parseRef, type ParsedRef } from "./url";

// docs/MCP.md §15 — what a URL or id names, followed through slug history as
// its own reading route follows it, and gated by that kind's read rule.
//
// **An object the actor may not read is `not_found`**, the same as one that
// doesn't exist (§4), and so is a deleted one: `/doc/<slug>` and
// `/pdf/<slug>` refuse a deleted container, and so does every tool.

/** This instance's origin, for telling its absolute URLs from another site's. */
export function appOrigin(): string | null {
  try {
    return new URL(appUrl("/")).origin;
  } catch {
    return null;
  }
}

export function parse(ref: string): ParsedRef {
  return parseRef(ref, appOrigin());
}

export type ResolvedDoc = {
  id: string;
  slug: string;
  title: string;
  visibility: "PRIVATE" | "SHARED";
  record: boolean;
};

const DOC_SELECT = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  record: true,
  deletedByUserId: true,
} as const;

/** A doc by its id or any slug it has had, readable by the actor; `not_found` otherwise. */
export async function readableDocByParam(actor: Actor, param: string): Promise<ResolvedDoc> {
  let doc = await resolveDocParam(param, DOC_SELECT);
  if (!doc) {
    const moved = await resolveDocSlugHistory(param);
    doc = moved ? await resolveDocParam(moved.id, DOC_SELECT) : null;
  }
  if (!doc || doc.deletedByUserId !== null || !(await canUserReadDoc(actor.userId, actor.role, doc))) {
    throw notFound("That doc");
  }
  return { id: doc.id, slug: doc.slug, title: doc.title, visibility: doc.visibility, record: doc.record };
}

export type ResolvedFile = {
  id: string;
  slug: string;
  title: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  pageCount: number | null;
  visibility: "PRIVATE" | "SHARED";
};

const FILE_SELECT = {
  id: true,
  slug: true,
  title: true,
  filename: true,
  contentType: true,
  byteSize: true,
  sha256: true,
  pageCount: true,
  visibility: true,
  deletedByUserId: true,
} as const;

/** A file by any slug it has had, or by id, readable by the actor; `not_found` otherwise. */
export async function readableFileBySlug(actor: Actor, slugOrId: string): Promise<ResolvedFile> {
  const resolved = await resolveFileParam(slugOrId, FILE_SELECT);
  const file =
    resolved?.file ?? (await prismaIncludingDeleted.storedFile.findUnique({ where: { id: slugOrId }, select: FILE_SELECT }));
  if (!file || file.deletedByUserId !== null || !(await canUserReadFile(actor.userId, actor.role, file))) {
    throw notFound("That file");
  }
  return {
    id: file.id,
    slug: file.slug,
    title: file.title,
    filename: file.filename,
    contentType: file.contentType,
    byteSize: file.byteSize,
    sha256: file.sha256,
    pageCount: file.pageCount,
    visibility: file.visibility,
  };
}

export type ResolvedContainer = { kind: "doc"; doc: ResolvedDoc } | { kind: "file"; file: ResolvedFile };

/**
 * A doc or a PDF, by URL or id: what `annotate`, `create_link`, `tag` and
 * `search`'s `within` take. A bare id is tried as a doc, then as a file.
 */
export async function readableContainer(actor: Actor, ref: string): Promise<ResolvedContainer> {
  const parsed = parse(ref);
  switch (parsed.kind) {
    case "doc":
      return { kind: "doc", doc: await readableDocByParam(actor, parsed.param) };
    case "pdf":
    case "file":
      return { kind: "file", file: await readableFileBySlug(actor, parsed.slug) };
    case "id": {
      const doc = await prisma.doc.findUnique({ where: { id: parsed.id }, select: { id: true } });
      if (doc) return { kind: "doc", doc: await readableDocByParam(actor, parsed.id) };
      return { kind: "file", file: await readableFileBySlug(actor, parsed.id) };
    }
    default:
      throw invalid(`${ref} isn't a doc or a file; pass /doc/<slug>, /pdf/<slug> or an id.`);
  }
}

/** A doc by URL or id, readable by the actor. */
export async function readableDoc(actor: Actor, ref: string): Promise<ResolvedDoc> {
  const container = await readableContainer(actor, ref);
  if (container.kind !== "doc") throw invalid(`${ref} is a file, not a doc.`);
  return container.doc;
}

/** A file by URL or id, readable by the actor. */
export async function readableFile(actor: Actor, ref: string): Promise<ResolvedFile> {
  const container = await readableContainer(actor, ref);
  if (container.kind !== "file") throw invalid(`${ref} is a doc, not a file.`);
  return container.file;
}

/** Refuses a URL that `read` doesn't take, naming the tool that answers it where one does. */
export function refuseRef(parsed: ParsedRef, ref: string): never {
  if (parsed.kind === "elsewhere") {
    throw invalid(`${parsed.path} is answered by the \`${parsed.tool}\` tool, not by \`read\`.`);
  }
  throw new ApiError("invalid", `${ref} isn't a MultiBlog URL this server reads.`, {
    reads: "/doc/<slug>, /pdf/<slug>, /files/<slug>, /annotations, /link/<id>, a post's path, /post/<id>/edit, /tag/<slug>, /authors/<slug>, or an id",
  });
}
