import type { Session } from "next-auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { DocVisibility } from "@/generated/prisma/enums";
import type { AccessRejection } from "@/lib/route-access";
import { canReadWikiDoc, readableWikiDocsWhere } from "@/lib/doc-authz";
import { userByOldSlug } from "@/lib/user-slug";
import { foldWikiName } from "@/lib/wiki-claim";
import {
  decodeSegment,
  parseOwnerSegment,
  pageSegment,
  parsePageSegment,
  wikiRedirect,
  type WikiOwner,
  type WikiPageName,
  type WikiRedirect,
  wikiPathOfDoc,
} from "@/lib/wiki-address";

// docs/WIKI.md "URLs", "Requests and responses" — the server half of a wiki
// route: finding an owner and a page, and the one resolution every route
// under /wiki/ asks, so the namespace list, the page and its editor answer a
// path alike. wiki-address.ts is the pure half; the read rule is
// canReadWikiDoc and readableWikiDocsWhere (doc-authz.ts). MCP's resolver
// asks the same lookups (src/lib/mcp/resolve.ts).

type Viewer = Session["user"] | null;

/** A namespace's owner as found: the commons, or a person, deleted or not, perhaps by an old slug. */
export type FoundOwner =
  | { kind: "commons" }
  | { kind: "person"; id: string; slug: string; deleted: boolean; viaOldSlug: boolean };

/** The owner id a page's row holds for a namespace: null for the commons'. */
export function ownerIdOf(owner: FoundOwner): string | null {
  return owner.kind === "person" ? owner.id : null;
}

/** A found owner as an address names it, by their current slug. */
export function wikiOwnerOf(owner: FoundOwner): WikiOwner {
  return owner.kind === "person" ? { kind: "person", slug: owner.slug } : { kind: "commons" };
}

/**
 * The namespace an owner segment names. **A person's pages outlive their
 * account**, so a person is found through prismaIncludingDeleted: through the
 * filtered client the soft-delete extension would hide a deleted owner, and
 * every one of their pages would 404 while its row was live. Unambiguous,
 * since User.slug is unique across deleted accounts too. An old slug finds
 * its account's current one (userByOldSlug), deleted accounts included. **A
 * bot has no namespace** (docs/WIKI.md "Permissions"): its slug answers as
 * an unknown owner's.
 */
export async function findWikiOwner(owner: WikiOwner): Promise<FoundOwner | null> {
  if (owner.kind === "commons") return { kind: "commons" };
  const user = await prismaIncludingDeleted.user.findUnique({
    where: { slug: owner.slug },
    select: { id: true, slug: true, deletedByUserId: true, worksForUserId: true },
  });
  if (user) {
    if (user.worksForUserId !== null) return null;
    return { kind: "person", id: user.id, slug: user.slug, deleted: user.deletedByUserId !== null, viaOldSlug: false };
  }
  const moved = await userByOldSlug(owner.slug, { includeDeleted: true });
  if (!moved) return null;
  const isBot = await prismaIncludingDeleted.user.count({ where: { id: moved.id, worksForUserId: { not: null } } });
  if (isBot > 0) return null;
  return { kind: "person", id: moved.id, slug: moved.slug, deleted: moved.deleted, viaOldSlug: true };
}

/**
 * The live page at an address, its name matched by key (docs/WIKI.md
 * "Case"): `Apple` finds a page stored as `apple`. `name` is one
 * parsePageSegment or checkWikiName gave back.
 */
export async function findWikiPage<S extends Prisma.DocSelect>(
  ownerId: string | null,
  name: string,
  variant: string,
  select: S,
): Promise<Prisma.DocGetPayload<{ select: S }> | null> {
  const { key } = await foldWikiName(prismaIncludingDeleted, name);
  return prismaIncludingDeleted.doc.findFirst({
    where: { wikiOwnerUserId: ownerId, wikiNameKey: key, wikiName: { not: null }, wikiVariant: variant, deletedByUserId: null },
    select,
  }) as Promise<Prisma.DocGetPayload<{ select: S }> | null>;
}

/** What an old address's lookup reads of each page it might send a viewer to. */
const OLD_ADDRESS_DOC_SELECT = {
  id: true,
  slug: true,
  visibility: true,
  wikiName: true,
  wikiVariant: true,
  deletedByUserId: true,
  wikiOwner: { select: { slug: true } },
} as const;

/**
 * Where an old address sends a viewer (docs/WIKI.md "Renaming"): the page
 * whose reserved row holds it, else the newest page whose released row names
 * it, the first of those `readable` says the viewer may read. Asked only once
 * no live page at the address answers. The path is the page's address now, or
 * `/doc/<slug>` for a doc moved out of the wiki. Null when there is none the
 * viewer may read, which answers as a missing page does, so an old address
 * never says whether a page they can't read was there.
 */
export async function oldAddressTarget(
  ownerId: string | null,
  name: string,
  variant: string,
  readable: (doc: { id: string; visibility: DocVisibility; wikiName: string | null; deletedByUserId: string | null }) => Promise<boolean>,
): Promise<{ docId: string; path: string } | null> {
  const { key } = await foldWikiName(prismaIncludingDeleted, name);
  const rows = await prismaIncludingDeleted.wikiAddressHistory.findMany({
    where: { ownerUserId: ownerId, nameKey: key, variant, doc: { deletedByUserId: null } },
    orderBy: [{ reserved: "desc" }, { createdAt: "desc" }],
    select: { doc: { select: OLD_ADDRESS_DOC_SELECT } },
  });
  for (const { doc } of rows) {
    if (!(await readable(doc))) continue;
    const path = wikiPathOfDoc({ wikiName: doc.wikiName, wikiVariant: doc.wikiVariant, ownerSlug: doc.wikiOwner?.slug ?? null });
    return { docId: doc.id, path: path ?? `/doc/${doc.slug}` };
  }
  return null;
}

/** What a namespace list shows of each page. */
export const WIKI_LIST_SELECT = { id: true, wikiName: true, wikiVariant: true, visibility: true } as const;
export type WikiListPage = Prisma.DocGetPayload<{ select: typeof WIKI_LIST_SELECT }>;

/**
 * The pages of one namespace the viewer may read, by the wiki read rule,
 * newest edit first: by the update the cached text is of, since updatedAt
 * also moves on byline, visibility and slug changes. Nulls last, then by
 * when the page was made: a page nobody has edited has no update id stamped
 * (docs/WIKI.md "The `wiki` option").
 */
export async function readableWikiPages(owner: FoundOwner, viewer: Viewer, opts: { take?: number } = {}): Promise<WikiListPage[]> {
  return prismaIncludingDeleted.doc.findMany({
    where: { AND: [readableWikiDocsWhere(viewer), { wikiName: { not: null }, wikiOwnerUserId: ownerIdOf(owner) }] },
    orderBy: [{ proseJsonUpdateId: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: opts.take,
    select: WIKI_LIST_SELECT,
  });
}

/**
 * A route's params as the loader takes them, decoded once (docs/WIKI.md "The
 * owner segment"). Next 16.2.11 hands a page its params percent-encoded and
 * `generateMetadata` the same params already decoded, so the page passes
 * `encoded: true` and the metadata doesn't; decoded twice, `%2541` would name
 * the page `A`, and a name with a bare `%` (`100% pure`) would throw. Both
 * hand the loader the same strings, which its per-request memo keys on. Null
 * when a param isn't valid percent-encoding, which Next answers with a 400
 * before the route runs, so only a hand-made call meets it.
 */
export function routeSegments(params: readonly string[], opts: { encoded: boolean }): string[] | null {
  if (!opts.encoded) return [...params];
  const decoded = params.map(decodeSegment);
  return decoded.some((segment) => segment === null) ? null : (decoded as string[]);
}

/** A query string to keep across a redirect, as `?…` or "". Every redirect under /wiki/ keeps it. */
export function searchOf(searchParams: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** How a route under /wiki/ answers a path, before its own rules. */
export type WikiPathAnswer<T> =
  /** Outside the grammar, a reserved or held owner segment: a 404 for everyone. */
  | { kind: "not-found" }
  /** Nothing there the viewer may read: the sign-in redirect signed out, a 404 signed in. */
  | { kind: "absent" }
  | { kind: "redirect"; redirect: WikiRedirect }
  | { kind: "ok"; owner: FoundOwner; page: WikiPageName | null; value: T };

/** What a route's `find` returns: its value, and for a page, the page's stored name and variant, which a path in other capitals is sent on to. */
export type WikiFound<T> = { value: T; page?: WikiPageName };

/**
 * Resolves `/wiki/<owner>[/<page>][/<sub-path>…]` for a viewer, as each
 * route under /wiki/ asks: its segments **decoded once** (routeSegments),
 * and `find`, which reads what the path names in the namespace found and
 * returns null when there is nothing there the viewer may read.
 *
 * - **The fixed redirects**, for everyone, as a 308 (wikiRedirect):
 *   uppercase in the owner, the variant or a sub-path, `common`, and a name
 *   not spelled as wikiPagePath spells it.
 * - **The reader-only hops**, added only when the viewer may read what the
 *   path names: the page's stored name, when the path named it in other
 *   capitals ("Case"); and, given `viewer`, the page an old address sends
 *   them to, when no live page there answers ("Renaming"), by the wiki read
 *   rule. Each makes the one hop a 307, and an old address's keeps the
 *   sub-path.
 * - **An old user slug** sends everyone on to the current one, as a 307,
 *   but **a deleted account's only a viewer who may read what the path
 *   names**; anyone else gets the answer for an unknown owner, since
 *   /authors/ 404s for a deleted account and a redirect given to anyone
 *   would tell a signed-out visitor that one held this slug.
 * - An unknown owner, and anything the viewer may not read, are alike.
 */
export async function resolveWikiPath<T>(
  segments: readonly string[],
  find: (owner: FoundOwner, page: WikiPageName | null) => Promise<WikiFound<T> | null>,
  opts: { oldAddressesFor?: { viewer: Viewer } } = {},
): Promise<WikiPathAnswer<T>> {
  if (segments.length === 0) return { kind: "not-found" };
  const fixed = wikiRedirect(segments);

  let ownerText = segments[0].toLowerCase();
  if (ownerText === "common") ownerText = "commons";
  const ownerSegment = parseOwnerSegment(ownerText);
  if (!ownerSegment) return { kind: "not-found" };
  if (ownerSegment.kind === "reserved" || ownerSegment.kind === "held") {
    // Uppercase is lowercased (`/wiki/NEW` to /wiki/new, a route of its
    // own); otherwise a reserved or held segment names no namespace here.
    return fixed ? { kind: "redirect", redirect: fixed } : { kind: "not-found" };
  }
  let page: WikiPageName | null = null;
  if (segments.length > 1) {
    const [rawName, ...variantParts] = segments[1].split("~");
    const asked = variantParts.length === 1 ? `${rawName}~${variantParts[0].toLowerCase()}` : segments[1];
    page = parsePageSegment(asked);
    if (!page) return { kind: "not-found" };
  }

  const owner = await findWikiOwner(ownerSegment);
  if (!owner) return fixed ? { kind: "redirect", redirect: fixed } : { kind: "absent" };
  const found = await find(owner, page);
  const ownerHop = owner.kind === "person" && owner.viaOldSlug ? { ownerSlug: owner.slug } : {};

  if (found) {
    const hopped = wikiRedirect(segments, "", { ...ownerHop, page: found.page });
    return hopped ? { kind: "redirect", redirect: hopped } : { kind: "ok", owner, page: found.page ?? page, value: found.value };
  }
  if (page && opts.oldAddressesFor) {
    const { viewer } = opts.oldAddressesFor;
    const target = await oldAddressTarget(ownerIdOf(owner), page.name, page.variant, (doc) => canReadWikiDoc(viewer, doc));
    // The sub-path as the fixed redirects would leave it, lowercased; one
    // outside the grammar is a 404, as it would be at the page itself.
    const rest = segments.slice(2).map((sub) => sub.toLowerCase());
    if (target && rest.every((sub) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(sub))) {
      return { kind: "redirect", redirect: { path: [target.path, ...rest].join("/"), permanent: false } };
    }
  }
  if (owner.kind === "person" && owner.viaOldSlug && !owner.deleted) {
    const moved = wikiRedirect(segments, "", ownerHop);
    if (moved) return { kind: "redirect", redirect: moved };
  }
  return fixed ? { kind: "redirect", redirect: fixed } : { kind: "absent" };
}

/** A wiki redirect as a route loader's rejection: a 308 when permanent, else a 307. */
export function redirectRejection(redirect: WikiRedirect): AccessRejection {
  return redirect.permanent ? { redirect: redirect.path, permanent: true } : { redirect: redirect.path };
}

/**
 * The path a signed-out reader is signed in onto (docs/WIKI.md "Requests and
 * responses"), built from the decoded segments by wikiPagePath's encoding,
 * with the sub-path and the query string. Built from the param as given, it
 * would be the page's re-encoded spelling (`/wiki/%40jane/R%26D_(lab)`), a
 * path the canonical test, being on decoded segments, never redirects, so the
 * reader would be signed in onto it and stay there.
 */
export function wikiReturnPath(segments: readonly string[], search: string): string {
  const [owner, page, ...rest] = segments;
  const parts = [owner];
  if (page !== undefined) {
    const parsed = parsePageSegment(page);
    parts.push(parsed ? pageSegment(parsed) : encodeURIComponent(page));
  }
  parts.push(...rest);
  return `/wiki/${parts.join("/")}${search}`;
}
