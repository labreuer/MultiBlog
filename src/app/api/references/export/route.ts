import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { downloadSelection } from "@/lib/reference-export";
import { EXPORT_FORMATS, isExportFormat, writeReferences } from "@/lib/references/export";

// docs/CITATIONS.md, "Downloads" — one route for every download of works:
// `?format=bibtex|biblatex|ris|csl-json` and one selection, each under its
// own gate (src/lib/reference-export.ts). Under /api because
// `/references/export` would hide a reference keyed `export`.
//
// Every file is an attachment, under its name: Zotero's Connector then
// imports a BibTeX, biblatex or RIS download in place of saving it, and
// served inline, Vivaldi's did not always.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const format = params.get("format");
  if (!isExportFormat(format)) return new Response("format is bibtex, biblatex, ris or csl-json.\n", { status: 400 });
  // A record is public, so a work's own download asks for no session.
  const session = params.has("key") ? null : await auth();
  const selection = await downloadSelection(session?.user ? actorFromSessionUser(session.user) : null, params, format);
  if (!selection) return new Response("Not found.\n", { status: 404 });
  const { contentType } = EXPORT_FORMATS[format];
  return new Response(writeReferences(selection.records, format), {
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${selection.name.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(selection.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
