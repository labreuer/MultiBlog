import type * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { extractText } from "./diff";
import { loadChipContext } from "./entity-chips/context";
import { bibliographyContent, citationBibliography } from "./entity-chips/kinds/citation-bibliography";
import { chipsToLinkedText } from "./entity-chips/linked-text";
import { chipsInJSON } from "./entity-chips/renderings";
import { chipStylesOf } from "./entity-chips/settings";
import { DEFAULT_CHIP_STYLES, type ChipStyles } from "./entity-chips/types";
import { stripMarksFromDoc } from "./tiptap-schema";
import { readYdocContent } from "./ydoc-render";

// PLAN.md §15b — turns a materialized doc snapshot into what a Post actually
// stores. A doc's ydoc carries authorHighlight and annotation marks, and
// entity chips, that no post-side reader (contentExtensions/pmSchema) knows
// about; leaving any of them in would 500 the public post page the moment it
// tries to render the doc.
//
// `postStyles` is the post's own choice of form per chip kind, where it
// differs from its doc's (docs/ENTITY_CHIPS.md, "Styling"): each kind it
// names wins over the doc's, which the ydoc holds as of this snapshot.
export async function postContentFromYdoc(doc: Y.Doc, postStyles: ChipStyles = DEFAULT_CHIP_STYLES): Promise<{ proseJson: object; title: string }> {
  const content = readYdocContent(doc);
  if (!content.ok) {
    throw new Error(content.error);
  }

  const proseJson = await docJsonForPostSide(content.bodyJSON, { ...chipStylesOf(doc), ...postStyles });
  const title = content.titleJSON ? extractText(content.titleJSON) : "";
  return { proseJson, title };
}

/**
 * A doc's body as a post-side surface can render it: the two doc-only marks
 * stripped, each entity chip replaced by its label as linked text
 * (docs/ENTITY_CHIPS.md, step 1, item 9), and the doc's bibliography
 * appended as text (docs/CITATIONS.md, "The bibliography"). The one
 * conversion for a post's snapshot and the landing page's preamble, the only
 * two paths by which a doc's JSON reaches a renderer that has no chip node.
 *
 * `styles` are the ones the labels are written in: the doc's own, with a
 * post's over them. Labels are the ones current as this runs: frozen into a post at publish
 * and refreshed by republishing, computed anew at each render of the
 * preamble. The bibliography is too.
 */
export async function docJsonForPostSide(bodyJSON: JSONContent, styles: ChipStyles = DEFAULT_CHIP_STYLES): Promise<JSONContent> {
  const stripped = stripMarksFromDoc(bodyJSON, ["authorHighlight", "annotation"]);
  const chips = chipsInJSON(stripped);
  if (chips.length === 0) return stripped;
  const context = await loadChipContext(chips);
  const linked = chipsToLinkedText(stripped, styles, context);
  const bibliography = bibliographyContent(citationBibliography(chips, styles, context));
  return bibliography.length > 0 ? { ...linked, content: [...(linked.content ?? []), ...bibliography] } : linked;
}
