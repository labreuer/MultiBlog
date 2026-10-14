import { z } from "zod";
import { appUrl } from "@/lib/app-url";
import { GRANT_PARAM, signByteGrant } from "@/lib/api/grants";
import { invalid } from "@/lib/api/errors";
import { defineTool, listedName, objectRef } from "../tool";
import { readableFile } from "../resolve";
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

const urlOutput = z.object({ url: z.string(), expires: z.string(), method: z.string(), usage: z.string() });

export const downloadTool = defineTool({
  name: "download",
  scope: "READ",
  description:
    `Download a file's bytes (any PDF or .docx you can read) or an export of docs as a tar: answers with a URL, carrying a grant good for ten minutes, to fetch with curl. The token is never needed in a shell. The export: GET with ${listedName("search")}'s filters as query parameters (tags, authors, created_from…; kinds is docs only), or POST a JSON list of doc URLs or ids as {"docs": […]}; add format=markdown (default), text or json. catalog=1 answers only each doc's id, slug, title, size and newest version: save it, and Grep it to find docs by title before reading any. For a sweep that must read every doc, take the export or its catalog and Grep locally rather than reading each.`,
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
      const granted = await grantedUrl(ctx.token.id, BYTE_ROUTES.downloadFile(file.id));
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
    `Upload a PDF or a .docx, or a Markdown draft from a local file that becomes a doc: answers with a URL, carrying a grant good for ten minutes, to send the bytes to with curl --data-binary. The token is never needed in a shell. kind file: add &filename=<name>, and &title= or &issuerOnly=1 as wanted. kind doc: add &title= unless the file's leading heading is the title, and &issuerOnly=1 to leave yourself off the byline; the doc is made as ${listedName("create_doc")} makes one. Either is PRIVATE, like everything you create. The upload answers with the new file's or doc's URL.`,
  input: z.strictObject({
    kind: z.enum(["file", "doc"]).describe("file: a PDF or .docx upload. doc: a Markdown body becoming a doc."),
  }),
  output: urlOutput,
  readOnly: true,
  destructive: false,
  searchHint: "upload pdf docx markdown draft file bytes curl grant",
  async run(args, ctx) {
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
