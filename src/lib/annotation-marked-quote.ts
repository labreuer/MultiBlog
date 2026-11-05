import type { JSONContent } from "@tiptap/core";
import { parseChipRecords, quoteWithEdgeChips } from "./anchors";
import type { ChipLabels } from "./entity-chips/text";
import { extractMarkedText } from "./tiptap-schema";

/**
 * A mark-anchored annotation's passage, read from its doc's cache: the text
 * under its mark, with the labels of the entity chips at the passage's edges
 * (docs/ENTITY_CHIPS.md, step 1, item 11), which the mark can't sit on and
 * the row records instead. "" when the doc holds neither any more.
 *
 * `labels` are the cache's own (`materializedLabels`), by instance id: they
 * say what each chip reads as, and which chips are still there.
 */
export function markAnchoredQuote(proseJson: JSONContent, annotationId: string, anchorChips: unknown, labels: ChipLabels): string {
  return quoteWithEdgeChips(extractMarkedText(proseJson, "annotation", "id", annotationId), parseChipRecords(anchorChips), labels);
}
