import type { ReactNode } from "react";
import type { Extensions, JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer";
import { chipRenderings, chipsInJSON, renderingsByIid, UNKNOWN_CHIP } from "./renderings";
import { ENTITY_CHIP, type ChipInputs, type ChipRendering } from "./types";

// docs/ENTITY_CHIPS.md — a doc or annotation body rendered outside an editor,
// with each chip showing its computed label. The node's own renderHTML has no
// label to give without an editor's state, so every static render of a body
// that can hold chips goes through `renderWithChips`.
//
// No "use client": the same function renders on the server (a page's first
// paint) and in the browser (a replayed revision).

/**
 * One chip as static markup, carrying the attributes the node's parse rule
 * reads, so a chip copied from a reading view pastes back as a chip. A live
 * one is the link it stands for.
 */
export function StaticChip({ attrs, rendering }: { attrs: Record<string, unknown>; rendering: ChipRendering }) {
  const shared = {
    className: "entity-chip",
    "data-entity-chip": String(attrs.kind ?? ""),
    "data-iid": String(attrs.iid ?? ""),
    "data-chip": JSON.stringify(attrs.data ?? {}),
    "data-status": rendering.status,
  };
  return rendering.status === "live" && rendering.href ? (
    <a {...shared} href={rendering.href}>
      {rendering.label}
    </a>
  ) : (
    <span {...shared}>{rendering.label}</span>
  );
}

/**
 * `content` as React elements, each chip drawn with its rendering under
 * `inputs`. In place of a bare `renderToReactElement` for any body whose
 * schema has the chip node.
 */
export function renderWithChips(content: JSONContent, extensions: Extensions, inputs: ChipInputs): ReactNode {
  const chips = chipsInJSON(content);
  if (chips.length === 0) return renderToReactElement({ content, extensions });
  const byIid = renderingsByIid(chips, chipRenderings(chips, inputs.styles, inputs.context));
  return renderToReactElement({
    content,
    extensions,
    options: {
      nodeMapping: {
        [ENTITY_CHIP]: ({ node }) => (
          <StaticChip
            key={String(node.attrs.iid)}
            attrs={node.attrs}
            rendering={byIid.get(String(node.attrs.iid)) ?? UNKNOWN_CHIP}
          />
        ),
      },
    },
  });
}
