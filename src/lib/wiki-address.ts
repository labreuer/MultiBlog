import { slugify } from "@/lib/slug";
import { checkWikiName } from "@/lib/wiki-name";

// docs/WIKI.md "Names" and "URLs" — a wiki page's address,
// `/wiki/<owner>/<name>[~<variant>]`: parsing it from decoded route segments,
// building it (`wikiPagePath`, which alone knows the encoding), the fixed
// redirects a path under /wiki/ can need, the reserved owner segments, the
// commons names held for editors, the email-slug test and the default variant
// sequences. Pure and browser-safe: the routes, the server's address claims
// and the dialogs that preview a default all ask the same functions.
// wiki-address.test.ts is its table.
//
// - `@<user-slug>` is a person's namespace, `commons` the commons'. Every
//   other unprefixed segment is held: the reserved words below for fixed
//   routes, the rest for groups later.
// - The page segment is a name, spaces written `_`, then `~<variant>` when
//   the page is a variant. No name holds `~` (wiki-name.ts), so the split is
//   unambiguous.
// - Every function here takes segments **decoded once**. Next hands a page
//   its params percent-encoded (`@` arrives as `%40`) and `generateMetadata`
//   the same params decoded, so each caller decodes what it was given, or
//   not, with `decodeSegment`; decoded twice, `%2541` would name the page `A`.

/** A slug as `slugify` writes one: no leading, trailing or doubled dash. A variant, an owner's slug and a sub-path segment are each one. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isWikiVariant(text: string): boolean {
  return text === "" || SLUG.test(text);
}

/**
 * The unprefixed owner segments. Only `commons`, `common` (a permanent
 * redirect to `commons`), `new` and `special` do anything; the rest are held
 * so that nothing, a group included, can take them first. User slugs stay
 * unreserved: this constrains only unprefixed segments.
 */
export const RESERVED_OWNER_SEGMENTS = [
  "commons",
  "common",
  "new",
  "all",
  "recent",
  "search",
  "random",
  "me",
  "help",
  "compare",
  "special",
] as const;

export type ReservedOwnerSegment = (typeof RESERVED_OWNER_SEGMENTS)[number];

/**
 * docs/WIKI.md "Permissions" — commons names whose claim needs an ADMIN or
 * EDITOR, whatever the variant: `Front Page`, whose page is the landing
 * page's preamble, and `About`. Compared by key, in the claim's statement, so
 * any capitals are held too. A person's namespace holds none.
 */
export const HELD_COMMONS_NAMES = ["Front Page", "About"] as const;

/** Whose namespace a page is in. */
export type WikiOwner = { kind: "person"; slug: string } | { kind: "commons" };

/** What an owner segment can be: a namespace, a reserved word, or an unprefixed slug held for groups. */
export type OwnerSegment =
  | WikiOwner
  | { kind: "reserved"; word: Exclude<ReservedOwnerSegment, "commons"> }
  | { kind: "held"; slug: string };

/** A page's place in a namespace: its name as stored, and its variant, "" for the page itself. */
export type WikiPageName = { name: string; variant: string };

export type WikiAddress = WikiPageName & { owner: WikiOwner };

/** A route param decoded once, or null when it isn't valid percent-encoding. */
export function decodeSegment(param: string): string | null {
  try {
    return decodeURIComponent(param);
  } catch {
    return null;
  }
}

/** An owner segment, decoded, in the grammar; null outside it. Case matters: uppercase is a redirect's business (wikiRedirect). */
export function parseOwnerSegment(segment: string): OwnerSegment | null {
  if (segment.startsWith("@")) {
    const slug = segment.slice(1);
    return SLUG.test(slug) ? { kind: "person", slug } : null;
  }
  if (!SLUG.test(segment)) return null;
  if (segment === "commons") return { kind: "commons" };
  if ((RESERVED_OWNER_SEGMENTS as readonly string[]).includes(segment)) {
    return { kind: "reserved", word: segment as Exclude<ReservedOwnerSegment, "commons"> };
  }
  return { kind: "held", slug: segment };
}

/**
 * A page segment, decoded: a name, then `~<variant>` or nothing. The name is
 * normalized as any name is (wiki-name.ts), `_` folding to a space; null when
 * the rules refuse it, when there is more than one `~` or an empty one, or
 * when the variant isn't a slug. Uppercase in the variant is outside the
 * grammar: a redirect's business, as in the owner.
 */
export function parsePageSegment(segment: string): WikiPageName | null {
  const parts = segment.split("~");
  if (parts.length > 2) return null;
  const [rawName, variant = ""] = parts;
  if (parts.length === 2 && !SLUG.test(variant)) return null;
  const name = checkWikiName(rawName);
  return name.ok ? { name: name.name, variant } : null;
}

/**
 * A namespace or page address from decoded route segments, or null for
 * anything that isn't one: a reserved or held owner segment, a segment
 * outside the grammar, or a name the rules refuse. A name not spelled as
 * wikiPagePath spells it still parses, to its normalized form; the route has
 * answered it with wikiRedirect first.
 */
export function parseWikiAddress(segments: { owner: string; page: string }): WikiAddress | null;
export function parseWikiAddress(segments: { owner: string }): { owner: WikiOwner } | null;
export function parseWikiAddress(segments: { owner: string; page?: string }): { owner: WikiOwner } | WikiAddress | null {
  const owner = parseOwnerSegment(segments.owner);
  if (!owner || (owner.kind !== "person" && owner.kind !== "commons")) return null;
  if (segments.page === undefined) return { owner };
  const page = parsePageSegment(segments.page);
  return page ? { owner, ...page } : null;
}

/** An owner's segment, with its `@` written as it is: encoded, it would reach the address bar as `%40`. */
export function ownerSegment(owner: WikiOwner): string {
  return owner.kind === "person" ? `@${owner.slug}` : "commons";
}

/**
 * What a path segment may carry as it is, beyond what encodeURIComponent
 * already leaves: RFC 3986's sub-delims, `:` and `@`. encodeURIComponent
 * leaves `! ' ( ) *` alone and encodes the rest of these, so they are put
 * back, and `! $ & ' ( ) * + , ; = : @` stay readable in an address.
 */
const READABLE: Record<string, string> = {
  "%24": "$",
  "%26": "&",
  "%2B": "+",
  "%2C": ",",
  "%3B": ";",
  "%3D": "=",
  "%3A": ":",
  "%40": "@",
};

/** A name as its URL writes it: each space `_`, the rest percent-encoded but for what a segment may carry as it is. */
export function wikiNameSegment(name: string): string {
  return encodeURIComponent(name)
    .replace(/%(24|26|2B|2C|3B|3D|3A|40)/g, (code) => READABLE[code])
    .replace(/%20/g, "_");
}

/** A page's segment, encoded: `Mercury_(planet)`, `Mercury_(planet)~2`. */
export function pageSegment(page: WikiPageName): string {
  const name = wikiNameSegment(page.name);
  return page.variant ? `${name}~${page.variant}` : name;
}

/** A namespace's list, `/wiki/@jane` or `/wiki/commons`. */
export function wikiNamespacePath(owner: WikiOwner): string {
  return `/wiki/${ownerSegment(owner)}`;
}

/** A page's address, `/wiki/<owner>/<name>[~<variant>]`, encoded. Every path to a page goes through this. */
export function wikiPagePath(address: WikiAddress): string {
  return `${wikiNamespacePath(address.owner)}/${pageSegment(address)}`;
}

/**
 * docs/WIKI.md "Labels" — a page's label, its address as stored:
 * `@jane/Mercury (planet)~2`, `commons/Mercury (planet)`. The name appears
 * with its spaces; only a link's path uses `_` and encoding. No name holds
 * `/` or `~`, so the delimiters are unambiguous.
 */
export function wikiLabel(address: WikiAddress): string {
  const page = address.variant ? `${address.name}~${address.variant}` : address.name;
  return `${ownerSegment(address.owner)}/${page}`;
}

/** The columns an address is made from, with the owner's current slug (null for the commons). */
export type WikiDocColumns = { wikiName: string | null; wikiVariant: string; ownerSlug: string | null };

/** A wiki doc's address from its columns, or null for a doc that isn't a wiki page. */
export function wikiAddressOfDoc(doc: WikiDocColumns): WikiAddress | null {
  if (doc.wikiName === null) return null;
  return {
    owner: doc.ownerSlug === null ? { kind: "commons" } : { kind: "person", slug: doc.ownerSlug },
    name: doc.wikiName,
    variant: doc.wikiVariant,
  };
}

/** wikiAddressOfDoc as a path. */
export function wikiPathOfDoc(doc: WikiDocColumns): string | null {
  const address = wikiAddressOfDoc(doc);
  return address && wikiPagePath(address);
}

export type WikiRedirect = { path: string; permanent: boolean };

/**
 * Hops only the route can add, for a viewer who may read the page
 * (docs/WIKI.md "Case", "Renaming", "URLs"): the owner's current slug, when
 * the path named an old one, and the page's stored name and variant, when
 * the path named it in other capitals or at an old address. Each makes the
 * redirect a 307, since what it answers depends on who asks and can change.
 */
export type ReaderHops = { ownerSlug?: string; page?: WikiPageName };

/**
 * The redirect a path under /wiki/ needs, if any. There is no middleware, so
 * each route asks this with its decoded segments (`[owner]`, `[owner, page]`,
 * `[owner, page, "edit"]`, a catch-all's whole path) and the query string to
 * keep, as `?…` or "". The fixed redirects, permanent and for everyone, since
 * each is a function of the URL that reveals nothing:
 *
 * - **uppercase in the owner, the variant or a sub-path, lowercased**; the
 *   name is never lowercased;
 * - **`common` to `commons`**;
 * - **a name not spelled as wikiPagePath spells it**: a space typed as `%20`,
 *   a run of `_` or one at an end, a decomposed accent, a bidi mark.
 *
 * A path outside the grammar once those are applied gets none, and the route
 * answers 404. The route adds its reader-only hops through `hops`; a path
 * needing more than one redirect gets one hop, a 307 if any is. The test is
 * on decoded segments: Next re-encodes a param with uppercase hex, so a test
 * on the param as given would redirect `%C3%A9` to `%c3%a9` and back forever.
 */
export function wikiRedirect(segments: readonly string[], search = "", hops: ReaderHops = {}): WikiRedirect | null {
  if (segments.length === 0) return null;
  let ownerText = segments[0].toLowerCase();
  if (ownerText === "common") ownerText = "commons";
  const owner = parseOwnerSegment(ownerText);
  if (!owner) return null;
  if (segments.length > 1 && owner.kind !== "person" && owner.kind !== "commons") return null;
  let permanent = true;
  if (hops.ownerSlug !== undefined && owner.kind === "person" && owner.slug !== hops.ownerSlug) {
    ownerText = `@${hops.ownerSlug}`;
    permanent = false;
  }
  // Each target segment twice: decoded, to compare with what was asked for,
  // and as the path writes it.
  const decoded = [ownerText];
  const encoded = [ownerText];

  if (segments.length > 1) {
    const [rawName, ...variantParts] = segments[1].split("~");
    if (variantParts.length > 1) return null;
    const asked = variantParts.length === 1 ? `${rawName}~${variantParts[0].toLowerCase()}` : rawName;
    let page = parsePageSegment(asked);
    if (!page) return null;
    if (hops.page && (hops.page.name !== page.name || hops.page.variant !== page.variant)) {
      page = hops.page;
      permanent = false;
    }
    const name = page.name.replace(/ /g, "_");
    decoded.push(page.variant ? `${name}~${page.variant}` : name);
    encoded.push(pageSegment(page));
    for (const sub of segments.slice(2)) {
      const lower = sub.toLowerCase();
      if (!SLUG.test(lower)) return null;
      decoded.push(lower);
      encoded.push(lower);
    }
  }

  if (decoded.every((segment, i) => segment === segments[i])) return null;
  return { path: `/wiki/${encoded.join("/")}${search}`, permanent };
}

/**
 * docs/WIKI.md "Permissions" — whether a user's slug is the one their email
 * gives: `slugify(<local part>, "user")`, as uniqueUserSlug makes one for an
 * account that signed up without a name, with or without its `-2`, `-3`, …
 * suffix. The app withholds such a slug everywhere a name would show, and a
 * page's address would publish it, so a person's namespace refuses one. A
 * name that gives the same slug reveals nothing, and passes.
 */
export function slugIsFromEmail(user: { slug: string; email: string; name: string | null }): boolean {
  const fromEmail = slugify(user.email.split("@")[0], "user");
  if (user.name && slugify(user.name, "user") === fromEmail) return false;
  return user.slug === fromEmail || new RegExp(`^${fromEmail}-[0-9]+$`).test(user.slug);
}

/**
 * docs/WIKI.md "Claiming an address" — where a claim's default variant comes
 * from. The server walks the sequence under the address lock and takes the
 * first free one; a dialog previews the same, and sends none.
 *
 * - a fork: the page itself, then the variant its parent lends (`lent`),
 *   then `2`, `3`, …;
 * - a move: the page itself, then `2`, `3`, …;
 * - a restore: the address it had, then `<variant>-2`, `-3`, … — `2`, `3`, …
 *   for the page itself. The suffix goes on the variant, never the name: the
 *   name is what makes pages "the same name", and a name can end in `2` by
 *   itself (`World War 2`).
 */
export type VariantDefaults = { kind: "fork"; lent: string | null } | { kind: "move" } | { kind: "restore"; variant: string };

export function* defaultVariants(defaults: VariantDefaults): Generator<string, never> {
  if (defaults.kind === "restore") {
    yield defaults.variant;
    for (let n = 2; ; n++) yield defaults.variant ? `${defaults.variant}-${n}` : String(n);
  }
  yield "";
  if (defaults.kind === "fork" && defaults.lent) yield defaults.lent;
  for (let n = 2; ; n++) yield String(n);
}

/** The first variant of a sequence that isn't among `taken`, the variants held at that name in the target namespace. */
export function firstFreeVariant(defaults: VariantDefaults, taken: ReadonlySet<string>): string {
  for (const variant of defaultVariants(defaults)) {
    if (!taken.has(variant)) return variant;
  }
  throw new Error("unreachable: a default variant sequence never ends");
}

/**
 * The variant a fork's parent lends its fork: the parent owner's slug, or
 * `commons`, when the parent's own address is public — a `PUBLIC` wiki page —
 * and the fork goes into another namespace. A fork's address is public once
 * the fork is, and an owner's slug in it would otherwise name a parent the
 * family line keeps back.
 */
export function lentVariant(parent: { visibility: string; owner: WikiOwner | null }, target: WikiOwner): string | null {
  if (parent.visibility !== "PUBLIC" || parent.owner === null) return null;
  if (ownerSegment(parent.owner) === ownerSegment(target)) return null;
  return parent.owner.kind === "person" ? parent.owner.slug : "commons";
}
