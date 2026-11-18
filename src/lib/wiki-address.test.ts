import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeSegment,
  defaultVariants,
  firstFreeVariant,
  lentVariant,
  parseOwnerSegment,
  parsePageSegment,
  parseWikiAddress,
  RESERVED_OWNER_SEGMENTS,
  slugIsFromEmail,
  wikiLabel,
  wikiNameSegment,
  wikiPagePath,
  wikiPathOfDoc,
  wikiRedirect,
  type VariantDefaults,
  type WikiAddress,
} from "./wiki-address";

// docs/WIKI.md "Names" and "URLs" — the address's grammar, its encoding, the
// fixed redirects and the default variant sequences. Every function takes
// segments decoded once, so each test decodes what a route would be handed.

const commons = { kind: "commons" } as const;
const jane = { kind: "person", slug: "jane-doe" } as const;

test("an owner segment: a person by `@`, decoded from Next's %40, the commons, reserved words, and held slugs", () => {
  assert.deepEqual(parseOwnerSegment(decodeSegment("%40jane-doe")!), jane);
  assert.deepEqual(parseOwnerSegment("commons"), commons);
  assert.deepEqual(parseOwnerSegment("new"), { kind: "reserved", word: "new" });
  assert.deepEqual(parseOwnerSegment("special"), { kind: "reserved", word: "special" });
  assert.deepEqual(parseOwnerSegment("physics"), { kind: "held", slug: "physics" });
  for (const bad of ["@", "@Jane", "@jane_doe", "Commons", "-x", "a--b", ""]) {
    assert.equal(parseOwnerSegment(bad), null, bad);
  }
  assert.ok(RESERVED_OWNER_SEGMENTS.includes("common"));
});

test("a page segment: a name, its _ a space, then ~ and a slug variant", () => {
  assert.deepEqual(parsePageSegment("Mercury_(planet)"), { name: "Mercury (planet)", variant: "" });
  assert.deepEqual(parsePageSegment("Mercury_(planet)~jane-doe"), { name: "Mercury (planet)", variant: "jane-doe" });
  assert.deepEqual(parsePageSegment("World War 2~2"), { name: "World War 2", variant: "2" });
  for (const bad of ["~x", "x~", "x~~y", "x~a~b", "x~A", "x~a_b", "a/b", "a#b", "Smile_:)", "x.rsc", "..", "_"]) {
    assert.equal(parsePageSegment(bad), null, bad);
  }
});

test("a path is encoded but for the sub-delims, : and @, and parses back to its address", () => {
  assert.equal(wikiNameSegment("Mercury (planet)"), "Mercury_(planet)");
  assert.equal(wikiNameSegment("R&D: a=b, c+d; e$ f@g!*'"), "R&D:_a=b,_c+d;_e$_f@g!*'");
  assert.equal(wikiNameSegment("100% pure"), "100%25_pure");
  assert.equal(wikiNameSegment("café 東"), "caf%C3%A9_%E6%9D%B1");
  assert.equal(wikiNameSegment("a\"b`c^d"), "a%22b%60c%5Ed");

  const addresses: WikiAddress[] = [
    { owner: commons, name: "Mercury (planet)", variant: "" },
    { owner: jane, name: "R&D (lab)", variant: "2" },
    { owner: jane, name: "100% pure", variant: "" },
    { owner: commons, name: "Straße été", variant: "x-y" },
  ];
  for (const address of addresses) {
    const path = wikiPagePath(address);
    const [, wiki, owner, page] = path.split("/");
    assert.equal(wiki, "wiki");
    // As Next hands a page its params: decoded, then encodeURIComponent'd.
    const asNext = (segment: string) => encodeURIComponent(decodeURIComponent(segment));
    const decoded = { owner: decodeSegment(asNext(owner))!, page: decodeSegment(asNext(page))! };
    assert.deepEqual(parseWikiAddress(decoded), address, path);
    assert.equal(wikiRedirect([decoded.owner, decoded.page]), null, path);
  }
  assert.equal(wikiPagePath({ owner: jane, name: "x", variant: "" }), "/wiki/@jane-doe/x");
});

test("a doc's address and label, from its columns", () => {
  assert.equal(wikiPathOfDoc({ wikiName: null, wikiVariant: "", ownerSlug: null }), null);
  assert.equal(wikiPathOfDoc({ wikiName: "Mercury (planet)", wikiVariant: "", ownerSlug: null }), "/wiki/commons/Mercury_(planet)");
  assert.equal(wikiPathOfDoc({ wikiName: "A b", wikiVariant: "2", ownerSlug: "jane-doe" }), "/wiki/@jane-doe/A_b~2");
  assert.equal(wikiLabel({ owner: jane, name: "Mercury (planet)", variant: "2" }), "@jane-doe/Mercury (planet)~2");
  assert.equal(wikiLabel({ owner: commons, name: "Mercury (planet)", variant: "" }), "commons/Mercury (planet)");
});

test("a name not spelled canonically redirects, permanently, for everyone", () => {
  const cases: [string, string][] = [
    ["Mercury (planet)", "/wiki/commons/Mercury_(planet)"], // %20 typed
    ["Mercury__(planet)", "/wiki/commons/Mercury_(planet)"],
    ["_Mercury_", "/wiki/commons/Mercury"],
    ["Cafe\u0301", "/wiki/commons/Caf%C3%A9"],
    ["\u200EMercury", "/wiki/commons/Mercury"],
    ["a\u00A0b", "/wiki/commons/a_b"],
  ];
  for (const [page, path] of cases) {
    assert.deepEqual(wikiRedirect(["commons", page]), { path, permanent: true }, JSON.stringify(page));
  }
});

test("uppercase in the owner, the variant or a sub-path is lowercased, never in the name; the query kept", () => {
  assert.deepEqual(wikiRedirect(["COMMONS", "Mercury"], "?at=3"), { path: "/wiki/commons/Mercury?at=3", permanent: true });
  assert.deepEqual(wikiRedirect(["@Jane-Doe", "MERCURY~V2", "EDIT"]), { path: "/wiki/@jane-doe/MERCURY~v2/edit", permanent: true });
  assert.deepEqual(wikiRedirect(["@Jane-Doe"]), { path: "/wiki/@jane-doe", permanent: true });
  assert.equal(wikiRedirect(["commons", "MERCURY"]), null);
  assert.equal(wikiRedirect(["@jane-doe", "x~v2", "edit"]), null);
});

test("common goes to commons, and every fixed redirect a path needs is one hop", () => {
  assert.deepEqual(wikiRedirect(["common"]), { path: "/wiki/commons", permanent: true });
  assert.deepEqual(wikiRedirect(["Common", "Mercury (planet)~X", "Edit"], "?sel=a"), {
    path: "/wiki/commons/Mercury_(planet)~x/edit?sel=a",
    permanent: true,
  });
});

test("outside the grammar there is no redirect, and the route answers 404", () => {
  for (const segments of [
    ["@", "x"],
    ["@jane_doe", "x"],
    ["physics", "x"],
    ["new", "x"],
    ["commons", "a~b~c"],
    ["commons", "x~a_b"],
    ["commons", "a/b"],
    ["commons", "Smile_:)"],
    ["commons", "x", "a_b"],
    ["commons", "x", ""],
  ]) {
    assert.equal(wikiRedirect(segments), null, segments.join("/"));
  }
});

test("the reader-only hops make the one hop a 307", () => {
  // A name in other capitals, with the sub-path and query kept.
  assert.deepEqual(wikiRedirect(["commons", "mercury_(PLANET)", "edit"], "?at=2", { page: { name: "Mercury (planet)", variant: "" } }), {
    path: "/wiki/commons/Mercury_(planet)/edit?at=2",
    permanent: false,
  });
  // An old user slug, with an uppercase sub-path, in one hop.
  assert.deepEqual(wikiRedirect(["@old-slug", "x", "EDIT"], "", { ownerSlug: "jane-doe" }), {
    path: "/wiki/@jane-doe/x/edit",
    permanent: false,
  });
  // A hop that changes nothing adds nothing.
  assert.equal(wikiRedirect(["@jane-doe", "x"], "", { ownerSlug: "jane-doe", page: { name: "x", variant: "" } }), null);
});

const take = (defaults: VariantDefaults, n: number) => {
  const out: string[] = [];
  for (const variant of defaultVariants(defaults)) {
    out.push(variant);
    if (out.length === n) break;
  }
  return out;
};

test("default variants: a fork's, from a parent that lends its owner's slug and one that doesn't", () => {
  assert.deepEqual(take({ kind: "fork", lent: "jane-doe" }, 4), ["", "jane-doe", "2", "3"]);
  assert.deepEqual(take({ kind: "fork", lent: null }, 3), ["", "2", "3"]);
  assert.equal(firstFreeVariant({ kind: "fork", lent: "jane-doe" }, new Set([""])), "jane-doe");
  assert.equal(firstFreeVariant({ kind: "fork", lent: "jane-doe" }, new Set(["", "jane-doe", "2"])), "3");
  assert.equal(firstFreeVariant({ kind: "fork", lent: null }, new Set(["jane-doe"])), "");

  const jane = { kind: "person", slug: "jane-doe" } as const;
  const sam = { kind: "person", slug: "sam" } as const;
  const commons = { kind: "commons" } as const;
  assert.equal(lentVariant({ visibility: "PUBLIC", owner: jane }, sam), "jane-doe");
  assert.equal(lentVariant({ visibility: "PUBLIC", owner: commons }, sam), "commons");
  // Not public, not a wiki page, or already in the target namespace: nothing to lend.
  assert.equal(lentVariant({ visibility: "SHARED", owner: jane }, sam), null);
  assert.equal(lentVariant({ visibility: "PRIVATE", owner: null }, sam), null);
  assert.equal(lentVariant({ visibility: "PUBLIC", owner: jane }, jane), null);
  assert.equal(lentVariant({ visibility: "PUBLIC", owner: commons }, commons), null);
});

test("default variants: a move's and a restore's", () => {
  assert.deepEqual(take({ kind: "move" }, 3), ["", "2", "3"]);
  assert.deepEqual(take({ kind: "restore", variant: "" }, 3), ["", "2", "3"]);
  assert.deepEqual(take({ kind: "restore", variant: "v" }, 3), ["v", "v-2", "v-3"]);
  assert.equal(firstFreeVariant({ kind: "restore", variant: "v" }, new Set(["v", "v-2"])), "v-3");
  assert.equal(firstFreeVariant({ kind: "move" }, new Set(["", "2"])), "3");
});

test("a slug made from the email is refused, with or without a suffix, unless the name gives the same one", () => {
  const nameless = { email: "jane.doe@example.com", name: null };
  assert.equal(slugIsFromEmail({ ...nameless, slug: "jane-doe" }), true);
  assert.equal(slugIsFromEmail({ ...nameless, slug: "jane-doe-2" }), true);
  assert.equal(slugIsFromEmail({ ...nameless, slug: "jane-doe-17" }), true);
  // A name added later leaves the email's slug in place.
  assert.equal(slugIsFromEmail({ email: "jd1987@example.com", name: "Jane Doe", slug: "jd1987" }), true);
  // The name gives the same slug: nothing withheld.
  assert.equal(slugIsFromEmail({ email: "jane.doe@example.com", name: "Jane Doe", slug: "jane-doe-2" }), false);
  // Anything an ADMIN has set, or the name gave.
  assert.equal(slugIsFromEmail({ ...nameless, slug: "jane" }), false);
  assert.equal(slugIsFromEmail({ ...nameless, slug: "jane-doe-x" }), false);
  assert.equal(slugIsFromEmail({ email: "jd@example.com", name: "Jane Doe", slug: "jane-doe" }), false);
});
