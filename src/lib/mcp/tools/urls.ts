import { z } from "zod";
import { appUrl } from "@/lib/app-url";
import { GRANT_PARAM, signByteGrant } from "@/lib/api/grants";
import { forbidden, invalid, notFound } from "@/lib/api/errors";
import { canUserReadFile, canUserUploadFileVersion } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { defineTool, listedName, objectRef } from "../tool";
import { parse, readableFile } from "../resolve";
import { minuteOf } from "../shape";

// docs/MCP.md §5 — download and upload: the byte routes are reached through
// these, never with the token. Each answers a route's URL with a grant good
// for ten minutes in its query string, and Claude adds the route's own
// parameters and body and runs curl. So nothing in Claude's shell ever holds
// the token, and a forced prompt guarding a tool can't be sidestepped by a
// shell posting the same call itself.
//
// Both change nothing themselves — an upload happens when its bytes arrive —
// so both are read-only in MCP's sense.

/** The byte routes' paths, which a grant names exactly. */
export const BYTE_ROUTES = {
  uploadFile: "/api/mcp/files",
  createDoc: "/api/mcp/docs",
  exportDocs: "/api/mcp/export",
  downloadFile: (fileId: string) => `/api/mcp/files/${fileId}`,
} as const;

async function grantedUrl(tokenId: string, route: string): Promise<{ url: string; expires: string }> {
  const { grant, expiresAt } = await signByteGrant(tokenId, route);
  return { url: `${appUrl(route)}?${GRANT_PARAM}=${encodeURIComponent(grant)}`, expires: minuteOf(expiresAt) };
}

/**
 * The file an upload is to be a new version of, by its address or id
 * (docs/PDF.md §13, "The upload"). Whoever may upload a version of it is
 * answered, which is its managers and a bot whose person manages it: a bot
 * can so name a PRIVATE file that only its person owns, which it can't read.
 * Anyone else gets what a read gets, `not_found` for a file they can't read
 * and `forbidden` for one they can.
 */
async function fileForVersionUpload(actor: Actor, ref: string): Promise<{ id: string }> {
  const parsed = parse(ref);
  const param = parsed.kind === "pdf" || parsed.kind === "file" ? parsed.slug : parsed.kind === "id" ? parsed.id : null;
  if (param === null) throw invalid(`${ref} isn't a file; pass /pdf/<slug> or an id.`);
  const select = { id: true, visibility: true, deletedByUserId: true, currentVersion: { select: { pageCount: true } } } as const;
  // By any slug it has had, or by id, as every tool names a file.
  const file = (await resolveFileParam(param, select))?.file ?? (await prismaIncludingDeleted.storedFile.findUnique({ where: { id: param }, select }));
  const mayUpload = file ? await canUserUploadFileVersion(actor.userId, actor.role, file.id) : false;
  if (!file || file.deletedByUserId !== null || (!mayUpload && !(await canUserReadFile(actor.userId, actor.role, file)))) throw notFound("That file");
  if (!mayUpload) {
    throw forbidden("You can read this file but neither you nor the person you work for manages it, so you can't give it a new version.");
  }
  if (!file.currentVersion || file.currentVersion.pageCount === null) throw invalid("Only a PDF takes a new version.");
  return { id: file.id };
}

const urlOutput = z.object({ url: z.string(), expires: z.string(), method: z.string(), usage: z.string() });

export const downloadTool = defineTool({
  name: "download",
  scope: "READ",
  description:
    `Download a file's bytes (any PDF or .docx you can read) or an export of docs as a tar: answers with a URL, carrying a grant good for ten minutes, to fetch with curl. The token is never needed in a shell. The export: GET with ${listedName("search")}'s filters as query parameters (tags, authors, created_from…; kinds is docs only), or POST a JSON list of doc URLs or ids as {"docs": […]}; add format=markdown (default), text or json. catalog=1 answers, unpaged, every doc selected with only its id, slug, title, length in characters (chars) and newest version: save it, and Grep it to find docs by title before reading any. For a sweep that must read every doc, take the export or its catalog and Grep locally rather than reading each.`,
  input: z.strictObject({
    file: objectRef.optional().describe("The file to download: /pdf/<slug>, /files/<slug> or an id."),
    export: z.boolean().optional().describe("The export route instead of a file."),
  }),
  output: urlOutput,
  readOnly: true,
  destructive: false,
  searchHint: "download bytes pdf docx export tar catalog curl grant",
  async run(args, ctx) {
    if ((args.file === undefined) === (args.export !== true)) throw invalid("Ask for a file, or export:true, one of them.");
    if (args.file !== undefined) {
      const file = await readableFile(ctx.actor, args.file);
      const grant = await grantedUrl(ctx.token.id, BYTE_ROUTES.downloadFile(file.id));
      // A version's own address downloads that version's bytes; the bare one, the latest's.
      const granted = file.versionAddressed ? { ...grant, url: `${grant.url}&v=${file.versionNumber}` } : grant;
      return { ...granted, method: "GET", usage: `curl -fsSL -o '${file.filename.replace(/'/g, "")}' '<url>'` };
    }
    const granted = await grantedUrl(ctx.token.id, BYTE_ROUTES.exportDocs);
    return {
      ...granted,
      method: "GET or POST",
      usage: "curl -fsSL '<url>&catalog=1' > catalog.json; curl -fsSL '<url>&tags=<slug>' | tar -x -C docs/",
    };
  },
});

export const uploadTool = defineTool({
  name: "upload",
  scope: "WRITE",
  description:
    `Upload a PDF or a .docx, or a Markdown draft from a local file that becomes a doc: answers with a URL, carrying a grant good for ten minutes, to send the bytes to with curl --data-binary. The token is never needed in a shell. kind file: add &filename=<name>, and &title= or &issuerOnly=1 as wanted. kind doc: add &title= unless the file's leading heading is the title, and &issuerOnly=1 to leave yourself off the byline; the doc is made as ${listedName("create_doc")} makes one. Either is PRIVATE, like everything you create. The upload answers with the new file's or doc's URL. With versionOf, the PDF sent becomes the next version of that file, one you or the person you work for manages: it waits at its own address, /pdf/<slug>/v/<n>, which the upload answers, and a person promotes it there; add only &filename=<name>.`,
  input: z.strictObject({
    kind: z.enum(["file", "doc"]).describe("file: a PDF or .docx upload. doc: a Markdown body becoming a doc."),
    versionOf: objectRef.optional().describe("kind file only: the PDF this upload is a new version of, /pdf/<slug> or an id. A corrected scan, or a later draft."),
  }),
  output: urlOutput,
  readOnly: true,
  destructive: false,
  searchHint: "upload pdf docx markdown draft file bytes curl grant",
  async run(args, ctx) {
    if (args.versionOf !== undefined) {
      if (args.kind !== "file") throw invalid("versionOf is for kind file: a new version of a PDF is a PDF.");
      // Refused here, where the refusal costs no upload; the route checks again before it reads the body.
      const file = await fileForVersionUpload(ctx.actor, args.versionOf);
      const granted = await grantedUrl(ctx.token.id, BYTE_ROUTES.uploadFile);
      return {
        ...granted,
        url: `${granted.url}&versionOf=${encodeURIComponent(file.id)}`,
        method: "POST",
        usage: "curl -fsS --data-binary @paper.pdf '<url>&filename=paper.pdf'",
      };
    }
    const route = args.kind === "file" ? BYTE_ROUTES.uploadFile : BYTE_ROUTES.createDoc;
    const granted = await grantedUrl(ctx.token.id, route);
    return {
      ...granted,
      method: "POST",
      usage:
        args.kind === "file"
          ? "curl -fsS --data-binary @paper.pdf '<url>&filename=paper.pdf'"
          : "curl -fsS --data-binary @summary.md '<url>&title=…'",
    };
  },
});
