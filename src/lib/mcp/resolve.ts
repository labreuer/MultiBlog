import type { DocVisibility } from "@/generated/prisma/enums";
import { fileVersionState, latestVersionOf, pdfPath, type FileVersionState } from "@/lib/file-version";
import { linkVersionsOf } from "@/lib/file-version-data";
import type { LinkVersion } from "@/lib/pdf-link-reading";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canUserReadDoc } from "@/lib/doc-authz";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveDocParam, resolveDocSlugHistory } from "@/lib/resolve-doc-param";
import { resolveFileParam } from "@/lib/file-slug";
import { appUrl } from "@/lib/app-url";
import type { Actor } from "@/lib/actor";
import { ApiError, invalid, notFound } from "@/lib/api/errors";
import { listedName } from "./tool";
import { parseRef, type ParsedRef } from "./url";
import { parseOwnerSegment, parsePageSegment } from "@/lib/wiki-address";
import { findWikiOwner, findWikiPage, ownerIdOf } from "@/lib/wiki-pages";

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

/** A parsed reference with a wiki page's address turned into the doc it names. */
export type DocParsedRef = Exclude<ParsedRef, { kind: "wiki" }>;

/**
 * `parse`, for a tool that takes a doc: a wiki page's address
 * (docs/WIKI.md "URLs") becomes `{ kind: "doc" }` naming the page's id, so
 * every switch that answers a parsed doc answers a page alike, and each keeps
 * the rules it has for a doc. The page is found as the wiki's routes find
 * it, through wiki-pages.ts, so a name in other capitals reaches it. Nothing
 * is gated here: the doc is then gated as any is, by canUserReadDoc
 * (readableDocByParam), and an unreadable page is `not_found`, as a missing
 * one is, which an id no doc has also answers. PUBLIC adds nothing: the wiki
 * read rule stays on the wiki's routes ("Public pages").
 */
export async function parseDocRef(ref: string): Promise<DocParsedRef> {
  const parsed = parse(ref);
  if (parsed.kind !== "wiki") return parsed;
  const id = await wikiDocIdOf(parsed.owner, parsed.page);
  return { kind: "doc", param: id ?? "", fragment: parsed.fragment };
}

async function wikiDocIdOf(ownerText: string, pageText: string): Promise<string | null> {
  let lowered = ownerText.toLowerCase();
  if (lowered === "common") lowered = "commons";
  const owner = parseOwnerSegment(lowered);
  const [rawName, ...variantParts] = pageText.split("~");
  const page = parsePageSegment(variantParts.length === 1 ? `${rawName}~${variantParts[0].toLowerCase()}` : pageText);
  if (!owner || (owner.kind !== "person" && owner.kind !== "commons") || !page) return null;
  const found = await findWikiOwner(owner);
  if (!found) return null;
  const doc = await findWikiPage(ownerIdOf(found), page.name, page.variant, { id: true });
  return doc?.id ?? null;
}

export type ResolvedDoc = {
  id: string;
  slug: string;
  title: string;
  visibility: DocVisibility;
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

/**
 * A file with the version of it being read (docs/PDF.md §13): the latest,
 * unless the address named another. What the bytes decide (`filename` to
 * `pageCount`) is that version's, and page text, labels and the outline are
 * read by `versionId`, never by `id`.
 */
export type ResolvedFile = {
  id: string;
  slug: string;
  title: string;
  versionId: string;
  versionNumber: number;
  isLatest: boolean;
  /** The reference named the version by its own address, /pdf/<slug>/v/<n>; false for the bare address, which means the latest. */
  versionAddressed: boolean;
  versionState: FileVersionState;
  /** Every version of the file, by number, with its page map's pairing: what a link's `v=` is read against and carried through (src/lib/pdf-link-reading.ts). */
  versions: LinkVersion[];
  /** The address read: the version's own where the reference named it, the bare one otherwise. */
  url: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  pageCount: number | null;
  visibility: DocVisibility;
};

const FILE_SELECT = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  deletedByUserId: true,
  currentVersionId: true,
  versions: {
    select: {
      id: true,
      number: true,
      filename: true,
      contentType: true,
      byteSize: true,
      sha256: true,
      pageCount: true,
      promotedAt: true,
      abandonedAt: true,
      baseVersionId: true,
      pageMap: true,
      pageLabels: true,
    },
  },
} as const;

/**
 * A file by any slug it has had, or by id, readable by the actor; `not_found`
 * otherwise. `versionNumber` is the version a version's own address names;
 * without it, the latest. A number the file never had is `not_found`, and so
 * is an abandoned version, which has no bytes or page text to read.
 */
export async function readableFileBySlug(actor: Actor, slugOrId: string, versionNumber?: number): Promise<ResolvedFile> {
  const resolved = await resolveFileParam(slugOrId, FILE_SELECT);
  const file =
    resolved?.file ?? (await prismaIncludingDeleted.storedFile.findUnique({ where: { id: slugOrId }, select: FILE_SELECT }));
  if (!file || file.deletedByUserId !== null || !(await canUserReadFile(actor.userId, actor.role, file))) {
    throw notFound("That file");
  }
  const version =
    versionNumber === undefined
      ? latestVersionOf({ id: file.id, currentVersion: file.versions.find((candidate) => candidate.id === file.currentVersionId) ?? null })
      : file.versions.find((candidate) => candidate.number === versionNumber);
  if (!version) throw notFound(`Version ${versionNumber} of that file`);
  const versionState = fileVersionState(version, file.currentVersionId);
  if (versionState === "abandoned") {
    throw new ApiError("not_found", `Version ${version.number} of that file was abandoned. The latest is at /pdf/${file.slug}.`);
  }
  const isLatest = versionState === "latest";
  const versionAddressed = versionNumber !== undefined;
  return {
    id: file.id,
    slug: file.slug,
    title: file.title,
    versionId: version.id,
    versionNumber: version.number,
    isLatest,
    versionAddressed,
    versionState,
    versions: await linkVersionsOf(file),
    url: pdfPath(file.slug, { number: version.number, isLatest }, { own: versionAddressed }),
    filename: version.filename,
    contentType: version.contentType,
    byteSize: version.byteSize,
    sha256: version.sha256,
    pageCount: version.pageCount,
    visibility: file.visibility,
  };
}

export type ResolvedContainer = { kind: "doc"; doc: ResolvedDoc } | { kind: "file"; file: ResolvedFile };

/**
 * A doc or a PDF, by URL or id: what `add_note`, `create_link`, `tag` and
 * `search`'s `within` take. A bare id is tried as a doc, then as a file.
 */
export async function readableContainer(actor: Actor, ref: string): Promise<ResolvedContainer> {
  const parsed = await parseDocRef(ref);
  switch (parsed.kind) {
    case "doc":
      return { kind: "doc", doc: await readableDocByParam(actor, parsed.param) };
    case "pdf":
    case "file":
      return { kind: "file", file: await readableFileBySlug(actor, parsed.slug, parsed.version) };
    case "id": {
      const doc = await prisma.doc.findUnique({ where: { id: parsed.id }, select: { id: true } });
      if (doc) return { kind: "doc", doc: await readableDocByParam(actor, parsed.id) };
      return { kind: "file", file: await readableFileBySlug(actor, parsed.id) };
    }
    default:
      throw invalid(`${ref} isn't a doc or a file; pass /doc/<slug>, a wiki page's /wiki/<owner>/<name>, /pdf/<slug> or an id.`);
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
    throw invalid(`${parsed.path} is answered by the \`${listedName(parsed.tool)}\` tool, not by \`${listedName("read")}\`.`);
  }
  throw new ApiError("invalid", `${ref} isn't a MultiBlog URL this server reads.`, {
    reads: "/doc/<slug>, a wiki page's /wiki/<owner>/<name>, /pdf/<slug>, /files/<slug>, /annotations, /link/<id>, a post's path, /post/<id>/edit, /tag/<slug>, /authors/<slug>, or an id",
  });
}
