import type { JSONContent } from "@tiptap/core";
import type { Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { MENTION } from "./kinds/mention";
import { mentionableAmong } from "./kinds/mention-rule";
import { newChipIid } from "./node";
import { chipsInJSON, chipTargets } from "./renderings";
import { isChip } from "./text";

// docs/ENTITY_CHIPS.md, MCP items 2 and 6 — what a Markdown parse leaves to
// do before a chip can be stored. The parse (markdown-import.ts) reads each
// chip kind's syntax into a placeholder: a chip holding what the Markdown
// named (a mention's handle) and no instance id. This turns each into a real
// chip, or refuses.
//
// **One rule everywhere** (docs/MENTIONS.md): who may be named is the chip
// kind's insertion rule, the one its menu lists by, so a handle typed into
// Markdown can't get round what the menu offers. The exception is a chip the
// object already holds: an edit that rewrites the words around a mention
// writes that mention back, and must be able to whoever it names.
//
// Server-only.

/** A mention placeholder's handle, or null for any other node. */
function placeholderSlug(node: JSONContent): string | null {
  if (!isChip(node) || node.attrs?.kind !== MENTION) return null;
  const data = node.attrs?.data as Record<string, unknown> | undefined;
  return typeof data?.slug === "string" && typeof data.userId !== "string" ? data.slug : null;
}

function walk(node: JSONContent, visit: (node: JSONContent) => JSONContent): JSONContent {
  const visited = visit(node);
  return visited.content ? { ...visited, content: visited.content.map((child) => walk(child, visit)) } : visited;
}

/**
 * `content` with every chip placeholder resolved: its identity looked up, and
 * a fresh instance id given.
 *
 * `held` is the body the edit is of, as it stands (null for something new): a
 * chip it already holds may be written back whatever the insertion rule says
 * of its target now. `docId` is the doc the rule is asked about: the doc
 * itself, or the one a note is on, or null for a note on a PDF.
 *
 * Throws `unknown_chip` for a handle that names no account, or one this actor
 * may not mention here.
 */
export async function resolveParsedChips(
  content: JSONContent,
  actor: Actor,
  opts: { docId: string | null; held: JSONContent | null },
): Promise<JSONContent> {
  const slugs = new Set<string>();
  walk(content, (node) => {
    const slug = placeholderSlug(node);
    if (slug !== null) slugs.add(slug);
    return node;
  });
  if (slugs.size === 0) return content;

  const heldIds = new Set(opts.held ? (chipTargets(chipsInJSON(opts.held))[MENTION] ?? []) : []);
  // Deleted accounts included: a struck-through mention reads back as itself.
  const users = await prismaIncludingDeleted.user.findMany({ where: { slug: { in: [...slugs] } }, select: { id: true, slug: true } });
  const idOf = new Map(users.map((user) => [user.slug, user.id]));
  // A mention whose account is unknown was written with its stored id where
  // the handle goes, and reads back by it, if the body still holds it.
  for (const slug of slugs) if (!idOf.has(slug) && heldIds.has(slug)) idOf.set(slug, slug);

  const missing = [...slugs].filter((slug) => !idOf.has(slug));
  if (missing.length > 0) {
    throw new ApiError(
      "unknown_chip",
      `No account has the handle ${missing.map((slug) => `"${slug}"`).join(", ")}. find_users lists who can be mentioned; to write an @ that isn't a mention, escape it: [\\@name](…).`,
      { handles: missing },
    );
  }

  const asked = [...new Set([...idOf.values()].filter((id) => !heldIds.has(id)))];
  const allowed = new Set(await mentionableAmong(actor, opts.docId, asked));
  const refused = [...slugs].filter((slug) => {
    const id = idOf.get(slug)!;
    return !heldIds.has(id) && !allowed.has(id);
  });
  if (refused.length > 0) {
    throw new ApiError(
      "unknown_chip",
      `${refused.map((slug) => `"${slug}"`).join(", ")} can't be mentioned here. find_users lists who can be.`,
      { handles: refused },
    );
  }

  return walk(content, (node) => {
    const slug = placeholderSlug(node);
    if (slug === null) return node;
    return { ...node, attrs: { kind: MENTION, iid: newChipIid(), data: { userId: idOf.get(slug)! } } };
  });
}
