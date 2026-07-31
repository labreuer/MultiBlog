import type * as Y from "yjs";
import { extractText } from "./diff";
import { stripMarksFromDoc } from "./tiptap-schema";
import { readYdocContent } from "./ydoc-render";

// PLAN.md §15b — turns a materialized doc snapshot into what a Post actually
// stores. A doc's ydoc carries authorHighlight and annotation marks that no
// post-side reader (contentExtensions/pmSchema) knows about; leaving either
// in would 500 the public post page the moment it tries to render the doc.
export function postContentFromYdoc(doc: Y.Doc): { proseJson: object; title: string } {
  const content = readYdocContent(doc);
  if (!content.ok) {
    throw new Error(content.error);
  }

  const proseJson = stripMarksFromDoc(content.bodyJSON, ["authorHighlight", "annotation"]);
  const title = content.titleJSON ? extractText(content.titleJSON) : "";
  return { proseJson, title };
}
