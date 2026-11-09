import { Fragment, type ReactNode } from "react";
import type { Extensions, JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer";
import { RUN_TAGS, type InlineRun } from "../inline-markdown";
import { chipRenderings, chipsInJSON, renderingsByIid, UNKNOWN_CHIP } from "./renderings";
import { ENTITY_CHIP, type ChipInputs, type ChipRendering } from "./types";

// docs/ENTITY_CHIPS.md — a doc or annotation body rendered outside an editor,
// with each chip showing its computed label. The node's own renderHTML has no
// label to give without an editor's state, so every static render of a body
// that can hold chips goes through `renderWithChips`.
//
// No "use client": the same function renders on the server (a page's first
// paint) and in the browser (a replayed revision).

/** A label's runs as elements, each mark an element around its text. */
function ChipRuns({ runs }: { runs: readonly InlineRun[] }) {
  return runs.map((run, index) => {
    let shown: ReactNode = run.text;
    for (const mark of [...(run.marks ?? [])].reverse()) {
      const Tag = RUN_TAGS[mark];
      shown = <Tag>{shown}</Tag>;
    }
    return <Fragment key={index}>{shown}</Fragment>;
  });
}

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
  const shown = rendering.runs ? <ChipRuns runs={rendering.runs} /> : rendering.label;
  return rendering.status === "live" && rendering.href ? (
    <a {...shared} href={rendering.href}>
      {shown}
    </a>
  ) : (
    <span {...shared}>{shown}</span>
  );
}

/** The static renderer's own options: a surface's mappings for the nodes and marks it draws itself. */
export type StaticRenderOptions = NonNullable<Parameters<typeof renderToReactElement>[0]["options"]>;

/**
 * `content` as React elements, each chip drawn with its rendering under
 * `inputs`. In place of a bare `renderToReactElement` for any body whose
 * schema has the chip node. `options` are the surface's own mappings (a
 * comment draws its quotations), beside which the chip's is added.
 */
export function renderWithChips(content: JSONContent, extensions: Extensions, inputs: ChipInputs, options?: StaticRenderOptions): ReactNode {
  const chips = chipsInJSON(content);
  if (chips.length === 0) return renderToReactElement({ content, extensions, ...(options ? { options } : {}) });
  const byIid = renderingsByIid(chips, chipRenderings(chips, inputs.styles, inputs.context));
  return renderToReactElement({
    content,
    extensions,
    options: {
      ...options,
      nodeMapping: {
        ...options?.nodeMapping,
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
