import type { JSONContent } from "@tiptap/core";
import { CITATION, citationKind } from "./kinds/citation";
import type { MarkdownCitationItem } from "./kinds/citation-markdown";
import { MENTION } from "./kinds/mention";
import { isChip } from "./text";

// docs/ENTITY_CHIPS.md, MCP items 2 and 3 — the placeholders the chip parse
// leaves (markdown-import.ts): a chip holding what its Markdown named (a
// mention's handle, a citation's keys) and no instance id. Storing one is
// parsed-chips.ts's, under each chip kind's insertion rule; finding by one
// is `chipsForFinding`'s. Pure, so a quote's chip form is a unit table.

/** A mention placeholder's handle, or null for any other node. */
export function placeholderSlug(node: JSONContent): string | null {
  if (!isChip(node) || node.attrs?.kind !== MENTION) return null;
  const data = node.attrs?.data as Record<string, unknown> | undefined;
  return typeof data?.slug === "string" && typeof data.userId !== "string" ? data.slug : null;
}

/** A citation placeholder's works, as the Markdown named them, and the link around it, or null for any other node. */
export function placeholderCitation(
  node: JSONContent,
): { items: MarkdownCitationItem[]; narrative: boolean; referent: string | null; label: string } | null {
  if (!isChip(node) || node.attrs?.kind !== CITATION) return null;
  const data = node.attrs?.data as Record<string, unknown> | undefined;
  const items = data?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  if (!items.every((item) => typeof item?.key === "string" && item.refId === undefined)) return null;
  return {
    items: items as MarkdownCitationItem[],
    narrative: data?.form === "narrative",
    referent: typeof data?.referent === "string" ? data.referent : null,
    label: typeof data?.label === "string" ? data.label : "",
  };
}

export function walk(node: JSONContent, visit: (node: JSONContent) => JSONContent): JSONContent {
  const visited = visit(node);
  return visited.content ? { ...visited, content: visited.content.map((child) => walk(child, visit)) } : visited;
}

/** The handles and keys `content`'s placeholders name. */
export function placeholdersIn(content: JSONContent[]): { slugs: string[]; keys: string[] } {
  const slugs = new Set<string>();
  const keys = new Set<string>();
  walk({ type: "doc", content }, (node) => {
    const slug = placeholderSlug(node);
    if (slug !== null) slugs.add(slug);
    for (const item of placeholderCitation(node)?.items ?? []) keys.add(item.key);
    return node;
  });
  return { slugs: [...slugs], keys: [...keys] };
}

/**
 * `content` with every placeholder made the chip it names, for finding rather
 * than for storing (docs/ENTITY_CHIPS.md, MCP item 3): no insertion rule,
 * since nothing is inserted, and no refusal. A handle or key `lookup` doesn't
 * know is kept as itself, which is what a chip whose target is gone is written
 * with, so it finds that chip and no other. Null when there is no placeholder.
 */
export function chipsForFinding(
  content: JSONContent[],
  lookup: { user: (slug: string) => string | undefined; reference: (key: string) => string | undefined },
): JSONContent[] | null {
  let found = false;
  const resolved = walk({ type: "doc", content }, (node) => {
    const slug = placeholderSlug(node);
    if (slug !== null) {
      found = true;
      return { ...node, attrs: { kind: MENTION, iid: "", data: { userId: lookup.user(slug) ?? slug } } };
    }
    const citation = placeholderCitation(node);
    if (!citation) return node;
    found = true;
    const data = citationKind.validate({
      items: citation.items.map(({ key, ...fields }) => ({ ...fields, refId: lookup.reference(key) ?? key })),
      ...(citation.narrative ? { form: "narrative" } : {}),
      ...(citation.referent !== null ? { referent: citation.referent } : {}),
    });
    return data ? { ...node, attrs: { kind: CITATION, iid: "", data } } : node;
  });
  return found ? (resolved.content ?? []) : null;
}
