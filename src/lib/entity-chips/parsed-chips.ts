import type { JSONContent } from "@tiptap/core";
import type { Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { markdownToBlocks } from "@/lib/markdown-import";
import type { ChipQuoteForm, QuoteSpec } from "@/lib/quote-resolve";
import { referencesByKeys } from "@/lib/reference-data";
import { CITATION, citationKind, markdownDestination, referentKind, type CitationItem } from "./kinds/citation";
import { MENTION, MENTION_HREF_PREFIX } from "./kinds/mention";
import { mentionableAmong } from "./kinds/mention-rule";
import { newChipIid } from "./node";
import { chipsForFinding, placeholderCitation, placeholderSlug, placeholdersIn, walk } from "./placeholders";
import { chipsInJSON, chipTargets } from "./renderings";

// docs/ENTITY_CHIPS.md, MCP items 2 and 6 — what a Markdown parse leaves to
// do before a chip can be stored. The parse (markdown-import.ts) reads each
// chip kind's syntax into a placeholder: a chip holding what the Markdown
// named (a mention's handle, a citation's keys) and no instance id. This
// turns each into a real chip, or refuses.
//
// **One rule everywhere** (docs/MENTIONS.md): who may be named is the chip
// kind's insertion rule, the one its menu lists by, so a handle typed into
// Markdown can't get round what the menu offers. The exception is a chip the
// object already holds: an edit that rewrites the words around a mention
// writes that mention back, and must be able to whoever it names.
//
// Server-only.

/** A placeholder as the link its Markdown also is: the words it showed, linked to the author page it named. */
function asLink(node: JSONContent, slug: string): JSONContent {
  const label = (node.attrs?.data as Record<string, unknown> | undefined)?.label;
  return {
    type: "text",
    text: typeof label === "string" && label ? label : `@${slug}`,
    marks: [{ type: "link", attrs: { href: `${MENTION_HREF_PREFIX}${slug}` } }],
  };
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
 * may not mention here, and for a key that names no reference, or a deleted
 * one. With `unresolved: "link"` it leaves such a mention as the link its
 * Markdown also is: a person importing a file exported from another instance
 * shouldn't lose the file to one handle this instance doesn't have. A
 * citation has no such fallback, since an unknown key kept as text would
 * quietly stop being a citation (docs/CITATIONS.md, "Markdown").
 */
export async function resolveParsedChips(
  content: JSONContent,
  actor: Actor,
  opts: { docId: string | null; held: JSONContent | null; unresolved?: "refuse" | "link" },
): Promise<JSONContent> {
  const mentionable = (ids: string[]) => mentionableAmong(actor, opts.docId, ids);
  return resolveCitations(await resolveMentions(content, { ...opts, mentionable }), opts.held);
}

/**
 * The same for a comment body (docs/ENTITY_CHIPS.md, "Chips in
 * comments"), whose rule for who may be named is its own (`mentionable`,
 * comment-chips.ts) and whose commenter may be signed out. A mention the rule
 * refuses, or a handle nobody has, stays the link its Markdown also is, as an
 * import leaves one; a key that names no reference refuses, as anywhere.
 */
export async function resolveParsedCommentChips(
  content: JSONContent,
  opts: { held: JSONContent | null; mentionable: (userIds: string[]) => Promise<string[]> },
): Promise<JSONContent> {
  return resolveCitations(await resolveMentions(content, { ...opts, unresolved: "link" }), opts.held);
}

async function resolveMentions(
  content: JSONContent,
  opts: { held: JSONContent | null; unresolved?: "refuse" | "link"; mentionable: (userIds: string[]) => Promise<string[]> },
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

  const lenient = opts.unresolved === "link";
  const missing = [...slugs].filter((slug) => !idOf.has(slug));
  if (missing.length > 0 && !lenient) {
    throw new ApiError(
      "unknown_chip",
      `No account has the handle ${missing.map((slug) => `"${slug}"`).join(", ")}. find_users lists who can be mentioned; to write an @ that isn't a mention, escape it: [\\@name](…).`,
      { handles: missing },
    );
  }

  const asked = [...new Set([...idOf.values()].filter((id) => !heldIds.has(id)))];
  const allowed = new Set(await opts.mentionable(asked));
  const refused = [...slugs].filter((slug) => {
    const id = idOf.get(slug);
    return id !== undefined && !heldIds.has(id) && !allowed.has(id);
  });
  if (refused.length > 0 && !lenient) {
    throw new ApiError(
      "unknown_chip",
      `${refused.map((slug) => `"${slug}"`).join(", ")} can't be mentioned here. find_users lists who can be.`,
      { handles: refused },
    );
  }

  const unresolved = new Set([...missing, ...refused]);
  return walk(content, (node) => {
    const slug = placeholderSlug(node);
    if (slug === null) return node;
    if (unresolved.has(slug)) return asLink(node, slug);
    return { ...node, attrs: { kind: MENTION, iid: newChipIid(), data: { userId: idOf.get(slug)! } } };
  });
}

const keyList = (keys: readonly string[]) => keys.map((key) => `"${key}"`).join(", ");

/**
 * Each citation placeholder as a citation of the references its keys name. A
 * key a reference used to have still names it. A deleted reference may be
 * cited only where the body already cites it, as a struck-through citation
 * written back; so may a work the library no longer has, written by its id.
 */
async function resolveCitations(content: JSONContent, held: JSONContent | null): Promise<JSONContent> {
  const keys = new Set<string>();
  walk(content, (node) => {
    for (const item of placeholderCitation(node)?.items ?? []) keys.add(item.key);
    return node;
  });
  if (keys.size === 0) return content;

  const heldIds = new Set(held ? (chipTargets(chipsInJSON(held))[CITATION] ?? []) : []);
  const found = await referencesByKeys([...keys]);
  const idOf = new Map<string, string>();
  const missing: string[] = [];
  const deleted: string[] = [];
  for (const key of keys) {
    const reference = found.get(key);
    if (reference && (!reference.deleted || heldIds.has(reference.id))) idOf.set(key, reference.id);
    else if (reference) deleted.push(key);
    else if (heldIds.has(key)) idOf.set(key, key);
    else missing.push(key);
  }
  if (missing.length > 0) {
    // A key read from a link's text was a link before a link around one citation was that citation: say how it stays one.
    const links = linkedPlaceholders(content).filter((citation) => citation.items.some((item) => missing.includes(item.key)));
    const asLinks = links.length > 0 ? ` To keep ${links.length > 1 ? "these links" : "this link"} a link, escape the @: ${links.map(escapedLink).join(", ")}.` : "";
    throw new ApiError(
      "unknown_chip",
      `No reference has the key ${keyList(missing)}. find_refs lists the library's keys. An @ before a word is a citation, and so is a link whose whole text is one: for a mention write [@Name](/authors/<slug>), and for a literal @, \\@.${asLinks}`,
      { keys: missing, ...(links.length > 0 ? { links: links.map(escapedLink) } : {}) },
    );
  }
  if (deleted.length > 0) {
    throw new ApiError("unknown_chip", `The reference${deleted.length > 1 ? "s" : ""} ${keyList(deleted)} ${deleted.length > 1 ? "were" : "was"} deleted, and can't be cited until restored.`, {
      keys: deleted,
      deleted: true,
    });
  }

  return walk(content, (node) => {
    const citation = placeholderCitation(node);
    if (!citation) return node;
    const data = citationKind.validate({
      items: citation.items.map(({ key, ...fields }) => ({ ...fields, refId: idOf.get(key)! })),
      ...(citation.narrative ? { form: "narrative" } : {}),
      ...(citation.referent !== null ? { referent: citation.referent } : {}),
    });
    // Validation keeps only so many works, and a citation it shortened would lose some unseen.
    if (!data || data.items.length !== citation.items.length) {
      throw new ApiError("invalid", `The citation ${citation.label} names more works than one citation can hold.`);
    }
    // Nor does it keep a referent the citation can't take, which would be lost unseen too.
    if (citation.referent !== null && data.referent === undefined) throw referentRefused(citation, data.items);
    return { ...node, attrs: { kind: CITATION, iid: newChipIid(), data } };
  });
}

/** Every citation placeholder in `content` that a link's text gave, as `placeholderCitation` reads it. */
function linkedPlaceholders(content: JSONContent): NonNullable<ReturnType<typeof placeholderCitation>>[] {
  const found: NonNullable<ReturnType<typeof placeholderCitation>>[] = [];
  walk(content, (node) => {
    const citation = placeholderCitation(node);
    if (citation?.referent !== null && citation !== null) found.push(citation);
    return node;
  });
  return found;
}

/** The link a linked citation was, with the `@` of its text escaped so that it reads back as that link. */
function escapedLink(citation: { label: string; referent: string | null }): string {
  return `[${citation.label.replace(/^(\[?)@/, "$1\\@")}](${markdownDestination(citation.referent ?? "")})`;
}

/** Why a citation can't take the referent its link gave it (docs/CITATIONS.md, "What a referent may be"). */
function referentRefused(citation: { label: string; referent: string | null }, items: readonly CitationItem[]): ApiError {
  const written = `[${citation.label}](${citation.referent})`;
  const kind = referentKind(citation.referent ?? "");
  if (kind === null) {
    return new ApiError(
      "invalid",
      `${written}: a citation's link points at quote:prev or quote:next, the quotation before or after it; a /pdf/ fragment link into the work's PDF; a /link/<id>; another path on this site; or an https URL.`,
    );
  }
  const why = new Set(items.map((item) => item.refId)).size > 1 ? "it cites several works" : "it names no page";
  return new ApiError(
    "invalid",
    `${written}: ${kind === "quote" ? "a quotation" : "a /pdf/ passage"} is looked for on the cited page, and ${why}. Cite one work at a page, or point it at a /link/<id>.`,
  );
}

/** `content`'s placeholders as the chips they name (`chipsForFinding`), each handle and key looked up, deleted targets included. */
async function lookUpForFinding(content: JSONContent[]): Promise<JSONContent[] | null> {
  const { slugs, keys } = placeholdersIn(content);
  if (slugs.length === 0 && keys.length === 0) return null;
  const users = slugs.length > 0 ? await prismaIncludingDeleted.user.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } }) : [];
  const userOf = new Map(users.map((user) => [user.slug, user.id]));
  const references = await referencesByKeys(keys);
  return chipsForFinding(content, { user: (slug) => userOf.get(slug), reference: (key) => references.get(key)?.id });
}

/**
 * `spec` with its parts read through the chip parse (`QuoteSpec.chips`), when
 * any of them holds a chip's syntax: what lets `resolveQuote` find a chip by
 * the Markdown a read wrote for it. Unchanged when none does.
 */
export async function withQuoteChips<T extends QuoteSpec>(spec: T): Promise<T> {
  const names = ["quote", "start", "end", "prefix", "suffix"] as const;
  // Every chip kind's syntax has an `@` in it; most quotes have none.
  if (!names.some((name) => spec[name]?.includes("@"))) return spec;
  const chips: ChipQuoteForm = {};
  let found = false;
  for (const name of names) {
    const part = spec[name];
    if (part === undefined) continue;
    let blocks: JSONContent[];
    try {
      blocks = markdownToBlocks(part, { chips: true });
    } catch {
      return spec;
    }
    const resolved = await lookUpForFinding(blocks);
    if (resolved) found = true;
    chips[name] = resolved ?? blocks;
  }
  return found ? { ...spec, chips } : spec;
}
