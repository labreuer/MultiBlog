import type * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { extractText } from "./diff";
import { loadChipContext } from "./entity-chips/context";
import { chipsToLinkedText } from "./entity-chips/linked-text";
import { chipsInJSON } from "./entity-chips/renderings";
import { DEFAULT_CHIP_STYLES } from "./entity-chips/types";
import { stripMarksFromDoc } from "./tiptap-schema";
import { readYdocContent } from "./ydoc-render";

// PLAN.md §15b — turns a materialized doc snapshot into what a Post actually
// stores. A doc's ydoc carries authorHighlight and annotation marks, and
// entity chips, that no post-side reader (contentExtensions/pmSchema) knows
// about; leaving any of them in would 500 the public post page the moment it
// tries to render the doc.
export async function postContentFromYdoc(doc: Y.Doc): Promise<{ proseJson: object; title: string }> {
  const content = readYdocContent(doc);
  if (!content.ok) {
    throw new Error(content.error);
  }

  const proseJson = await docJsonForPostSide(content.bodyJSON);
  const title = content.titleJSON ? extractText(content.titleJSON) : "";
  return { proseJson, title };
}

/**
 * A doc's body as a post-side surface can render it: the two doc-only marks
 * stripped, and each entity chip replaced by its label as linked text
 * (docs/ENTITY_CHIPS.md, step 1, item 9). The one conversion for a post's
 * snapshot and the landing page's preamble, the only two paths by which a
 * doc's JSON reaches a renderer that has no chip node.
 *
 * Labels are the ones current as this runs: frozen into a post at publish
 * and refreshed by republishing, computed anew at each render of the
 * preamble.
 */
export async function docJsonForPostSide(bodyJSON: JSONContent): Promise<JSONContent> {
  const stripped = stripMarksFromDoc(bodyJSON, ["authorHighlight", "annotation"]);
  const chips = chipsInJSON(stripped);
  if (chips.length === 0) return stripped;
  return chipsToLinkedText(stripped, DEFAULT_CHIP_STYLES, await loadChipContext(chips));
}
