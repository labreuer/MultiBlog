import { prisma } from "@/lib/prisma";
import {
  addLinkParts,
  canUserLinkTarget,
  docRangePartRow,
  editLinkParts,
  linkAnchorIds,
  mintLinks,
  pdfPartRow,
  renameLink,
  type LinkPartRow,
} from "@/lib/anchored-link-write";
import { ApiError, forbidden, invalid, notFound } from "@/lib/api/errors";
import { hasQuote } from "@/lib/quote-resolve";
import type { McpContext, ToolResult } from "./tool";
import { parse, readableContainer } from "./resolve";
import { anchorInDoc, type QuoteInput } from "./annotation-writes";
import { anchorPdfQuote } from "./pdf-anchoring";

// docs/MCP.md §10 — create_link, add_link_parts and edit_link, over
// src/lib/anchored-link-write.ts. A part is named the way an annotation's
// passage is: the doc or PDF, and a quote in it — on a doc at the version
// read, on a PDF narrowed by page or label. Every part is captured before
// anything is written, and one refusal refuses the call, naming the link and
// part it was.

export type PartInput = QuoteInput & { on: string };

/** One part, captured: its target read-checked and its quote found, or the refusal that names where. */
async function capturePart(ctx: McpContext, part: PartInput, where: Record<string, number>): Promise<LinkPartRow> {
  try {
    if (!hasQuote(part)) throw invalid("A link part names its passage: a quote, or start and end.");
    const container = await readableContainer(ctx.actor, part.on);
    const target = container.kind === "doc" ? { kind: "doc" as const, id: container.doc.id } : { kind: "file" as const, id: container.file.id };
    if (!(await canUserLinkTarget(ctx.actor, target))) throw forbidden("You can't link into that.");
    if (container.kind === "doc") {
      if (part.page !== undefined || part.label !== undefined) throw invalid("page and label narrow a quote on a PDF.");
      const at = await anchorInDoc(container.doc.id, part);
      return docRangePartRow(container.doc.id, at, at.stamp);
    }
    // A part whose quote doesn't verify against the stored page text is
    // refused (anchorPdfQuote), where the tray keeps one with an empty quote:
    // the quote and the quads come from the same text here, so a mismatch
    // means two normalisers disagree, which is worth surfacing.
    const at = await anchorPdfQuote(container.file, part);
    return pdfPartRow(container.file.id, at);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const place = Object.entries(where)
      .map(([key, n]) => `${key} ${n}`)
      .join(", ");
    throw new ApiError(err.code, `${place[0].toUpperCase()}${place.slice(1)}: ${err.message}`, { ...where, ...err.details });
  }
}

/** A link by its URL or id. */
function linkIdOf(ref: string): string {
  const parsed = parse(ref);
  if (parsed.kind === "link") return parsed.id;
  if (parsed.kind === "id") return parsed.id;
  throw invalid("Name a link by its /link/<id> URL or its id.");
}

async function partCount(linkId: string): Promise<number> {
  return (await linkAnchorIds(prisma, linkId)).length;
}

export async function createLinksFor(ctx: McpContext, links: { name?: string; parts: PartInput[] }[]): Promise<ToolResult> {
  const captured: { name: string | null; parts: LinkPartRow[] }[] = [];
  for (const [i, link] of links.entries()) {
    const parts: LinkPartRow[] = [];
    for (const [j, part] of link.parts.entries()) {
      parts.push(await capturePart(ctx, part, links.length > 1 ? { link: i + 1, part: j + 1 } : { part: j + 1 }));
    }
    captured.push({ name: link.name ?? null, parts });
  }
  const ids = await mintLinks(ctx.actor, captured);
  return {
    links: ids.map((id, i) => ({
      url: `/link/${id}`,
      ...(captured[i].name ? { name: captured[i].name } : {}),
      parts: captured[i].parts.length,
    })),
  };
}

export async function addLinkPartsFor(ctx: McpContext, input: { link: string; parts: PartInput[] }): Promise<ToolResult> {
  const linkId = linkIdOf(input.link);
  const parts: LinkPartRow[] = [];
  for (const [j, part] of input.parts.entries()) parts.push(await capturePart(ctx, part, { part: j + 1 }));
  await addLinkParts(ctx.actor, linkId, parts);
  return { url: `/link/${linkId}`, parts: await partCount(linkId) };
}

export async function editLinkFor(
  ctx: McpContext,
  input: { link: string; name?: string; remove?: number[]; order?: number[] },
): Promise<ToolResult> {
  const linkId = linkIdOf(input.link);
  const exists = await prisma.anchoredLink.findUnique({ where: { id: linkId }, select: { id: true } });
  if (!exists) throw notFound("That link");
  if (input.name === undefined && !input.remove?.length && !input.order) throw invalid("Say what to change: name, remove or order.");
  const changed: string[] = [];
  if (input.remove?.length || input.order) {
    await editLinkParts(ctx.actor, linkId, { remove: input.remove, order: input.order });
    if (input.remove?.length) changed.push("removed");
    if (input.order) changed.push("order");
  }
  if (input.name !== undefined) {
    await renameLink(ctx.actor, linkId, input.name);
    changed.push("name");
  }
  return { url: `/link/${linkId}`, changed, parts: await partCount(linkId) };
}
