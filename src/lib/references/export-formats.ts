// docs/CITATIONS.md, "Downloads" — the four download formats, their file
// endings and media types, and the route a download link names. Pure and
// browser-safe, unlike export.ts, which writes them on the server: a link
// drawn in the browser needs only this.

export type ExportFormat = "csl-json" | "bibtex" | "biblatex" | "ris";

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; extension: string; contentType: string }> = {
  bibtex: { label: "BibTeX", extension: ".bib", contentType: "application/x-bibtex" },
  biblatex: { label: "BibLaTeX", extension: ".biblatex.bib", contentType: "application/x-bibtex" },
  ris: { label: "RIS", extension: ".ris", contentType: "application/x-research-info-systems" },
  "csl-json": { label: "CSL-JSON", extension: ".json", contentType: "application/vnd.citationstyles.csl+json" },
};

/** The order the links offer them in. */
export const EXPORT_FORMAT_ORDER: ExportFormat[] = ["bibtex", "biblatex", "ris", "csl-json"];

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === "string" && value in EXPORT_FORMATS;
}

/** A download's URL: the format, then one selection, such as `doc=<id>` or `key=<key>` (src/lib/reference-export.ts). */
export function downloadHref(format: ExportFormat, selection: string): string {
  return `/api/references/export?format=${format}${selection ? `&${selection}` : ""}`;
}
