import type { Node as PMNode } from "@tiptap/pm/model";
import type { ChipLabels } from "../entity-chips/text";
import { resolveAnchorInDoc } from "./resolve";
import { deriveDocRangeSelector, type DocRangeSelector } from "./selector";

// The pure half of capture.ts: what an anchor stores, derived from a node
// already built at the stamp. Apart from capture.ts so the unit suite can run
// it without a database; server callers import it from there.

/**
 * `captureAnchorInYdoc` over a node already built at the stamp — what the MCP
 * server's anchoring uses (docs/MCP.md §7), since it has rebuilt the doc once
 * to find the quote and a second replay for the capture would be the same
 * work twice: one replay per doc and version, never one per part. The same
 * rule exactly: verify the range against `quotedText`, re-find it if it
 * moved, and store the node's own `textBetween` at what that resolves to.
 * `labels` are the node's chip labels, for the selector's chip records.
 */
export function captureAnchorInNode(
  node: PMNode,
  from: number,
  to: number,
  quotedText: string,
  labels?: ChipLabels,
): { from: number; to: number; quotedText: string; selector: DocRangeSelector } | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || !quotedText.trim()) return null;
  const range = resolveAnchorInDoc(node, from, to, quotedText);
  if (!range) return null;
  return {
    ...range,
    quotedText: node.textBetween(range.from, range.to, " "),
    selector: deriveDocRangeSelector(node, range.from, range.to, labels),
  };
}
