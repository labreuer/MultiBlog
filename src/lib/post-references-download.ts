import { Extension, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BIBLIOGRAPHY_HEADING } from "@/lib/entity-chips/kinds/citation-bibliography";
import { downloadHref, EXPORT_FORMAT_ORDER, EXPORT_FORMATS } from "@/lib/references/export-formats";

// docs/CITATIONS.md, "Downloads", "A post's References" — the download icon
// beside a post's References heading. The References are the post's text,
// appended at publish, so the icon is added where the text is drawn and never
// written into it: by the post page's static render, which draws
// DownloadMenu before the heading, and here, as a widget decoration in the
// read-only editor that replaces that render. Neither changes the text, so
// search, quotes, comments and the feed never see it.
//
// The heading is found by its place: the post's last level-2 heading reading
// "References", since `docJsonForPostSide` always appends it last. The page
// asks for the icon only for a post that cites a work.
//
// Browser-safe; the static render reads `referencesHeadingIndex` on the server.

function textOf(node: JSONContent): string {
  return node.text ?? (node.content ?? []).map(textOf).join("");
}

/** The place of a post's References heading among its top-level blocks, or -1. */
export function referencesHeadingIndex(content: readonly JSONContent[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const node = content[i];
    if (node.type === "heading" && node.attrs?.level === 2) return textOf(node) === BIBLIOGRAPHY_HEADING ? i : -1;
  }
  return -1;
}

/** The position before the last level-2 heading of `doc`, when it reads "References". */
function headingPos(doc: PMNode): number | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.forEach((node, pos) => {
    if (node.type.name === "heading" && node.attrs.level === 2) found = { pos, node };
  });
  const last = found as { pos: number; node: PMNode } | null;
  return last && last.node.textContent === BIBLIOGRAPHY_HEADING ? last.pos : null;
}

const SVG = "http://www.w3.org/2000/svg";

/** The same menu DownloadMenu draws, as DOM: a `<details>` of the four formats' links. */
function menuElement(selection: string, classes: { download: string; floated: string; menu: string }): HTMLElement {
  const details = document.createElement("details");
  details.className = `${classes.download} ${classes.floated}`;
  details.contentEditable = "false";
  const summary = document.createElement("summary");
  const label = "Download these references";
  summary.setAttribute("aria-label", label);
  summary.title = label;
  const icon = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    icon.setAttribute(name, value);
  }
  for (const d of ["M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2", "M7 11l5 5l5 -5", "M12 4l0 12"]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  summary.append(icon);
  const list = document.createElement("ul");
  list.className = classes.menu;
  for (const format of EXPORT_FORMAT_ORDER) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = downloadHref(format, selection);
    link.rel = "nofollow";
    link.textContent = EXPORT_FORMATS[format].label;
    item.append(link);
    list.append(item);
  }
  details.append(summary, list);
  return details;
}

export type ReferencesDownloadOptions = { selection: string | null; classes: { download: string; floated: string; menu: string } };

const key = new PluginKey("referencesDownload");

/** The widget decoration: before the References heading, when `selection` names the post's works. */
export const ReferencesDownload = Extension.create<ReferencesDownloadOptions>({
  name: "referencesDownload",
  addOptions() {
    return { selection: null, classes: { download: "", floated: "", menu: "" } };
  },
  addProseMirrorPlugins() {
    const { selection, classes } = this.options;
    if (!selection) return [];
    const decorate = (doc: PMNode) => {
      const pos = headingPos(doc);
      return pos === null ? DecorationSet.empty : DecorationSet.create(doc, [Decoration.widget(pos, () => menuElement(selection, classes), { side: -1, key: `references-download-${selection}`, ignoreSelection: true })]);
    };
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});
