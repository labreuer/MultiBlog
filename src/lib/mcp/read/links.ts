import { prisma } from "@/lib/prisma";
import { anchoredLinkLandingFor, linkPartsInto, type AnchoredLinkPart } from "@/lib/anchored-link-data";
import { anchoredLinkTitle } from "@/lib/anchored-link-name";
import { linkAnchorIds } from "@/lib/anchored-link-write";
import { resolveAnchorInDoc, shownQuote } from "@/lib/anchors";
import { blocksOfRange, headingAbove } from "@/lib/doc-text";
import { loadDocState, type DocState } from "@/lib/doc-state";
import { docTitleOrFallback } from "@/lib/doc-title";
import { displayNameOf } from "@/lib/display-name";
import { viewerOf } from "@/lib/actor";
import { notFound } from "@/lib/api/errors";
import type { McpContext, ToolResult } from "../tool";
import { clip, dayOf, decodeCursor, pageOf } from "../shape";
import type { ReadArgs } from "./args";
import { pdfLabels } from "./pdf-meta";

// docs/MCP.md §10 — reading a link, and the links into a doc or PDF.
//
// A link answers what the landing route decides for each viewer, as data:
// `anchoredLinkLandingFor` says whether it exists for this viewer, and
// `anchoredLinkForViewer` gives its parts, each group filtered by its own
// target's read rule and an unreadable group left out without a trace.

/** How much of a part's quote a list of links into a target carries. */
const QUOTE_CHARS = 200;

type Where = { blocks?: string; heading?: string; lost?: true };

/** Where a doc part resolves in the doc as read: its blocks and heading, or `lost` with its stored quote kept. */
function placeDocPart(
  state: DocState,
  part: { from: number | null; to: number | null; quotedText: string; selector: AnchoredLinkPart["selector"] },
): Where {
  const chips = part.selector?.kind === "DOC_RANGE" ? part.selector.selector.chips : undefined;
  const range =
    part.from !== null && part.to !== null && part.quotedText
      ? resolveAnchorInDoc(state.node, part.from, part.to, part.quotedText, undefined, chips)
      : null;
  if (!range) return { lost: true };
  const at = blocksOfRange(state.blocks, range.from, range.to);
  if (!at) return { lost: true };
  const heading = headingAbove(state.blocks, at.from);
  return {
    blocks: at.from === at.to ? String(at.from) : `${at.from}-${at.to}`,
    ...(heading && heading.number !== at.from ? { heading: heading.heading!.text } : {}),
  };
}

function quoteOf(part: AnchoredLinkPart | { quotedText: string; selector: AnchoredLinkPart["selector"] }, clipTo?: number) {
  const text = clipTo ? clip(shownQuote(part), clipTo) : shownQuote(part);
  if (part.selector?.kind === "PDF_TEXT") {
    const { prefix, suffix } = part.selector.selector.quote;
    return { quote: text, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
  }
  if (part.selector?.kind === "DOC_RANGE") {
    const { before, after } = part.selector.selector;
    return { quote: text, ...(before ? { prefix: before } : {}), ...(after ? { suffix: after } : {}) };
  }
  return { quote: text };
}

/** `read` of /link/<id>: the link and its parts, each resolved where it can be. */
export async function readLink(ctx: McpContext, linkId: string): Promise<ToolResult> {
  const landing = await anchoredLinkLandingFor(linkId, viewerOf(ctx.actor));
  if (landing.status === "not-found") throw notFound("That link");
  const url = `/link/${linkId}`;
  if (landing.status === "nothing-readable") {
    return { kind: "link", url, groups: [], note: "None of this link's passages are in anything you can read." };
  }
  const creator = landing.createdBy;
  // The creator edits the parts by number (edit_link), counted over all of
  // them in the link's order; nobody else is shown one, since a gap would
  // tell them a part they can't read exists.
  const numbers = landing.link.canEdit ? new Map((await linkAnchorIds(prisma, linkId)).map((id, i) => [id, i + 1])) : null;
  const numbered = (anchorId: string) => (numbers?.has(anchorId) ? { n: numbers.get(anchorId)! } : {});
  const groups = await Promise.all(
    landing.link.groups.map(async (group) => {
      if (group.target.kind === "doc") {
        const [doc, state] = await Promise.all([
          prisma.doc.findUnique({ where: { id: group.target.id }, select: { slug: true, title: true } }),
          loadDocState(group.target.id),
        ]);
        return {
          target: doc ? `/doc/${doc.slug}` : group.href,
          kind: "doc",
          title: docTitleOrFallback(group.label),
          version: state.version?.toString() ?? null,
          parts: group.parts.map((part) => ({ ...numbered(part.anchorId), ...quoteOf(part), ...placeDocPart(state, part) })),
        };
      }
      // The group's own address, less its ?sel=: the newest version holding a
      // part (docs/PDF.md §13, "Addresses"). A part on another version says
      // which, and its page and label are that version's.
      const target = group.href.split("?")[0];
      const labelsOf = new Map<string, string[] | null>();
      for (const part of group.parts) {
        if (part.version && !labelsOf.has(part.version.id)) labelsOf.set(part.version.id, await pdfLabels(part.version.id));
      }
      return {
        target,
        kind: "pdf",
        title: group.label,
        parts: group.parts.map((part) => {
          const pageIndex = part.selector?.kind === "PDF_TEXT" ? part.selector.selector.pageIndex : null;
          const labels = part.version ? labelsOf.get(part.version.id) : null;
          const elsewhere = part.version !== null && part.version.href.split("?")[0] !== target;
          return {
            ...numbered(part.anchorId),
            ...quoteOf(part),
            ...(elsewhere ? { version: part.version!.number } : {}),
            ...(pageIndex !== null ? { sheet: pageIndex + 1, ...(labels ? { page: labels[pageIndex] } : {}) } : {}),
          };
        }),
      };
    }),
  );
  return {
    kind: "link",
    url,
    name: anchoredLinkTitle(landing.link.name),
    by: displayNameOf(creator),
    ...(landing.mintedAt ? { minted: dayOf(landing.mintedAt) } : { draft: true }),
    ...(landing.editedAt ? { edited: dayOf(landing.editedAt) } : {}),
    groups,
  };
}

/**
 * The parts of every link into this doc or PDF, for `include: ["links"]`,
 * paged on their own under `links`. The caller has run the target's own read
 * gate.
 */
export async function linksInto(
  ctx: McpContext,
  target: { kind: "doc"; id: string; state: DocState } | { kind: "file"; id: string; versionId: string; versionAddressed: boolean },
  args: ReadArgs,
): Promise<ToolResult> {
  const every = await linkPartsInto({ kind: target.kind, id: target.id }, viewerOf(ctx.actor));
  // As a PDF's threads are listed (docs/PDF.md §13, "Addresses"): a version's
  // own address answers the parts on that version, and the bare one every
  // part, each on another version than the latest naming it.
  const parts = target.kind === "file" && target.versionAddressed ? every.filter((part) => part.fileVersion?.id === target.versionId) : every;
  const page = pageOf(parts, decodeCursor(args.links?.cursor, args.links?.limit ?? 20));
  const labelsOf = new Map<string, string[] | null>();
  if (target.kind === "file") {
    for (const part of page.items) {
      if (part.fileVersion && !labelsOf.has(part.fileVersion.id)) labelsOf.set(part.fileVersion.id, await pdfLabels(part.fileVersion.id));
    }
  }
  return {
    total: parts.length,
    parts: page.items.map((part) => {
      const labels = part.fileVersion ? labelsOf.get(part.fileVersion.id) : null;
      const where: Record<string, unknown> =
        target.kind === "doc"
          ? placeDocPart(target.state, part)
          : part.selector?.kind === "PDF_TEXT"
            ? {
                ...(part.fileVersion && part.fileVersion.id !== target.versionId ? { version: part.fileVersion.number } : {}),
                sheet: part.selector.selector.pageIndex + 1,
                ...(labels ? { page: labels[part.selector.selector.pageIndex] } : {}),
              }
            : {};
      return {
        link: `/link/${part.linkId}`,
        ...(part.linkName ? { name: part.linkName } : {}),
        ...(part.linkParts > 1 ? { of: part.linkParts } : {}),
        quote: clip(shownQuote(part), QUOTE_CHARS),
        ...where,
      };
    }),
    ...(page.next ? { next: page.next } : {}),
  };
}
