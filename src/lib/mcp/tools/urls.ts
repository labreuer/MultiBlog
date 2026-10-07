import { z } from "zod";
import { appUrl } from "@/lib/app-url";
import { GRANT_PARAM, signByteGrant } from "@/lib/api/grants";
import { invalid } from "@/lib/api/errors";
import { defineTool, objectRef } from "../tool";
import { readableFile } from "../resolve";
import { minuteOf } from "../shape";

// docs/MCP.md §5 — the byte routes are reached through these, never with the
// token: each answers a route's URL with a grant good for ten minutes in its
// query string, and Claude adds the route's own parameters and body and runs
// curl. So nothing in Claude's shell ever holds the token, and a forced
// prompt guarding a tool can't be sidestepped by a shell posting the same
// call itself.
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

export const downloadUrlTool = defineTool({
  name: "download_url",
  scope: "READ",
  description:
    "A URL, good for ten minutes, for a file's bytes (any file you can read: a PDF, a .docx) or for the export of docs. Fetch it with curl; the token is never needed in a shell. The export: GET with search's filters as query parameters (tags, authors, created_from…, kinds is docs only), or POST a JSON list of doc URLs or ids as {\"docs\": […]}; add format=markdown (default), text or json; catalog=1 answers only each doc's id, slug, title, size and newest version — save it, and Grep it to find docs by title before reading any.",
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

export const uploadUrlTool = defineTool({
  name: "upload_url",
  scope: "WRITE",
  description:
    "A URL, good for ten minutes, for sending bytes with curl --data-binary: a PDF or a .docx (kind file; add &filename=<name>, and &title= or &issuerOnly=1 as wanted), or a Markdown draft that becomes a doc (kind doc; add &title= unless the file's leading heading is the title, and &issuerOnly=1 to leave yourself off the byline). Either is PRIVATE, like everything you create. Answers with the new file's or doc's URL.",
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
