# Wiki pages — docs with a name and an address under /wiki

**Planned 2026-11-17; being built in the order "Build order" gives, which says what each PR
holds.** A **wiki page** is a doc in every respect
[DOCS.md](DOCS.md) describes, plus an address: whose page it is, its name, and its variant.
Its name is its title, written as people write one, `Mercury (planet)`, and its URL is made
from it, `/wiki/commons/Mercury_(planet)`. A doc gets an address by being created under
`/wiki`, forked into the wiki, or moved there, and can be renamed, moved between namespaces,
and moved back out. Where this file is silent, a wiki page behaves as a doc does: the ydoc
stack, the `prose_json` cache, the reading view with its scrub bar and `?at=`, annotations,
tags, anchored links, entity chips, search and the MCP tools.

**Forks and diffs are main's, and this file adds only what an address needs.**
[FORKS.md](FORKS.md) is the account of forking a doc, diffing two texts, a doc's family lines
and who may see a doc's history; "What the wiki adds" in each section below says what changes
for a wiki page, and nothing here restates the rest.

**It replaces the `wiki` branch**, which built this design with slug names (`institution~2`)
on main as it was on 2026-10-22, and was never merged. That branch stays as a read-only
reference: its code is where most of the wiki-only files below start ("What comes from the
`wiki` branch"), and its docs/WIKI.md holds the reasoning this file condenses. Nothing is
merged or cherry-picked from it. The earlier, embedding-based design is parked on
`multiwiki`.

What it does not repeat:

| | |
|---|---|
| [DOCS.md](DOCS.md) | The doc, its ydoc, the reading view, the editor, roles and visibility. |
| [FORKS.md](FORKS.md) | Forks, diffs, the family lines, and who may see a doc's history. |
| [PERMISSIONS.md](PERMISSIONS.md) | Who may do what, as tables; the wiki adds its own (below, "Permissions"). |
| [MCP.md](MCP.md) | The tools. They take a page's address wherever they take a doc's URL ("URLs"); the rest is deferred. |

## Mistakes that fail no check

Read these before changing code that tests or offers a doc's visibility, decides who may edit
a doc, changes a doc's settings, or writes a doc's `title` or its `wiki_*` columns. Each
compiles, lints and gives the right answer for every doc that isn't a wiki page, which is
most of what the specs make. CLAUDE.md points here and holds none of it.

- **A visibility compared to a literal.** `=== "SHARED"` or `{ visibility: "SHARED" }` treats
  `PUBLIC` as `PRIVATE`: `readableDocsWhere` written that way lists a public page to nobody,
  its author included. Ask `isSharedOrPublic` or `sharedOrPublic()`
  (`src/lib/doc-visibility.ts`), offer `allowedVisibilities` in a doc's select and
  `FILE_VISIBILITIES` in a file's, and check a value against `allowedVisibilities` where it is
  accepted. A literal `"PRIVATE" | "SHARED"` type is the harmless kind: `tsc` refuses it.
  ("`PUBLIC` outside the wiki's routes".)
- **The edit rule restated.** `SHARED && canEditAnySharedDoc(role)` inline gives an ADMIN or
  EDITOR a person's page, which has no bypass. Ask `canEditDocRow` of a row in hand, and
  `editableDocsWhere` as a filter; `wikiName: null` belongs in `editableDocsFor` alone, since
  on the shared filter it strips every page's history from the family line ("Permissions").
- **A settings rule checked before the lock.** Each function in `doc-manage.ts` takes
  `lockDoc` first and asks its rules of the row it returns; a check before the lock can be
  overtaken by a move into the wiki ("Moving a doc into the wiki").
- **A write of `wiki_name` that doesn't name `title`.** The mirror trigger puts the name in
  `title` either way, but the search vector's trigger fires by the columns a statement names,
  so a rename naming `wiki_name` alone leaves search on the old name ("The name is the title").
- **A name folded anywhere but `wiki_name_key()`.** No JavaScript function agrees with
  `casefold` (`toLowerCase` keeps `ß`), and `casefold` without `COLLATE pg_unicode_fast`
  folds by the database's default collation, with no error. `wiki_name_key` the column is
  written only by its trigger ("Case").

## What it is for

Wiki pages are meant to:

1. **stay out of the blog's RSS feed**, which lists only published posts, and a wiki page
   publishes none ("Doc rules a wiki page doesn't inherit");
2. **be able to be public**, readable signed out ("Public pages"), which is also what puts a
   page on the landing page ("The front page");
3. **be forkable, with forks obvious and diffable**, as any doc is now (FORKS.md), with "Same
   name" beside the family ("The family line");
4. **take in docs that already exist**, moved or forked into the wiki;
5. **be named as an encyclopedia names its articles**, `Mercury (planet)` beside `Mercury
   (element)`, and renamed without breaking the links people have to them.

A wiki page's ydoc is its doc's, `ydoc:<docId>`, so the collab server learns nothing new and
CLAUDE.md's "two sub-namespaces" stays true.

## Names

### What a name may hold

**MediaWiki's title rules, changed where this section says**: the order of normalizing,
seven refusals MediaWiki doesn't make, and case. The rules are `TitleParser::splitTitleString`
and `$wgLegalTitleChars` in MediaWiki core (read at `03c6e4f`). A name is normalized, then
checked; the check refuses, with a message, and never repairs.

Normalized, in order:

1. **Bidi marks stripped**: U+200E, U+200F and U+202A–U+202E, which arrive with pasted text.
2. **Spaces folded**: `_`, a space, and U+00A0, U+1680, U+180E, U+2000–U+200A, U+2028,
   U+2029, U+202F, U+205F and U+3000 each become one space; a run becomes one; the ends are
   trimmed.
3. **NFC, last.** A deterministic collation compares bytes, so a decomposed `é` would otherwise
   be a second name. MediaWiki normalizes first, but a bidi mark is a starter, which NFC can't
   compose across, so stripping one afterwards can leave a letter beside its combining mark:
   `Cafe` + U+200E + U+0301, normalized and then stripped, is a decomposed `é`, which the
   database's `IS NFC NORMALIZED` would refuse as a raw error.

Refused:

- **an empty name**;
- **a string that isn't well formed**: a lone surrogate, which a JavaScript string can hold and
  `encodeURIComponent` throws on (MediaWiki's invalid-UTF-8 rule), and U+FFFD;
- **what MediaWiki's set leaves out**: C0 controls, DEL, and `# < > [ ] { } |`. `#` starts a
  fragment, and `[`, `]` and `|` are what a `[[x]]` link between pages ("Deferred") and the
  editor's `[[` menu are written with;
- **`%` and two hex digits, and `&`, then ASCII letters, digits or non-ASCII characters, then
  `;`**, so that no name looks already encoded. That is MediaWiki's `&[A-Za-z0-9\x80-\xff]+;`,
  which runs over bytes, so every non-ASCII character matches: `&é;` is refused;
- **the names `.` and `..`**, which a browser resolves as dot segments, `%2E` included, so their
  URL never arrives (MediaWiki's relative-path rule, which with `/` refused comes down to these);
- **more than 255 bytes of UTF-8** (MediaWiki's limit), which bounds the URL and the index entry;
- and seven that MediaWiki allows:
  - **`/`**, which separates path segments: `…/edit` and the catch-all come after the name, a
    typed one reaches another route (a name `x/edit`, typed, would open `x`'s editor), a `%2F`
    would have to survive every hop to the app, and it is the labels' delimiter ("Labels");
  - **`\`**, which a browser reads as `/` in an http URL, and which is Markdown's escape;
  - **`?`**, which starts the query string, so a typed one reaches the name without it: the
    failure "Addresses" keeps the variant out of the query string to avoid;
  - **`~`**, which separates a name from its variant ("Variants"). No name holds one, so the
    split is unambiguous;
  - **unbalanced parentheses**: a `)` with no `(` before it, or a `(` never closed. A Markdown
    link takes balanced parentheses only, and `docContentToMarkdown`, which MCP reads and
    writes go through, writes a URL as it is: `[x](/wiki/commons/Smile_:))` parses back as
    `Smile_:`;
  - **a name ending in `.rsc`, in any capitals**: Next takes that suffix off a path and answers
    with the page's RSC payload, so the page could never be opened. `/authors/x.rsc` answers 200
    as `text/x-component`, where `/authors/x` is a 404, on `next dev` and on a production build
    alike (16.2.11), and so does `/wiki/commons/x.rsc`;
  - **a code point Unicode hasn't assigned**, by the database's Unicode (`unicode_assigned`).
    `casefold` and NFC follow the server's Unicode tables, which change at major versions, and
    Unicode freezes both only for characters already assigned. A letter assigned later with a
    case pair would fold differently after an upgrade: its page would 404 at its own address,
    or a restore would fail on the unique index. The database's answer is the one that counts,
    since JavaScript's Unicode can differ from it, older in a browser or newer in Node, so the
    server asks it while folding the name ("Case"), and turns a refusal into a message rather
    than a raw CHECK error.

**`?` and `/` stay refused, by decision** (2026-11-17). `?` would have cost little: written
`%3F`, as MediaWiki writes it, only a URL typed or written by hand would lose it. It is refused
anyway, with `/`, so that a name is always what its URL's last segment says it is.

**Case is the other change**: it doesn't distinguish names ("Case"), where MediaWiki capitalizes
the first letter and compares the rest exactly. A name is stored with whatever capitals it was
given.

**Everything else is allowed**: any script, digits, punctuation and symbols, and the characters
MediaWiki also lets through, C1 controls, private-use characters, the bidi isolates and
zero-width characters among them. Lookalikes are not checked, by decision: a name is given only
by someone who may create the page or edit it.

**Not carried over from MediaWiki**, having nothing here to apply to: namespace and interwiki
prefixes and their colons, splitting off a `#` section, capitalizing the first letter, `~~~`,
IP-address names and the lookup by script variant. HTML entities aren't decoded.

**The database holds names to the same rules**, so no row holds a name no URL reaches, where a slug
is held only by `slugify` and its unique index: `IS NFC NORMALIZED`, `unicode_assigned`,
`octet_length`, and patterns for what is refused and for spaces already folded, with the parenthesis
balance in an immutable SQL function, given its own `SET search_path`. A history row's name
("Renaming") is held to them too.

**The rules are one pure module**, `src/lib/wiki-name.ts`, with its unit test as the table of
what is accepted, normalized and refused. A dialog checks a name with it as it is typed; the
server checks it again, and asks the database for `unicode_assigned` and the key in the same
statement ("Case").

### Case

- **A name is stored as typed, and compared by its key**, `wiki_name_key`, which is
  `normalize(casefold(wiki_name COLLATE pg_unicode_fast), NFC)`, Postgres 18's full Unicode case
  folding, normalized: so `Straße` and `STRASSE` are one name, and so are `ΟΔΟΣ` and `οδος`.
  `casefold` and `normalize` are `IMMUTABLE`, and a unique index on the key refuses both pairs.
  **Postgres 18 becomes a requirement**, for docs/DATABASE.md and DEPLOY.md to say; every
  instance runs it already.
- **The fold is normalized because folding an NFC name doesn't always give NFC**, and two names
  that differ only in case can then fold to different bytes. `ΐ` (U+0390) folds to `ι` + U+0308 +
  U+0301, and its capital, `Ϊ́` (U+03AA U+0301, which is NFC, there being no single character for
  it), folds to `ϊ` (U+03CA) + U+0301: the same letter, in two spellings, which a bare `casefold`
  would index as two names (checked on 18.6). Normalized, both are one key.
- **So two pages in one namespace can't have names that differ only in case**, any more than
  the same name twice: `Apple` and `apple` are one address. In different namespaces, or as
  variants, they can.
- **The fold is written once**, as an immutable SQL function, `wiki_name_key(text)`, with its
  own `SET search_path`. A `BEFORE INSERT OR UPDATE OF wiki_name` trigger writes the key column
  from it, on `doc` and on the history table ("Renaming"), as `prose_json_length` is written by
  its trigger, since a `STORED` generated column drifts under Migrate (PLAN.md §16l). The unique
  indexes, the history's indexes and `doc_wiki_name_key_idx` are on the key column. A fold
  spelled out at each call site would be one missed `COLLATE` from the database's default
  collation, `en_US.UTF-8` on slot A, where `casefold('Straße')` is `straße`: another fold,
  with no error and no index.
- **Prisma compares keys.** "Same name" matches the page's own key, read with its row, so it
  stays a Prisma `where` beside `readableWikiDocsWhere`. The one raw query folds a name that
  comes in, from a URL or a dialog, in one helper, and asks `unicode_assigned` in the same
  statement.
- **Nothing folds in TypeScript.** No JavaScript function agrees with `casefold`
  (`toLowerCase` keeps `ß`), so the app never compares folded names itself.
- **The address lock folds too.** Its key is `hashtext(<owner key> || '/' ||
  wiki_name_key(<name>))`, so claims of `Apple` and `apple` queue on one lock. The owner key is
  built in TypeScript, for the null-owner reason "Claiming an address" gives.
- **A URL whose name differs from the stored one only in case gets a 307 to the stored name**,
  keeping the sub-path and the query string, and only for a viewer who may read the page.
  Anyone else gets what a missing page gets ("Requests and responses"). A fixed redirect, such
  as the variant's lowercase, can be a 308 for everyone because it is a function of the URL and
  reveals nothing. This one tells a viewer that a page of that name exists, and its target
  changes when the page is deleted and the name taken with other capitals. Every link the app
  writes uses the stored name, so only a typed URL meets it, or a link written before a rename
  that changed only case.
- **The owner segment is lowercased with a 308**, as a user slug always is lowercase.

### Variants

- **A variant is a slug after a `~`**: `Mercury (planet)~jane`. Its grammar is `slugify`'s,
  `[a-z0-9]+(-[a-z0-9]+)*`, in its own column, `wiki_variant`, `''` for the page itself.
- **A variant's uppercase redirects with a 308 for everyone**, since lowercasing it is a fixed
  function of the URL that reveals nothing. A path whose name is in the wrong case too gets one
  hop ("In a URL").
- **A parenthetical is part of the name.** `Mercury (planet)` and `Mercury (element)` are two
  names, and "Same name" compares whole names, by their keys; a variant is another page at one
  name.
- **A default variant is the server's to pick** ("Claiming an address"), from one pure function
  that gives each default sequence, a fork's, a move's and a restore's, for a dialog to preview
  and the server to walk.

### The owner segment

| Address | Whose page |
|---|---|
| `/wiki/@<user-slug>/<name>` | a person's |
| `/wiki/commons/<name>` | the commons' |
| `/wiki/<owner>/<name>~<variant>` | either, as a variant |

**`@<user-slug>` is a person**, by the same slug as `/authors/[slug]`, and `commons` is the
commons. Every other unprefixed segment is held: those on the reserved list for fixed routes
("Reserved segments"), and the rest for groups later ("Deferred").

**People carry the `@`, rather than groups a prefix.** A person's slug is generated from their
name, so reserving words among people's slugs costs real people their natural ones. An
unprefixed slug will be chosen by whoever creates a group, and a reserved one can simply be
refused. So the namespace that needs reserved words is the unprefixed one.

- **Next hands the page the segment as `%40<slug>`**, because it runs `encodeURIComponent` on
  every string param (CLAUDE.md, "A Next dynamic-route `params` value arrives percent-encoded"). The
  address parser decodes both segments, once, before splitting either.
- **`generateMetadata` is handed the same params already decoded.** Next 16.2.11 encodes a param
  only on its way to the page (`getParamValue`), and reads the metadata's from
  `interpolatedParams` as they are (`lib/metadata/resolve-metadata.js`). So each caller decodes
  what it was given, or not, and hands the loader decoded segments: decoded twice, `%2541` names
  the page `A`, and a name with a bare `%`, `100% pure`, throws. The envelope's `cache()` keys on
  its arguments, so the two also have to agree for the page to reuse the metadata's load, as
  `/doc/[slug]`'s does. CLAUDE.md's entry gains this half.
- **The `@` lives only in a param value.** The App Router reads an `@folder` as a parallel-route
  slot, so no folder may be named with one; `[owner]` is a param, which is fine.

**No fixed route sits under an owner** (`/wiki/@x/<fixed>`), so names need no reserved list of
their own. A page's own sub-routes come after it (`…/<page>/edit`).

### Reserved segments

The unprefixed owner segments, kept as one constant in `src/lib/wiki-address.ts`. Only
`commons`, `common`, `new` and `special` do anything; the rest are held so that nothing, a group
included, can take them first.

| Segment | For |
|---|---|
| `commons` | the commons |
| `common` | a permanent redirect (308) to the same path under `commons` |
| `new` | creating a page |
| `all` | `/wiki/all/<name>`: every readable page with that name, and renamed forks of them |
| `recent` | recent changes |
| `search` | searching the wiki |
| `random` | a random page |
| `me` | the viewer's own pages, redirecting to `/wiki/@<their slug>` |
| `help` | help and conventions |
| `compare` | in case diffs move under `/wiki/` |
| `special` | system pages, as `/wiki/special/<page>`: the admin table of wiki pages, `/wiki/special/pages` ("Listing wiki pages"), and anything not foreseen here, so a later system page needs no new reservation |

**User slugs stay unreserved.** The list constrains only unprefixed segments, so
`src/lib/slug.ts`'s "no reserved-slug list" comment stays true of user slugs.

### In a URL

- **A space is written `_`**, as MediaWiki writes it: `Mercury (planet)` is
  `/wiki/commons/Mercury_(planet)`. A name can't hold both, since a `_` is folded to a space.
- **The rest is percent-encoded**, but for what a path segment may carry as it is (RFC 3986's
  sub-delims, `:` and `@`): `! $ & ' ( ) * + , ; = : @` stay readable.
- **Decoded once**, before anything else, **then normalized as a name is**. A name the rules
  refuse is a 404.
- **A name that, decoded, isn't spelled as `wikiPagePath` spells it gets a 308 to the path that
  is, for everyone**: a space typed into the address bar, which arrives as `%20`; a run of `_`,
  or one at an end; a decomposed accent; a bidi mark. Normalizing is a fixed function of the
  URL, so the redirect reveals nothing. MediaWiki answers the same spellings with a 301
  (`tryNormaliseRedirect`: `/wiki/Foo%20Bar` to `/wiki/Foo_Bar`).
- **Uppercase in the owner, the variant or a sub-path gets a 308 to the same path with those
  lowercased**, `…/EDIT` to `…/edit`. The name is never lowercased.
- **A path that needs more than one redirect gets one hop**, a 307 if any of them is. The
  reader-only ones, the case ("Case") and an old address ("Renaming"), are applied only for a
  viewer who may read the page; anyone else gets the fixed ones alone, as a 308, and then, at its
  target, what a missing page gets.
- **The test is on decoded segments.** Next decodes each segment and encodes it again with
  `encodeURIComponent`, which writes uppercase hex, so a test on the segment as given would
  redirect `%C3%A9` to `%c3%a9` and back, until the browser gave up.
- **Every redirect under `/wiki/` keeps the query string**, as `/doc/`'s keeps `?sel=` and
  `?at=`.
- **The `~` before a variant and the `@` before an owner are written as they are.** Encoded
  again with `encodeURIComponent`, the `@` would reach the address bar as `%40`.
- **Every path goes through `wikiPagePath`**, which knows the encoding.
- **Each route answers its own redirects.** There is no middleware (no `src/middleware.ts` or
  `src/proxy.ts`), so the namespace list, the page, its `/edit` and a catch-all under the page
  (`src/app/wiki/[owner]/[page]/[...rest]`) each ask one function in `src/lib/wiki-address.ts`.
  It takes the decoded segments and returns the path to redirect to, if any, and whether the
  redirect is permanent; the reader-only hops are added by the route, which knows the viewer.
  Without the catch-all, `…/EDIT` and anything deeper would 404 unredirected, through
  `src/app/[year]/`'s routes, which match any path of up to four segments.
- **`/Wiki/…` stays a 404.** A capital in the first segment puts the path outside `/wiki/`.

**The variant is in the path, not the query string.** The doc URLs' two query parameters both
degrade gracefully when lost: drop `?at=` and you get the latest version, drop `?sel=` and you
lose the highlight. A variant in the query string would be the first whose loss lands on a
different page, and on an Edit link that is a page you then type into. So `?at=` and `?sel=`
keep their meanings here, and no part of an address is a query parameter.

**The word is "variant".** It implies no ordering and no merging back, and it is the textual
critic's term for an alternative reading. `version` and `revision` already name `?at=` and the
MCP's `version`; `draft` names annotation and comment drafts; `fork` names the relation, since
a copy under another owner is a fork too.

**A wiki doc keeps its `Doc.slug`, and only the address is its URL.** Its `Doc.slug`, like every
doc's, is unique across all docs and is what `/doc/<slug>` and `/doc/<slug>/slug`
use. It is made from the title when the doc is created, and is frozen while the doc is in the
wiki ("URLs"). The two can't be one column: many namespaces can each have a page named
`Institution`, but only one doc can have that `Doc.slug`.

## URLs

| Route | What it is |
|---|---|
| `/wiki` | the wiki's front, for anyone: the commons' pages the viewer may read, newest edit first; links to the viewer's own namespace when it has a page they may read, and to `/wiki/new` when they may create one |
| `/wiki/new` | creating a page ("Creating a page") |
| `/wiki/special/pages` | the admin table of wiki pages ("Listing wiki pages") |
| `/wiki/commons`, `/wiki/@<slug>` | the namespace's pages the viewer can read, each by its name and variant ("Labels"); signed out, its `PUBLIC` ones; with none, as for a missing page ("Requests and responses") |
| `/wiki/<owner>/<page>` | a page: the doc view, or the public render ("Public pages") |
| `/wiki/<owner>/<page>/edit` | the editor, for whoever may edit |
| `/wiki/<owner>/<page>/…`, any other sub-path | 308 with the sub-path lowercased if it has uppercase in it, else 404 |
| `/wiki/…` with uppercase in the owner, the variant or a sub-path | 308 to the same path with those lowercased ("In a URL") |
| `/wiki/…` with a name not spelled as `wikiPagePath` spells it | 308 to the path that is, for everyone ("In a URL") |
| `/wiki/…` with a name that differs from a page's only in case | 307 to the page's stored name, for a viewer who may read it ("Case") |
| `/wiki/…` at an old address | 307 to where the page now lives, for a viewer who may read it ("Renaming") |
| `/wiki/common`, `/wiki/common/…` | 308 to the same path under `/wiki/commons` |
| `/wiki/@<old-slug>/…` | 307 to the person's current slug, the rest of the path and the query kept; for a deleted account, only to a viewer who may read what the path names |
| `/doc/<slug>`, for a live wiki doc | 307 to its wiki URL, keeping `?sel=` and `?at=`, for a viewer the wiki read rule lets read it: signed in or out, a COMMENTER included, by its id, its current slug or an old one. Anyone else gets what `/doc/[slug]` answers for any doc, but a 404 where that is Forbidden |
| `/doc/<slug>/edit`, for a live wiki doc | 307 to its wiki editor for a viewer who may edit it; anyone else gets what `/doc/[slug]/edit` answers for any doc, but a 404 for a viewer who can't read it. A deleted one isn't redirected: its Settings offer Undelete there |
| `/doc/<slug>/slug`, for a wiki doc | for its editors, its address and its address history ("Renaming") beside its frozen `Doc.slug` and slug history; Forbidden to a reader who can't edit it, and a 404 for anyone else signed in |

`<page>` is `<name>` or `<name>~<variant>`, encoded ("In a URL"). The namespace lists are
reader-facing lists, not admin tables. "Newest edit first" sorts by `prose_json_update_id`, the
update a doc's cached text is of, nulls last and then by `created_at` ("The `wiki` option"),
since `updatedAt` also moves on byline, visibility and slug changes. Diffs stay at main's
`/diff/<left>/<right>` ("Diffs").

**`/wiki/@<old-slug>/…` asks the user slug history.** `user_slug_history` already sends old
`/authors/` links on, through an inline lookup in `src/app/authors/[slug]/page.tsx` that MCP's
`readAuthor` repeats (`src/lib/mcp/tools/read.ts`). The wiki makes it one function,
`userByOldSlug` in `src/lib/user-slug.ts`, which the three share, and asks it to include deleted
accounts, as it does when it looks up an owner, so a deleted person's pages stay where they were
("Permissions"); `/authors/` keeps the filtered read. The wiki's redirect is a 307, since what an
old slug answers can change: an ADMIN can give it back (`revertUserSlug`) or free it
(`deleteUserSlugHistory`). `/authors/`' own redirect stays the 308 main gives it (docs/BLOG.md
§3).

- **For a deleted account, the redirect goes only to a viewer who may read what the path
  names**: the page, or a namespace list with something in it they may read. Anyone else gets the
  answer for an unknown owner. `/authors/` 404s for a deleted account and its old slugs, and a
  redirect given to anyone would tell a signed-out visitor that a deleted account held this one.
- **Changing a user's slug revalidates their namespace's paths**, beside the `/authors/` ones
  `src/app/actions/users.ts` revalidates now.

**A wiki doc's `/doc/<slug>` stays, as an internal handle.** Every link builder that emits `/doc/`
(search, tags, `/docs`, anchored links' landing route, MCP citations, the editor's link picker)
keeps working through the redirect. Some emit `/doc/<id>` (anchored links, `/links`), which the
redirect resolves as `resolveDocParam` does. The doc view's and the editor's links to their own
page go through one helper that knows wiki addresses (`wikiPathOfDoc`), so the hop is a safety
net and not the route: the title's edit link, "View and Annotate", the Settings panel's
"Change…", and the family line's entries ("The doc view at an address").

- **A link with a `#fragment` needs the helper.** A `<Link>` followed client-side through a redirect
  ends in `router.replace` to the URL the server answered with, which never had the `#`. Four
  builders link to `/doc/<slug>#<card>` and are drawn as `<Link>`s, so they build the wiki address
  instead: `/annotations` (`src/components/AnnotationsTable.tsx`), search's annotation hits
  (`src/lib/search/annotations.ts`), the dashboard's mentions of you (`src/lib/mentions-of.ts`) and
  a reference's cited-by list (`src/lib/reference-cited-by.ts`). Signing in on the way would lose it
  too, where no helper reaches, which PR 0's sign-in fix covers.
- **It checks access before redirecting**, as `loadDocForRead` already does before its
  slug-history redirect. A wiki address names an owner and a page, so redirecting a viewer who
  may not read the page would tell them both. Such a viewer gets the answer `/doc/[slug]` gives
  any doc, except that a Forbidden is a 404: a wiki doc's `Doc.slug` is made from its name, so a
  Forbidden at `/doc/mercury-planet` would confirm that a page of that name exists.
- **Access is the wiki read rule's, for every viewer** ("Public pages"): `canUserReadDoc`, or a
  live `PUBLIC` page. The editor's link picker writes `/doc/<slug>` links, so with
  `canUserReadDoc` alone every internal link in a public page's body would be Forbidden to a
  COMMENTER, and send a signed-out reader to sign in.
- **It is a 307, not a 308.** The answer depends on who asks, and the address can change under
  the link: a rename, a user's slug change, or a commons page deleted and its name reused.
- **Anything else signed out still gets the sign-in redirect**, a missing doc included, so the
  two still look alike. It still goes through `signInPath`. `check:sign-in` can't see this one,
  since it looks only for `redirect(` called with a literal `/sign-in`, so the e2e cases cover it.
- **`/doc/[slug]` looks the doc up for a signed-out request**, which `gated()` doesn't allow, so
  the route moves onto the wiki routes' envelope, `gatedAnyViewer` ("Public pages"). The cost is
  a lookup of one to three queries on each signed-out `/doc/` request: by id, by slug, then the
  slug history. **The param's shape is checked before the lookup**, in the page and in
  `generateMetadata`, as every wiki route checks its segments before its first query: a `%00`
  in a param reaches Postgres as a NUL and comes back a 500, as `/authors/a%00b` does on main,
  and here a signed-out request could ask for it.

**Wherever a doc is looked up, a viewer who can't read a wiki doc gets the answer for a missing
doc.** Any surface that tells an unreadable doc from a missing one confirms, for a wiki doc, that
a page exists. Beside `/doc/<slug>` and its `/edit`:

- **`/doc/<slug>/slug`** answers Forbidden to a signed-in viewer who can't edit a doc. For a wiki
  doc, only a reader gets that.
- **Side-by-side** (`loadPairForRead`) answers "forbidden" for an unreadable side and "not-found"
  for a missing one, and "not-found" for an unreadable wiki doc.
- **`previewLinkedDoc`** (`src/app/actions/docs.ts`), the editor's link preview, returns
  `{ status: "forbidden" }` for an unreadable doc and null for a missing one, and null for an
  unreadable wiki doc.
- **The diff gate** (`gateDiffPair`) and **forking** (`readForkSource`), which take ids ("Diffs",
  "Forking into the wiki").

MCP already answers both alike (`src/lib/mcp/resolve.ts`). **What takes a doc's id and nothing
else is left as it is**: the replay route and the collab token route (`/api/doc/[id]/token`)
answer a missing doc 404 and an unreadable one 403, and `createDocLink`, posting an annotation
and the bulk actions (through `settleBulk`) return their refusals apart in the same way. Ids are
cuids, which nobody guesses. TODO.md gains an entry saying so.

**The MCP tools take a page's address wherever they take a doc's URL**, from PR 2. From then on
a reader's address bar shows only the address, so a client handed a page's URL has nothing else
to pass.

- **`parseRef`** (`src/lib/mcp/url.ts`) gains a `wiki` kind for `/wiki/<owner>/<name>`, with or
  without a variant, `/edit` and a fragment. It decodes the path, as it does a doc's, and hands
  on decoded segments ("The owner segment").
- **`src/lib/mcp/resolve.ts` resolves it to the doc** through the wiki routes' shared resolution
  (`src/lib/wiki-pages.ts`), so a name in other capitals reaches its page, and from PR 3 an old
  address does, as a slug in history does now. The doc is then gated as any is, by
  `canUserReadDoc`, and an unreadable page is `not_found`, as a missing one is. `PUBLIC` adds
  nothing here: the wiki read rule stays on the wiki's routes ("Public pages").
- **Every switch that answers a parsed `doc` answers `wiki` alike**: `readableContainer`, which
  `add_note`, `create_link`, `edit_doc` and search's `within` go through, and the three that
  parse for themselves, `read`, `tag` and the export. Each tool keeps the rules it has for a
  doc, `edit_doc`'s refusal of a title included ("The name is the title").
- **`/wiki`, a namespace list and the wiki table are not read**, and `refuseRef`'s list and the
  tools' `url` descriptions name the one new form. docs/MCP.md §15 gains it.
- **What the tools give back for a wiki doc stays `/doc/<slug>`**, which sends a reader on to the
  address. Giving back the address, and creating, renaming, moving and `PUBLIC` through the
  tools, stay deferred ("Deferred").

**A slug that is taken still says some doc holds it**, as it does for every doc on main.
`changeDocSlug` answers "already in use" and `uniqueDocSlug` adds a suffix, over live and deleted
docs and their slug histories alike, so someone who titles a doc `Mercury planet` and is given
`mercury-planet-2` learns that a doc has that slug: not whose, nor that it is a wiki page. That
is less than the Forbidden told, and is left as it is, in the same TODO.md entry.

**A wiki doc's `Doc.slug` is frozen, and `/doc/<slug>/slug` shows its history.**

- **The history is still live.** Each `doc_slug_history` row is an old `/doc/` URL that still
  redirects, now on to the wiki address, and a doc moved into the wiki may have several.
- **Changing the slug is refused.** It would only mint another redirect, for a URL nobody sees.
  The refusal lives in `changeDocSlug` and `revertDocSlug` (`src/lib/doc-slug.ts`), which every
  change reaches: `SlugManager`'s change, its "use standard" and its Revert, and MCP's `manage`.
- **On a wiki doc the page shows** the wiki address as the page's URL, its address history with
  its controls ("Renaming"), and the `Doc.slug` with no control to change it. Its slug history
  rows are listed as on any doc, and can still be deleted, which ends the redirect each held.
- **The editor's Settings row** reads "Url: <the wiki address>", with "History…" linking to the
  page in place of "Change…".

### Requests and responses

| Request | Response |
|---|---|
| `/wiki`, by anyone | 200: the commons' pages the viewer may read, saying so when there are none |
| a page the viewer may read, by a viewer with `canViewDocs` | 200: the doc view |
| a `PUBLIC` page, signed out or without `canViewDocs` | 200: the public render |
| a namespace list with a page in it the viewer may read | 200: the pages the viewer may read |
| anything else, signed out: a page that doesn't exist included, a name in the wrong case or an old address of a page the viewer can't read, and a namespace list with nothing the viewer may read, an unknown or deleted owner's included | the sign-in redirect, through `signInPath` |
| anything else, signed in | 404; for a missing page or an empty namespace, offering to create one to whoever may create there |
| `/wiki/new`, signed out | the sign-in redirect |
| `/wiki/new`, by a viewer who may create nowhere | Forbidden, saying why: no `canManageDocs`, or a slug made from their email and no right to the commons |
| a page's `/edit`, signed out | the sign-in redirect, whatever is there |
| a page's `/edit`, by a viewer who may edit the page | 200: the editor |
| a page's `/edit`, by a viewer who may read the page but not edit it | Forbidden, with a link to the page |
| a page's `/edit`, by anyone else signed in | 404, as for the page |
| `/wiki/common` and anything under it; uppercase in the owner, the variant or a sub-path; a name not spelled canonically | 308, for everyone |
| a name in the wrong case, or an old address, of a page the viewer may read | 307 |
| `/wiki/@<old-slug>/…` | 307, but for a deleted account only to a viewer who may read what the path names |
| a malformed segment: an unprefixed segment that isn't on the reserved list, an empty or misplaced `~`, a variant outside the slug grammar, a name the rules refuse; a reserved segment that names no namespace, with a page after it (`/wiki/new/x`), and a held route (`/wiki/recent`, `/wiki/all/x`); a sub-path no wiki route has | 404 |
| a path with a malformed percent sequence (`/wiki/commons/100%`, `%E9`) | 400, from Next, before any route runs |

**The sign-in redirect's return path is built by `wikiPagePath`**, from the decoded segments,
with the sub-path and the query string. `/doc/[slug]` builds its own from the param as given,
which for a wiki route is the page's re-encoded spelling, `/wiki/%40jane/R%26D_(lab)`: a path
the canonical test, being on decoded segments, never redirects, so the reader would be signed
in onto it and stay there.

**Signed out, a missing page and a non-public one look alike**, so the sign-in redirect can't be
used to learn whether `@jane` has a page called `x`. A namespace with nothing the viewer may read
looks like an unknown owner's in the same way, so the wiki tells nobody more about an account
than `/authors/` does.

**An unreadable page is a 404, not "Forbidden"**, unlike `/doc/[slug]`. A wiki address is
meaningful by design, owner and name, so a "Forbidden" would confirm that a private page by that
name exists. The editor's Forbidden goes only to a viewer who can read the page, to whom it
reveals nothing.

**The 404's offer comes from a `not-found.tsx` of the wiki's own**,
`src/app/wiki/[owner]/not-found.tsx`, which the namespace list, the page and its editor reach
through `notFound()`. Next gives the file no props, so it isn't told which address missed: its
server half reads the viewer's row and works out where they may create; its client half reads the
path with `usePathname()`, parses it, and when it is a well-formed address in one of those
namespaces, offers `/wiki/new` with what the address names filled in. The offer reveals nothing:
whoever may create in a namespace can read everything in it. The status is a 404 only while
`notFound()` runs before anything streams; nothing under `src/app` has a `loading.tsx`, and the
e2e case asserts the status, to catch one being added.

## Data model

**Two migrations come with the names, and a third with renaming** ("Build order"):
`doc_visibility_public`, `wiki_pages` and `wiki_address_history`. A value added to an enum
can't be used in the transaction that adds it, so `ADD VALUE` is a migration of its own, ahead
of the CHECKs that name `'PUBLIC'`. The second is Prisma's own SQL for the fields and the
relation, from `prisma migrate dev --create-only`, with the functions, trigger, CHECKs and
indexes appended by hand, as `doc_forks` appends its own. The fork columns are main's
(`doc_forks`, FORKS.md "Data model"), and the wiki adds nothing to them: its CHECK,
`doc_fork_at_revision`, already allows a fork that isn't a wiki page.

```sql
-- migration 1
ALTER TYPE "doc_visibility" ADD VALUE 'PUBLIC';

-- migration 2: Prisma's columns and foreign key, then
-- Hand-written below this line

CREATE FUNCTION wiki_name_key(name text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog
  RETURN normalize(casefold(name COLLATE pg_unicode_fast), NFC);
CREATE FUNCTION wiki_name_parens_balanced(name text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ … $$;                      -- depth never below zero, and zero at the end
CREATE FUNCTION doc_sync_wiki_name_key() RETURNS trigger …;
CREATE TRIGGER doc_sync_wiki_name_key
  BEFORE INSERT OR UPDATE OF wiki_name ON "doc" FOR EACH ROW
  EXECUTE FUNCTION doc_sync_wiki_name_key();
-- Doc.title is a wiki page's name ("The name is the title"). BEFORE triggers
-- fire in name order, and this one must run before doc_sync_search_vector.
CREATE FUNCTION doc_mirror_wiki_name() RETURNS trigger …;  -- NEW.title := NEW.wiki_name
CREATE TRIGGER doc_mirror_wiki_name
  BEFORE INSERT OR UPDATE OF title, wiki_name ON "doc" FOR EACH ROW
  WHEN (NEW.wiki_name IS NOT NULL)
  EXECUTE FUNCTION doc_mirror_wiki_name();

ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_owner_needs_name"
  CHECK ("wiki_owner_user_id" IS NULL OR "wiki_name" IS NOT NULL);
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_variant_needs_name"
  CHECK ("wiki_variant" = '' OR "wiki_name" IS NOT NULL);
ALTER TABLE "doc" ADD CONSTRAINT "doc_public_only_wiki"
  CHECK ("visibility" <> 'PUBLIC' OR "wiki_name" IS NOT NULL);
ALTER TABLE "doc" ADD CONSTRAINT "doc_commons_not_private"
  CHECK ("wiki_name" IS NULL OR "wiki_owner_user_id" IS NOT NULL OR "visibility" <> 'PRIVATE');
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_name_valid"
  CHECK ("wiki_name" IS NULL OR (
         "wiki_name" IS NFC NORMALIZED
     AND unicode_assigned("wiki_name")
     AND octet_length("wiki_name") BETWEEN 1 AND 255
     AND "wiki_name" !~ '<the refused characters and sequences>'
     AND "wiki_name" !~ '<an unfolded space, a run, or one at an end>'
     AND "wiki_name" NOT IN ('.', '..')
     AND wiki_name_parens_balanced("wiki_name")));
ALTER TABLE "doc" ADD CONSTRAINT "doc_wiki_variant_is_slug"
  CHECK ("wiki_variant" = '' OR "wiki_variant" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "file" ADD CONSTRAINT "file_not_public"
  CHECK ("visibility" <> 'PUBLIC');

CREATE UNIQUE INDEX "doc_wiki_personal_live_key"
  ON "doc" ("wiki_owner_user_id", "wiki_name_key", "wiki_variant")
  WHERE "deleted_by_user_id" IS NULL AND "wiki_owner_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "doc_wiki_commons_live_key"
  ON "doc" ("wiki_name_key", "wiki_variant")
  WHERE "deleted_by_user_id" IS NULL AND "wiki_name" IS NOT NULL
    AND "wiki_owner_user_id" IS NULL;
CREATE INDEX "doc_wiki_name_key_idx" ON "doc" ("wiki_name_key")
  WHERE "wiki_name_key" IS NOT NULL;
```

- **Prisma:** `Doc` gains `wikiOwnerUserId` (`wiki_owner_user_id`; on a wiki page, null means
  the commons'), `wikiName` (`wiki_name`; null for a doc that isn't a wiki page), `wikiNameKey`
  (`wiki_name_key`, written only by its trigger), `wikiVariant` (`wiki_variant`,
  `@default("")`), and `wikiOwner` (relation `"DocWikiOwner"`, `onDelete: Restrict`); `User`
  gains `wikiPages`.
- **The key column is written only by its trigger**, as the search vectors are (CLAUDE.md), and
  CLAUDE.md's list of such columns gains it and the history table's.
- **Prisma writes the foreign key.** An inline `REFERENCES … ON DELETE …` gets Postgres's
  `ON UPDATE NO ACTION`, where Prisma writes `ON UPDATE CASCADE` for a relation like this one, so
  the next `migrate dev` would emit a migration to change it.
- **The address lives on `doc`**, so the unique indexes can see deletion: a deleted page gives
  its address back, as `file_slug_live_key` does a file's slug.
- **Two partial indexes rather than `NULLS NOT DISTINCT`.** A commons page has a null owner,
  and a unique index treats nulls as distinct, so the commons gets an index of its own. Both are
  hand-written: Prisma 7.9 expresses a partial index only behind its `partialIndexes` preview,
  which is off here, and leaves hand-written ones out of what it introspects, so they never
  drift.
- **`ON DELETE RESTRICT` on the owner is load-bearing.** Prisma's default for an optional
  relation is `SetNull`, which would quietly turn a hard-deleted user's pages into commons
  pages. The app soft-deletes users, so only scripts and e2e fixtures meet it, and the e2e
  worker's `deleteTestUser` deletes a user's pages first ("Testing").
- **A page restored after its address was taken comes back at the next free variant**, as a
  slug collision takes the next suffix: `~2`, `~3`, … for the page itself, `~v-2` for a variant
  `v`. The suffix goes on the variant, since the name is what makes pages "the same name", and a
  name can end in `2` by itself (`World War 2`). `setDocDeleted` picks the variant under the
  address lock, so the index never refuses a restore as a raw duplicate-key error, and returns
  where the page now lives and the address it had, as `setFileDeleted` returns `{ slug,
  renamedFrom }`.
- **Commons pages are never `PRIVATE`.** A `PRIVATE` doc is its byline's alone, so a private
  commons page would hold a name the other editors can't see, and their attempt to create it
  would fail on the unique index and reveal that it exists.
- **`PUBLIC` is for wiki pages only, and never for files.** Files share the enum; the CHECK on
  `file` is what keeps the file code's visibility comparisons correct as they are.
- **`Doc.title` holds the name** for a wiki page ("The name is the title"), so a listing, the
  search vector and every `docTitleOrFallback` caller show it with no change of their own.

### Claiming an address

**Every write that claims an address takes a lock first, as claiming a file's slug does.**
Creating, forking, moving, renaming and restoring each take a transaction-scoped advisory lock
on the owner and the name's key, then check the address and pick the variant under it, in the
transaction that writes the doc. Two claims of one name then queue rather than race, and the
partial unique indexes stay as the backstop.

- **The key is built in TypeScript**, as `lockFileSlug`'s is (`src/lib/file-slug.ts`): the
  two-key `pg_advisory_xact_lock`, in a lock space of the wiki's own (`wiki` as four ASCII
  bytes, where the file slugs' is `file`), with `hashtext(<owner> || '/' ||
  wiki_name_key(<name>))`, the owner being `<owner id>` or `commons`. Built in SQL from the
  owner column, a commons page's null owner would make the key null, and `hashtext` and
  `pg_advisory_xact_lock` are both STRICT, so the call would lock nothing. All the variants of
  a name share its lock, since a default is picked by reading them all.
- **A renaming locks the doc's row first** (`lockDoc`), then the addresses it leaves and takes,
  in key order ("Renaming"), as every write to an address does: moving and restoring take the
  row before the address too.
- **A fork into the wiki locks its parent's row before its address too.** Inserting a fork
  takes `FOR KEY SHARE` on the parent's row, for `doc_forked_from_doc_id_fkey`, and a rename, a
  move or a restore of the parent holds that row `FOR UPDATE` and then takes its address lock.
  A fork to the parent's own owner and name, claimed first and inserted second, would take the
  two in the other order, and Postgres would end one of the writes as a deadlock. So with
  `forkedFrom` and `wiki` both given, `createDocWithContent` takes `FOR KEY SHARE` on the
  parent's row as its transaction's first statement, and claims after.
- **A default variant is the server's to pick.** A dialog whose variant was left alone sends
  none, and the server walks the default sequence under the lock and takes the first free
  address, so of two claims of one default address the second gets the next one. A dialog that
  sent back the default it showed would have that second claim refused as taken.
- **A typed variant is taken as typed**: one already taken is answered "that address is taken"
  before anything is written.
- **An address held by a history row is taken** ("Renaming"), for every claim and every default
  sequence, but the page's own.
- **A duplicate key on an address index means a write that skipped the lock**: a fault,
  surfaced as one. A P2002 on `Doc.slug` is retried as main retries it
  (`isUniqueViolationOn`, `src/lib/unique-violation.ts`).

## The name is the title

- **A wiki page's title is its name**, and `wiki_name` is where it lives. There is no title to
  edit apart from it, and a page can't be untitled, since a name can't be empty.
- **`Doc.title` mirrors the name, by a trigger.** `doc_mirror_wiki_name` is a `BEFORE INSERT OR
  UPDATE OF title, wiki_name` trigger on `doc` that sets `NEW.title := NEW.wiki_name` whenever
  `wiki_name` is set. So the collab server's cache write (`server/doc-cache.ts`) stays the Prisma
  `updateMany` it is, writing the fragment's text as `title`, and the row ends up holding the
  name anyway; and so does every other writer of `title`: `createDocWithContent`, `insertDocRow`,
  the e2e worker's `createTestDoc`, the seed and import scripts. Every write that sets
  `wiki_name` also sets `title` to the same value, because the search vector's trigger
  (`doc_sync_search_vector`, `BEFORE … UPDATE OF title, prose_json`) fires by the columns a
  statement names, and a rename that named `wiki_name` alone would leave the vector on the old
  name. **The mirror's name sorts before `doc_sync_search_vector`'s**, since Postgres fires
  `BEFORE` triggers in name order and the vector must be computed from the name; a comment in the
  migration says so. Everything that reads the column then shows the name with no change of its
  own: the search vector, the listings, the `[[` menu, the link preview, the MCP reads, and every
  `docTitleOrFallback` caller but the five handed a title read from the fragment, which the next
  bullet covers.
  - **A raw `UPDATE` in `server/doc-cache.ts` was rejected**, which the titles amendment
    planned. It would have had to write `title` as `coalesce(wiki_name, <fragment>)`, and with it
    `chip_styles`, `updated_at`, and `updated_by_user_id` and `prose_json_update_id` only when
    known, in place of a Prisma write, and it would have covered that one writer. A trigger
    covers every writer at once, and the column it maintains is derived, which is what the repo's
    triggers are for.
  - **`scripts/integrity/check-doc-integrity.ts`'s title-cache check** compares `Doc.title` to
    the fragment, and expects the name for a wiki page instead, in both of its branches: the one
    for a stale title, and the one for a title with no fragment, which reports without
    `--verbose` and would fire for a doc with no title moved into the wiki.
- **The ydoc's title fragment is left as it is, and nothing shows it on a wiki page.** The live
  title (DOCS.md, "The title follows the fragment live") doesn't apply: the heading, the browser
  tab, the scrub bar's title at a version and a side-by-side column's heading, in either mode, are
  the name. `DocView` takes a fixed title for a wiki page in place of its live and replayed ones,
  and side-by-side's write column mounts no `CollabTitleField` for one. The diff page's headings are
  the name too ("Diffs"). Writing the name into the fragment was rejected: every claim and rename
  would then be an edit through the collab server, and the fragment could still change under the
  name, since MCP's `edit_doc` sets a title, a revert can restore one, and an offline copy can carry
  an old edit.
- **The name above the editor's text is the rename control**, where a doc has its title field: a
  field holding the name, checked by the rules as it is typed, with a Rename button once it
  differs ("Renaming"). A rename goes on to the editor at the new address. The variant changes
  on `/doc/<slug>/slug`, whose Rename takes both ("Renaming"), and the namespace through the
  menu's Move… ("The Actions menu"). Until renaming lands (PR 3) the field is read-only.
- **MCP's `edit_doc` refuses a `title` for a wiki page**, pointing at the rename. A revert that
  restores a title is harmless, since nothing shows the fragment.
- **Scrubbing, `?at=` and a diff's version show the text at that version under the current
  name.** Past names are the address history's ("Renaming").
- **A doc entering the wiki offers its title as the name.** Moving and forking fill the name in
  with the doc's title, normalized; a title the rules refuse is edited in the dialog before
  anything is claimed. On `/wiki/new` the name field is the title field.
- **A fork changes its title by being renamed, and so leaves "Same name"** ("The family line").
- **The Claude-chat importer matches docs by title** (`scripts/import-claude-chats.ts`), and
  would see a wiki page's name. Imported docs aren't wiki pages, and one moved into the wiki is
  no longer the importer's to update; its matching skips wiki pages.

## Labels

**A wiki page's label is its address, as stored**: `@jane/Mercury (planet)~2`, or
`commons/Mercury (planet)` for the commons. The title alone doesn't tell such pages apart: every
variant of a name has the same title, and so does a page of that name in each namespace. The name
appears with its spaces; only a link's path uses `_` and encoding. No name holds `/` or `~`, so
the delimiters are unambiguous.

**For now, only the `[[` menu's options show it.** `DocRefMenu` is a wrapper over the shared
`SuggestionMenu`, and its `renderRow` draws an option: for a wiki page, the label, as text, since
the option is what a click chooses and a link inside it would navigate instead; for a doc that
isn't one, its title, as now. `linkableSelect` gains the address columns for it. What the menu
inserts (`pick`) is unchanged: a link to `/doc/<slug>`, which follows a page through a rename and
out of the wiki, with the title as its text, which for a wiki page is its name.

- **A rename relabels nothing already written.** A link's text is frozen when it is inserted, as
  every doc link's is (ENTITY_CHIPS.md: doc links are not chips), so a page renamed keeps its old
  name in the links other docs hold, and shows its current one in the link's preview bubble,
  which reads `Doc.title`. Doc links as chips, whose text follows the record, would fix that, and
  are not in this plan.
- **Everywhere else a wiki page shows its title, which is its name**: the family line, the diff
  page's headings, the link control's Ctrl-K search, search hits, the mentions-of and cited-by
  lists, tag pages and the MCP reads. Two variants of one name read alike there, and are told
  apart by where they link. Labels on those surfaces are deferred ("Deferred").
- **A namespace list shows each page's name with its variant after the `~`**, as the `wiki`
  branch's lists do: the list is one namespace's addresses, and without the variant its entries
  would read alike.

## Permissions

| | A person's page, `/wiki/@x/…` | A commons page, `/wiki/commons/…` |
|---|---|---|
| Create | `x`, with `canManageDocs` and a slug not made from their email | ADMIN or EDITOR |
| Read | by visibility: `PRIVATE`, its byline; `SHARED`, `canViewDocs`; `PUBLIC`, anyone | the same, but never `PRIVATE` |
| Edit | its byline only, and `x` is always on it | its byline, plus ADMIN and EDITOR: the `SHARED` rule |
| See history | as Edit (main's interim rule, FORKS.md), with its fork-point exception | as Edit, with the same exception |
| Fork into | the forker's own namespace, with `canManageDocs`, a slug not made from their email, and a parent they can read | ADMIN or EDITOR, from a parent they can read |
| Move a doc into | `x`, for a doc x can edit and is on the byline of, with a slug not made from their email | ADMIN or EDITOR on its byline, for a doc they can edit; a `PRIVATE` one is made `SHARED` or `PUBLIC` in the move |
| Rename within the namespace | its byline | its byline, plus ADMIN and EDITOR; to a held name, ADMIN or EDITOR alone (below) |
| Move to another namespace, or out | `x` alone ("Renaming") | ADMIN or EDITOR on its byline |
| Change visibility | `x` may raise it; its byline and ADMIN may lower it (`allowedVisibilities`, below) | as for any doc, within `allowedVisibilities` |
| Delete or restore | `x` alone | as for any doc: its byline, plus ADMIN and EDITOR; restoring to a held name, ADMIN or EDITOR alone |

PERMISSIONS.md gains these as tables of its own after its doc tables, with main's "See history"
wording and its ‡ for the fork-point exception, and edits the two places that say there is no
public doc tier.

**A person's namespace needs a slug that isn't made from their email.** An account that signs up
without a name is given its email's local part as its slug (`uniqueUserSlug`,
`src/lib/user-slug.ts`), and keeps it after adding a name, since only an ADMIN changes a slug.
A display name never falls back to it (`src/lib/display-name.ts`), though a nameless account's
mention label and its `/authors/` link do carry it, and a person's address would
put it in every one of their pages' URLs, in front of anyone once a page is `PUBLIC`. So creating,
forking or moving into your own namespace is refused while your slug is the one your email gives,
`slugify(<local part>, "user")` with or without a `-2`, `-3`… suffix, unless your name gives the
same one. The refusal says an ADMIN can change the slug. The test is pure, in
`src/lib/wiki-address.ts`, so the functions and the dialogs that offer "your namespace" ask the
same one.

**A bot has no namespace.** A bot (docs/MCP.md §21) has no session, and is never listed `manage`,
and no MCP tool makes a wiki page, so nothing it does could make one there. The email-slug test
doesn't settle it: a bot made at Approve has a slug equal to its email's local part,
`<person>-<agent>`, which the test refuses, but one an ADMIN makes takes its slug from its name and
its address from its slug (`createBot`), which the test lets through. So the rule is its own check:
the owner of a person's namespace is a person, `worksForUserId IS NULL`, which every bot fails,
checked where the namespace is offered and where it is claimed, and `/wiki/@<bot-slug>` answers as
an unknown owner. Whether a bot writes in its person's namespace or one of its own is MCP's
question, when its tools can make a page ("Deferred"). A bot can still be on a page's byline, as
on any doc's.

**Some commons names are held for ADMIN and EDITOR.** `src/lib/wiki-address.ts` keeps the list,
`HELD_COMMONS_NAMES`: `Front Page`, whose page is the landing page's preamble ("The front
page"), and `About`, which nothing reads yet. A claim of a commons address with one of those
names, whatever its variant, needs an ADMIN or EDITOR.

- **The check is in the claim** (`src/lib/wiki-claim.ts`), so creating, forking, moving in,
  renaming and restoring all meet it, and none can be added without it.
- **It compares keys**, in the statement that already asks the database for the name's key
  ("The `wiki` option"), so `ABOUT` and `front page` are held too.
- **What it adds is renaming and restoring.** Creating in the commons, forking into it and
  moving into it are an ADMIN's or EDITOR's already, but a commons page's byline may rename and
  restore it, and an AUTHOR can be on one. Without the list, an AUTHOR on any commons page's
  byline could rename it `Front Page` while that name was free, raise it to `PUBLIC`, and put
  its text on `/`.
- **A page that holds such a name is its byline's as any commons page is**, to edit, lower,
  rename away and delete: an ADMIN or EDITOR gave it the name, and chose its byline.
- **A person's namespace holds none**: `/wiki/@x/About` is x's.
- **The refusal says the name is kept for editors.** The list is a constant, not a setting, and
  `getFrontPagePreamble` takes its name from it.

**A person's page has no ADMIN/EDITOR bypass.** `canEditAnySharedDoc` lets ADMIN and EDITOR edit
any `SHARED` doc whatever its byline. Under `/wiki/@x/` that would put other people's words under
x's name, and forking is how someone who disagrees with a page changes it. So the rule is stated
once, as **`canEditDocRow`** in `src/lib/doc-authz.ts`, which skips the role branch when
`wiki_owner_user_id` is set, and everything asks it:

- **`canUserEditDoc`** reads the address columns in the query it already makes, and asks it.
- **`editableDocsWhere`**, main's filter form, carries the same carve-out on its `SHARED` branch.
  It feeds `editableDocsFor` and `docsWithVisibleHistoryWhere`, so the history filter and the
  per-row check keep agreeing: without it, the family line would offer an EDITOR diffs of a
  person's page that come back Forbidden, and the fork-point exception's query would grant more
  than the per-row rule.
- **`editableDocsFor`** alone adds `wikiName: null`, since it feeds only the two post pickers and a
  wiki page publishes nothing. On the shared filter, that would strip every wiki page's history
  from the family line and the fork-point exception.
- **The edit page's gate** (`src/app/doc/[slug]/edit/page.tsx`) and **`/docs`' per-row Edit link**
  (`canEdit` in `src/app/docs/page.tsx`), which state the rule inline today with a literal
  `"SHARED"`, ask `canEditDocRow` instead, and so does the wiki table's Edit link. Missing that
  one would show an EDITOR an Edit link that leads to Forbidden.

**The rules on a doc's settings live in `src/lib/doc-manage.ts`**, not in the server actions around
it, since MCP's `manage` calls `setDocByline`, `setDocVisibility` and `setDocDeleted` directly
(`src/lib/mcp/tools/manage.ts`), and a rule in an action would bind the editor and `/docs` and not
MCP. So these all live in those three functions: the owner staying on the byline; the owner alone
raising and deleting; `allowedVisibilities`; ADMIN's lowering; a restore's next free variant; and,
with renaming, a deleted page's history rows. **Each checks its rules under the doc's row lock**
(`lockDoc`, "Moving a doc into the wiki"): it locks the row first, in its transaction, and only
then asks `canEditDocRow` and its own rules, which read the address columns under the lock.
`setDocSlug` and `setDocRecord`, the other two `manage` calls, lock first as well, so neither a
record flag set through the `SHARED` bypass nor a slug change lands on what a move has just made
a person's page, and `changeDocSlug`'s refusal of a wiki doc reads the row under that lock.
`doc-manage.ts` is unchanged on main since the `wiki` branch was cut, so its changes there apply as
written.

**The visibility actions gate on the session alone**, as `setDocDeletedAction` does:
`updateDocVisibility`, which `bulkSetDocVisibility` calls per row, hands the session's actor
straight to `setDocVisibility`. Main's `updateDocVisibility` asks `requireEditableDocSession`
first, which would refuse an ADMIN's lowering from the wiki table that MCP's `manage` allows.

**The owner is always on the byline.** `setDocByline` refuses a byline without
`wiki_owner_user_id`, so the editor's add, remove and reorder and MCP's `manage` all meet the same
refusal, which names the owner's id: MCP's `manage` takes a byline as user ids from `find_users`,
which never lists a deleted or demoted account, so an MCP client has no other way to learn a
lapsed owner's id. **Co-authors may add to the byline too, by decision**, though on a `PRIVATE`
page that widens who can read it, and on a `PUBLIC` one puts the added author's words under the
owner's name, since the public render names the owner alone.

**Raising a person's page's visibility, and deleting or restoring it, are its owner's alone**,
judged by their account as it is now. `setDocVisibility` and `setDocDeleted` accept a raise, a
delete or a restore only from the owner, and only after reading the owner's row again through the
filtered `prisma` and finding a live person who holds `canManageDocs` (`ownerWhoCanAct`). The
actor's role isn't enough: a browser session is a JWT that keeps the role it was signed in with,
and outlives a deleted account (src/app/sign-in/NOTES.md). Creating, forking, moving and renaming
into `@x` make the same read of `x`'s row, inside their transactions, and run the email-slug test
on it. An owner whose account is deleted, or whose role drops below AUTHOR, loses all of these at
once, and they pass to nobody. That is what makes an ADMIN's lowering stick: an ADMIN whose
takedown keeps being undone demotes the owner, and the re-read makes that hold at once.

**ADMIN may lower a person's page's visibility, and do nothing else to it**, the counterpart of an
ADMIN unpublishing any post. It is reached from the wiki table's Visibility cell and from MCP's `manage`;
the ADMIN can't open the editor. Moderating its annotations is the one other thing an ADMIN does
there, as on any doc: deleting an annotation made in the editor takes that annotation's mark out
of the page's ydoc (`removeAnnotationMark`), and nothing else.

**Each row of the wiki table says what may be done to it**: `canSetVisibility` with its
`allowedVisibilities`, and `canDelete`, beside `canEdit`. The Visibility cell can't key off
`canEdit`, which is false for the row an ADMIN may lower. The row's Delete button and the bulk
Delete and Restore go by `canDelete`, so on a person's page a co-author or an EDITOR isn't offered
a delete that `setDocDeleted` would refuse; main's `softDeleteBulkActions` gains the per-row
`canToggle` the `wiki` branch gave it.

**A person's pages outlive their account.** The wiki routes find the owner through
`prismaIncludingDeleted`, so pages that were visible to others stay visible to them after the
owner's account is deleted, as `softDeleteUser` leaves a person's docs and posts. That covers
every lookup of an owner by slug: the page route, the namespace list and the old-slug redirect.

**Commons pages keep the `SHARED` rule**, which is in effect one group of every ADMIN and EDITOR.

### `PUBLIC` outside the wiki's routes

**Outside the wiki's routes, `PUBLIC` behaves exactly as `SHARED`.** Every test of a doc's
visibility asks `isSharedOrPublic`, and every `where` clause uses `sharedOrPublic()`, one helper
over one constant pair of values in a browser-safe module (`src/lib/doc-visibility.ts`). A
comparison to `SHARED` alone compiles and is wrong: `readableDocsWhere` written that way would list
a `PUBLIC` page to nobody, its own author included. Main has 35 such literals in 18 files, against
24 when the `wiki` branch swept them, so the sweep is redone against main, and falls in four kinds
(about 14 of the 35 are the file side's, and one, in `LiveAnnotationComposer.tsx`, is an
annotation mode's label and no visibility at all):

| Kind | Where on main | What happens unswept |
|---|---|---|
| A comparison or `where` on `"SHARED"` | `doc-authz.ts`' bypass, `canUserReadDoc`, `readableDocsWhere`, `editableDocsWhere`; `/docs`' listing scope, its `readable` flag (which withholds tags and `canTag`) and `canEdit`; the edit page's gate | compiles, and treats `PUBLIC` as `PRIVATE`: a `PUBLIC` commons page an ADMIN can't edit, a page missing from `/docs` |
| A literal `"PRIVATE" \| "SHARED"` type | docs: `canUserReadDoc`, `resolve-doc-param.ts`, `annotation-authz.ts`, `mcp/resolve.ts`, `entity-chips/context-for.ts`; files: `file-authz.ts`, `mcp/resolve.ts`, `context-for.ts`, `cited-passage.ts`, `pdf/[slug]/reading.tsx` | `tsc` refuses it, which is the useful kind |
| A select offering the enum | `DocSettingsPanel`, `DocsTable`'s cell and bulk action; `FilesTable`'s two; the scripts `test-doc.ts`, `test-file.ts`, `import-legacy.ts`, `etherpad/import-etherpad.ts`, `test-annotated-doc.ts` | offers `PUBLIC` where a CHECK then refuses it |
| A refusal by name | `setDocVisibility`, `forkDoc`, `file-manage.ts`, MCP `manage`'s `z.enum`, `ForkDialog` | fails closed, as it should; `setDocVisibility` and the doc selects take `allowedVisibilities` instead |

Everything that reads through `canUserReadDoc` or `readableDocsWhere` is right once those are:
search, mentions-of and cited-by, the reference export, tags, anchored links, doc links, the diff
gate, side-by-side, the collab token and MCP's reads. Files share the enum, and `file_not_public`
keeps the file side's comparisons correct as they are; its selects offer `FILE_VISIBILITIES`. No
raw SQL, view, trigger or collab-server code names a visibility value.

**Which values a doc may take is one function, `allowedVisibilities(doc, viewer)`**, pure and
browser-safe, in `src/lib/doc-visibility.ts`. The Settings panel, and the wiki table's and
`/docs`' cells and bulk actions, take their options from it, and `setDocVisibility` validates
against it, so what is offered and what is accepted can't differ:

- `PRIVATE` and `SHARED` for a doc that isn't a wiki page;
- `PUBLIC` as well for a wiki page;
- no `PRIVATE` for a commons page;
- on a person's page, for anyone but its owner (a co-author, or an ADMIN lowering it), only its
  current value and those below it.

A bulk action offers the values some applicable row allows, and drops the rows a value
isn't allowed for: the `wiki` branch's `allows(row, value)` in `BulkToolbar.tsx`, ported with
`canToggle`, since main's toolbar has neither.

**MCP can't make a page `PUBLIC`**: `manage` keeps its `z.enum(["PRIVATE", "SHARED"])` until it
understands wiki addresses ("Deferred").

**A fork's visibility is its own, whatever its parent's**, as FORKS.md decided for every fork.

## Public pages

**A signed-out reader of a `PUBLIC` page gets a static render**, and so does a signed-in one
without `canViewDocs`. Its body is `prose_json` through `docJsonForPostSide`
(`src/lib/post-content.ts`), rendered with `contentExtensions`, as the landing page renders its
preamble: the `authorHighlight` and `annotation` marks stripped, entity chips turned into their
labelled links, and the bibliography appended. Without it the renderer refuses the doc's marks and
chips, and the page 500s on any page holding a mention or a citation; the `wiki` branch's
`public-page.tsx`, which stripped the marks alone, predates chips and would. It sits inside
`.prose`, with the name, whose page it is, and the family line ("The family line"). Whose page it
is links to the owner's namespace, `/wiki/@<slug>`, rather than to `/authors/`, which 404s once the
account is deleted while its pages stay. It shows no byline, by decision: a person's page names its
owner, and a commons page credits nobody. A `prose_json` that is still null, on a doc moved into
the wiki before anything stored it, is decoded from the ydoc with the same conversion, as
`postContentFromYdoc` does; that function throws on a ydoc it can't read, which the render
catches and shows as a page with no text, where uncaught it would be a 500.

**It reads no session below its route's gate, and mounts nothing that would.** Today's doc page
calls `auth()` through `gated()`, asks the edit and history predicates and `canManageDocs`, loads
the family for a viewer, reads the viewer's open anchored link and color, mounts
`AnnotationSection` (which calls `auth()`), and runs client islands that call signed-in routes:
the live tap's token, `/api/chip-context`, the scrub bar's replay and index, the bibliography
download, the menu's actions, `AnchoredLinkTray` and `TagStrip`. The public render has none of
them: no `DocView`, no providers, no annotations, no tags, no live connection and no scrub bar,
and its bibliography has no download.

**The public render is dynamic and uncached, by decision.** One route answers a signed-in
reader with the doc view and everyone else with this render, and reads the session to tell them
apart, so nothing of it is cached: every signed-out request, a crawler's included, costs the
owner and page lookups, the chip labels, the bibliography, the family queries and a render.
TODO.md gains an entry with PR 2. A cache would be keyed on more than the doc's stored text,
since a mention's label and a citation's change without the doc changing ("Deferred").

**What a public page publishes**, beside its text:

- **Mention labels**, a person's name, initials or handle by the doc's style, each linking to
  `/authors/<slug>`, which is public for any account, and each carrying the person's user id
  (`data-chip-ref`); a deleted account's name stays, struck through. A post publishes the same
  today. So every mention puts the person's slug on the page, in its link, an email-derived one
  included, which is what a person's namespace refuses to put in a URL; it is the label itself
  in the handle style, and its qualifier when two people share a label. A post does the same
  now, and TODO.md gains an entry for both.
- **Citation labels and the bibliography**, from reference records, which are public.
- **Link text**: the editor's link picker writes the linked doc's title as a link's text, a wiki
  page's name included ("Labels"), so a link to a private doc puts that doc's title on a public
  page.
  Choosing `PUBLIC` says so beside the choice, in the Settings panel and every dialog.

**A public page's links lead where they lead.** A link to `/link/`, `/pdf/` or `/files/` sends a
signed-out reader to sign in, since those routes are gated and a file is never `PUBLIC`. A `/doc/`
link to another public page reaches it ("URLs").

**`PUBLIC` widens who reads the text, not who reads the annotations**, which were written for
`canViewDocs` readers. The collab token, replay, index, diff and annotation endpoints keep their
gates. What keeps a COMMENTER out of them is `canViewDocs`, not a session, since a COMMENTER has
one: each gate is built on `canUserReadDoc` or `canUserEditDoc`, and both refuse a COMMENTER a
`PUBLIC` page, as they do a `SHARED` one. That holds only while the wiki read rule stays outside
`canUserReadDoc` (below).

**What a reader sees follows from what is typed, within seconds.** The render reads the stored
copy, which follows typing by the store debounce, so a half-written sentence goes out as it
stands; the editor says so on a `PUBLIC` page ("Telling a wiki page from a doc").

**The route needs an envelope that admits a null viewer.** `gated()` (`src/lib/route-access.ts`)
returns `signed-out` before a route's own loader runs. So a second envelope sits beside it,
`gatedAnyViewer`, which the wiki routes and `/doc/[slug]` use. Its loader is given a viewer that
may be null, and returns `"signed-out"` itself for whatever still needs a sign-in. It has an
`Access` type of its own, since `gated()`'s `ok` arm carries a non-null `user`. `route-access.ts`
is unchanged on main since the `wiki` branch built this, so the envelope is taken as it was.

**Reading a wiki page is a read rule of its own**, written as CLAUDE.md's search invariant asks of
every read rule: a per-row check, `canReadWikiDoc`, and a `where` beside it,
`readableWikiDocsWhere`, in `src/lib/doc-authz.ts`, for a viewer who may be null. A viewer may read
a wiki page if `canUserReadDoc` says so, or if the page is live and `PUBLIC`. The `where` sits
beside `readableDocsWhere` rather than inside it: that one takes a user, and returns null for a
viewer without `canViewDocs`, signed out or COMMENTER, which is exactly who this rule exists for.
The page route, the namespace lists, `/wiki`, the family line on a wiki page, the front page and
`/doc/[slug]`'s redirect all go through it. **It stays outside `canUserReadDoc`**, which every
other gate on a doc is built on, so `PUBLIC` reaches no route but those, and CLAUDE.md says so.

## The front page

**The landing page's preamble is the body of the commons page named `Front Page`, when it is
`PUBLIC`, and nothing otherwise.** Its address is `/wiki/commons/Front_Page`; the name matches by
its key, so `front page` and `FRONT PAGE` are the same page; and only the page itself counts, not
a variant, and not a person's page of that name. A doc titled `FRONT PAGE` is just a doc.

- **`getFrontPagePreamble`** (`src/lib/front-page.ts`) asks for a live doc with no owner,
  `wiki_name_key = wiki_name_key('Front Page')`, variant `''` and visibility `PUBLIC`, through the
  wiki read rule's `where` for a null viewer, and renders it as it does now, through
  `docJsonForPostSide`. The page's name is never shown, as the title never is now. Its lookup reads
  no session, so the landing page keeps its ISR cache (`revalidate = 60`, docs/BLOG.md §8).
- **It closes a hole on main.** Today's query takes the earliest-created doc titled `FRONT PAGE`,
  with no visibility or role check, so anyone who may manage docs and has an older doc can retitle
  it and put its body on `/`. Under the new rule only an ADMIN or EDITOR can give a commons page
  that name ("Permissions"), only its byline or an ADMIN or EDITOR can change its text, and only
  a page made `PUBLIC` shows, which is what `PUBLIC` already means.
- **Every write that can put a page there or take it off revalidates `/`**: a create, a fork
  into the commons, a visibility change, a delete or restore, a bulk visibility change, a rename,
  and a move in or out, each when the page is a commons page. Otherwise a page lowered from
  `PUBLIC` would stay on `/` until the cache next expired, up to 60 seconds; an edit to its text
  reaches `/` as it does now. The server actions revalidate, and so does MCP's `manage` for the
  lowering, delete and restore it can make: the functions in `src/lib/` revalidate nothing, and
  no MCP tool does today.
- **The Settings panel, the rename field and the Move dialog say so** on that page: lowering it,
  renaming it, moving it out or deleting it takes the preamble off the landing page.
- **`scripts/seed-front-page.ts`** creates the commons page, `PUBLIC`, through `wiki-create.ts`,
  where it now makes a `PRIVATE` doc titled `FRONT PAGE`.
- **The rule's every statement changes with it**: CLAUDE.md's invariant and its table's row for
  docs/BLOG.md, PLAN.md §17, §17a's heading and §17c,
  docs/BLOG.md §1 ("The preamble", already stale against `front-page.ts`), §8, §9 and §10,
  DEPLOY.md, docs/DOC_IMPORT.md §5, docs/ENTITY_CHIPS.md, docs/CITATIONS.md, docs/TIPTAP.md,
  TODO.md, the comments in `front-page.ts` and `post-content.ts`, and `e2e/landing.spec.ts` and
  `e2e/admin-table.spec.ts`.
- **An instance with a `FRONT PAGE` doc moves it into the commons as `Front Page`, `PUBLIC`, at
  the deploy that brings this rule** ("Before the wiki reaches an instance"), or its landing page
  loses its preamble. The move keeps the doc's body, history and everything hanging off it; only
  its title becomes the name.

## The doc view at an address

**A wiki page is shown by the doc view and the editor main has, at its address.** The `wiki`
branch moved `/doc/[slug]`'s page body into `doc-reading-view.tsx` and its editor page's into
`edit/doc-edit-view.tsx`, so that `/doc/<slug>` and `/wiki/<owner>/<page>` render one view. That
split is redone from today's pages, not copied: main has changed both since, and a copy of the old
files compiles and silently loses entity chips (no `ChipSurfaceProvider`, so `useChipInputs` does
nothing and the fallback renders unlabelled), the static bibliography, the filter that hides a
deleted annotation's highlight (`entryHasVisibleContent`), the async `buildAnnotationEntries`, and
the scrub bar's gate on `canUserSeeDocHistory`.

- **What becomes a parameter of the view**: its title (fixed on a wiki page, "The name is the
  title"), the title's edit link, "View and Annotate" and the Settings panel's "Change…", which
  link through `wikiPathOfDoc`; the family line; the menu's items; and `canPublish`, false on a
  wiki page.
- **Every element handed to `DocView` among siblings keeps its `key`**, the byline and the family
  line among them (CLAUDE.md, "A Server Component handed to a client component as a prop needs a
  `key`").
- **Each route keeps its own gate** and hands the view what it loaded, as route-access's envelope
  shares the shape and never the gate.

## Telling a wiki page from a doc

**A wiki page's doc view and editor carry an address line above the title**: "Wiki › @jane ›
Mercury (planet)~2 · SHARED", with "Wiki" linking to `/wiki` and the owner to their namespace's
list (`src/components/wiki/WikiAddressLine.tsx`). The name is shown as stored, with its spaces. A
doc that isn't a wiki page has none, which is the tell, since otherwise the two views are the same
view. The line ends with the page's visibility, and `PUBLIC` is set apart in the warning colors as
"PUBLIC: anyone can read this, signed out". The public render has no such line: what it shows is
a `PUBLIC` page by definition, and it already says whose.

**The editor of a `PUBLIC` page says so above the title**: "This page is PUBLIC: anyone can read
it, signed out, and what you type here reaches them within seconds." The notice follows the
Settings panel, which reports a visibility the server has accepted (`onVisibilityChange`, new on
`DocSettingsPanel`), and the line and the notice change with it. In the phone-landscape focus mode
the address line is hidden with the title, and the notice stays.

## Listing wiki pages

**Wiki pages have an admin table of their own, at `/wiki/special/pages`, and `/docs` lists no
wiki page**, by decision (2026-11-17): the two are kept apart.

- **It is built as every admin table is** (CLAUDE.md, "Admin tables are one kit"): rendered
  through `src/components/table/`, over a `wiki-pages-query.ts` on `src/lib/table-query.ts`, with
  its filters, sort, pagination and show-deleted toggle in the querystring and applied in Postgres.
  Its route is `src/app/wiki/special/pages/`, a static segment, which Next matches ahead of
  `[owner]/[page]`; any other `/wiki/special/<x>` is a reserved segment naming no namespace, and
  404s.
- **Who sees it, and which rows**: a signed-in viewer with `canViewDocs`, as `/docs`; its rows
  are the wiki pages `/docs`' own scope would list, with the same ADMIN "Show all" override, and
  the same withheld tags on a row only the override lists. Signed out, it is the sign-in redirect.
- **Its columns**, each sortable: namespace (the owner's slug, the commons first), name (by
  `wiki_name_key`, so case doesn't order it), variant, visibility, authors, updated, length (the
  stored `prose_json_length`), tags (`doc_tag_summary`, as `/docs` draws them), and forked from.
  It filters by namespace and visibility. The name links to the page, and the namespace to its
  list.
- **Each row says what may be done to it**, by the rules in "Permissions": Edit by
  `canEditDocRow`; the Visibility cell by `canSetVisibility` and `allowedVisibilities`; Delete
  and Restore by `canDelete`, with the confirmation that lists a page's old addresses ("Deleting
  a page"). Its bulk actions are visibility and delete or restore, which drop the rows a value or
  an action doesn't apply to, as the kit does.
- **`/docs` adds `wikiName: null` to its scope.** It keeps the delete confirmation, for a doc
  moved out of the wiki that still has released rows ("Moving out of the wiki").
- **The header's menu links to it beside "Docs"** from PR 3 on, when the wiki is first linked
  ("Build order").

**Search has a "Wiki pages" section.** `src/lib/search/` gains a `wiki` kind beside `docs`, and
the two split on `wikiName`: the docs kind's readable ids add `wikiName: null`, and the wiki
kind's are the same rule's with `wikiName: { not: null }`, each through its own query, as every
kind is (CLAUDE.md, "Search ranks only inside ids a read rule chose"). A hit is shown as a doc's
is, title, byline and date, and links to the page's address. Signed out, the section is empty, as
the docs section is: searching `PUBLIC` pages signed out would take the wiki read rule beyond the
wiki's routes, and is deferred. MCP's search, which knows no `wiki` kind yet, asks for both when
it is asked for docs, so its results don't change.

## Doc rules a wiki page doesn't inherit

- **Publishing a post from it.** The feed lists only published posts, so a post is the one way a
  wiki page's text could reach it. `createPostFromDoc`, `publishPostFromDoc` and
  `schedulePostFromDoc` (`src/app/actions/posts.ts`) each take a doc id from the client, so all
  three refuse a wiki doc, through one check right after their `canUserEditDoc`; `/posts/new`
  goes through `createPostFromDoc`. Leaving "Publish as blog post" out of a wiki page's menu
  (`canPublish`), and wiki docs out of the two post pickers (`editableDocsFor`), are courtesies,
  not the rule. "Change doc…" tests the doc the request names, not the post's own.
  - **The check runs again inside each action's write**, as the first statement of its
    transaction: `SELECT wiki_name FROM doc WHERE id = $1 FOR KEY SHARE`. A move holds the doc's
    row `FOR UPDATE` while it counts the posts; a post written in that window, after its early
    check passed, would otherwise wait for the move and then succeed. `createPostFromDoc`'s insert
    runs in no transaction on main, and gets one for the locked check.
  - **`scripts/test-post.ts --doc` writes a post through none of them**, so it refuses a wiki doc
    by name.
- **The ADMIN/EDITOR edit bypass**, on a person's pages ("Permissions").
- **Its own slug as its URL** ("URLs").

## Creating a page

**`/wiki/new` asks for:**

- **where:** your namespace, or the commons for ADMIN/EDITOR;
- **a name**, which is the page's title, checked by the rules as it is typed ("What a name may
  hold"), with the rules' messages;
- **a variant**, empty unless typed;
- **a visibility**, defaulting to `PRIVATE` in your namespace and `SHARED` in the commons.

The 404's offer ("Requests and responses") opens it with the missing address filled in.

**Creating is a function in `src/lib/` taking an `Actor`** (`src/lib/wiki-create.ts`), wrapped
by a server action, on `createDocWithContent` with a `wiki` option ("The `wiki` option",
below). The body is empty. The title fragment is seeded with the name, marked as the
creator's, as MCP's `create_doc` marks its actor's text, so the doc's own record agrees with
its name from the first update; nothing on a wiki page shows the fragment ("The name is the
title"). The creator is the byline. `insertDocRow`, which `+ New doc` uses, can't serve: it
inserts at `PRIVATE`, which a commons page's CHECK refuses, and it has no transaction to hold
the lock in.

- **Into your own namespace, it reads your row afresh first**, inside its transaction, as
  raising does ("Permissions").
- **A taken address is refused**, "that address is taken", with a link to the page there. The
  address was typed, and a variant picked for the creator would make a second page where they
  may have meant to reach the first. The link reveals nothing, since whoever may create in a
  namespace can read all of it. An address a history row holds is taken too, and the link goes
  to the page holding it.
- It goes on to the new page's editor.

### The `wiki` option

**`createDocWithContent` (`src/lib/doc-create.ts`) gains a `wiki` option**, `{ ownerUserId,
name, variant }`, beside main's `visibility`, `forkedFrom` and `chipStyles`. Its write is
already one interactive transaction, so:

- **the claim runs first in that transaction**, after a fork's lock on its parent's row
  ("Claiming an address") and before `tx.doc.create`: the address lock, the
  name's key and `unicode_assigned` asked of the database in one statement, the variant picked
  or the typed one checked ("Claiming an address"). A refusal is thrown as a typed error, which
  passes through the create's slug retry untouched; a slug collision retries the whole
  transaction, claim included;
- **the address columns are written with the row**, and `title` is the name, not the seed's
  fragment text, so `Doc.title` holds the name from the first moment;
- **the slug is made from the name**, as it is from a title (`Mercury (planet)` gives
  `mercury-planet`). Main takes both the slug and the `title` column from the seed's title
  fragment, the slug before the transaction opens, and a fork's fragment is its parent's title
  at the forked version, so the option replaces the source of both;
- **`visibility` must be passed for the commons**, since the default, `PRIVATE`, fails
  `doc_commons_not_private`. The caller checks the value against `allowedVisibilities`, as
  `forkDoc` checks its own: the create checks nothing (its comment says so).

`createInTransaction` is left as it is on main: it stamps no update id, and `loadDocStateNow`
relies on a new doc's null `last_update_id`. So the namespace lists' "newest edit first" sorts
by `prose_json_update_id` with nulls last, then by `created_at`, and a page nobody has edited
sorts by when it was made.

## Forking into the wiki

**A fork into the wiki is main's fork with an address** (FORKS.md, "Forks"). The function,
`forkIntoWiki` in `src/lib/wiki-fork.ts`, is `readForkSource`, then `forkSeed`, then
`createDocWithContent` with `visibility`, `forkedFrom`, `chipStyles` and `wiki`. So everything
main checks before a fork is checked in main's order, by main's code: the argument types,
`canManageDocs` before any lookup, a missing or deleted parent, an unreadable one, the version
behind `canUserSeeDocHistory` and then `isDocVersion`, a parent with no log; and the
`annotation` strip and the chip styles are `forkSeed`'s. What the wiki adds:

- **The target namespace's rules**: your own with `canManageDocs` and a slug not made from your
  email, by a fresh read of your row inside the transaction, or the commons for an ADMIN or
  EDITOR ("Permissions").
- **An unreadable wiki parent is not found**, where `readForkSource` answers Forbidden for any
  other unreadable doc. Its select gains `wikiName` for that. The wiki's other routes answer an
  unreadable wiki doc as a missing one wherever it is looked up, and the fork's answer would
  otherwise be the one place to confirm one exists.
- **`PUBLIC` is allowed**, by `allowedVisibilities` for the target. Main's `forkDoc` refuses it
  by name, and keeps refusing it: a fork that isn't a wiki page can't hold it. The visibility
  defaults to `PRIVATE` in your namespace and `SHARED` in the commons, whatever the parent's.
- **The name defaults to the parent's**, or for a parent that isn't a wiki page to its title,
  normalized. A title the rules refuse, an empty one, or one with `?`, `/` or `~` in it, is
  edited in the dialog before anything is claimed. The dialog's default comes from the title
  the doc view has, `Doc.title`, so a fork at a scrubbed version defaults to the current name,
  not the version's; the name is a field, and the seeded fragment is the version's either way.
- **The variant is empty unless the default address is taken there.** Then it defaults to the
  parent owner's slug (`Institution~jane-doe`, or `~commons`) for a `PUBLIC` parent, and
  otherwise to `2`, `3`, …, as it does when that is taken too, or when the parent is already in
  the target namespace. A fork's address is public once the fork is, and the owner's slug in
  it would then name a parent the family line keeps back, so only a parent whose own address is
  public lends it. The parent's select gains the address columns for it. The dialog shows the
  default and sends none unless one is typed ("Claiming an address").
- **It returns the fork's wiki editor**, where `forkDoc` returns `/doc/<slug>/edit`.

**A wiki page forks as a doc too.** Main's `forkDoc` takes a wiki page for a parent as it takes
any doc its forker can read, and the fork is a doc: `PRIVATE` or `SHARED`, on the forker's
byline, and publishable as a post. Refusing it, to keep a page's text out of the feed under
another byline, was rejected: forking a page, changing it and publishing the result is
sometimes what is wanted, whoever can read a page can copy its text into a doc anyway, and a
fork says where it came from. What differs from a doc for a parent:

- **The fork's title is the page's name**, not the seed's. A wiki page's title fragment is not
  its title ("The name is the title"): it may hold an earlier name, or the title the doc had
  before it was moved in. `readForkSource` hands on the `wikiName` it selects, and `forkDoc`
  passes that to `createDocWithContent` where it passes `forkSeed`'s title for a doc. A fork at
  an earlier version takes the current name too, as the scrub bar shows it there.
- **An unreadable wiki parent is not found**, as above.
- **The family line names the parent at its wiki address** ("The family line").

## Moving a doc into the wiki

**Moving gives an existing doc an address, in place.** The row stays the same, so everything
hanging off it stays too: annotations, tags, anchored links, doc links and the whole replay.
That is what moving offers over forking, which leaves all of those with the original. The
doc's `/doc/<slug>` starts redirecting to the address ("URLs"). Nothing is copied, so there is
no provenance to record, and a moved doc is not a fork.

**A doc with a post can't be moved, only forked**, by decision: a post of any status, a draft,
an unpublished one and a deleted one included. A post is published from its doc, and a wiki
doc publishes nothing ("Doc rules a wiki page doesn't inherit"), so any post would be
stranded. A scheduled one would go out anyway: its text is captured when it is scheduled, and
going live is only `publishedAt <= now`. A deleted one would come back with its restore. The
move counts them after locking the doc's row, through `prismaIncludingDeleted` or SQL, since
the filtered client's `post.count` leaves deleted posts out. Publishing checks the other side
of the same race under a lock of its own ("Doc rules a wiki page doesn't inherit").

The move dialog asks for where, a name (the title, normalized, by default, edited when the
rules refuse it) and a variant, as the fork dialog does. The variant is empty unless the address
is taken, and then `2`, `3`, …, since there is no parent to name. Then:

- **Into your own namespace**, for a doc you can edit and are on the byline of. The owner is
  always on the byline, and a move adds no one to it, so nobody's text ends up under a name
  that wasn't already on it. That is also why an ADMIN or EDITOR can't move someone else's
  `SHARED` doc into their own namespace, though they may edit it. Its other authors keep
  editing it, and lose raising and deleting it, deliberately; an ADMIN or EDITOR off the byline
  loses the `SHARED` bypass.
- **Into the commons**, for an ADMIN or EDITOR who can edit the doc and is on its byline. The
  move takes from the doc's authors the choice of `PRIVATE` and of publishing it as a post, so
  one of them makes it: an author who wants their doc in the commons adds an ADMIN or EDITOR to
  its byline. A commons page is never `PRIVATE`, so the dialog asks for `SHARED` or `PUBLIC`
  when the doc is `PRIVATE`, and the move sets it.
- **The visibility, the address and the title are one `UPDATE`.** A CHECK is checked on every
  statement, never deferred to the commit, so for a move to `PUBLIC` the address written first
  fails `doc_commons_not_private`, and `PUBLIC` set first fails `doc_public_only_wiki`. The
  title is written there because it is the name from then on.
- **Otherwise its visibility stays as it was.**
- **A move can be undone**, by moving the page back out ("Moving out of the wiki"), so the
  dialog doesn't say it can't.

**Moving is a function in `src/lib/` taking an `Actor`** (`src/lib/wiki-move.ts`), wrapped by a
server action. Main has nothing for it to build on, so it brings its lock with it:

- **`lockDoc`**, in `src/lib/doc-manage.ts`, takes the doc's row `FOR UPDATE` as the first
  statement of a transaction and returns the row with its byline and address columns, and
  **`canEditDocRow`**, in `src/lib/doc-authz.ts`, answers the edit rule for a row already read
  ("Permissions"). The move locks the row, refuses a deleted doc, reads the mover's row afresh
  for a move into their own namespace, checks the byline, counts the posts, claims the address
  and writes, all under that lock. The `wiki` branch read the mover's row before opening the
  transaction, which let a demotion in between go unseen.
- **`setDocByline`, `setDocVisibility` and `setDocDeleted` check their rules under the same
  lock**, so no change to the byline, the visibility or the deletion authorised under the rules
  from before the move lands after it: an EDITOR using the `SHARED` bypass would otherwise add
  themselves to the byline of what has just become someone's page. Main's `setDocByline` locks
  the row but asks `requireEditable` before it, and the other two take no lock; all three are
  changed to lock first and then ask `canEditDocRow`, and `setDocSlug` and `setDocRecord` with
  them ("Permissions").
- **Connections already open keep the access they had until they reconnect**, since the collab
  server checks access when a connection opens.

## The Actions menu

**Main's Actions menu** (`src/components/DocActionsMenu.tsx`, FORKS.md "The doc view: an
Actions menu and the Fork dialog") holds "Publish as blog post" and "Fork…". On a wiki page and
on a doc it becomes:

| Item | On a doc | On a wiki page | Shown to |
|---|---|---|---|
| Publish as blog post | as now | never | an editor of a doc with no post |
| Fork… | the dialog's Where offers "a doc", your namespace, and the commons for ADMIN/EDITOR; "a doc" by default | the same; your namespace by default | any reader with `canManageDocs` |
| Move into the wiki… | for an editor on its byline with no post, a deleted one included | — | |
| Move… | — | to another namespace or out of the wiki ("Moving out of the wiki"), with the rules for each | the page's owner, or for a commons page an ADMIN or EDITOR on its byline |

- **One Fork item with a Where**, rather than main's "Fork…" beside a "Fork into the wiki…",
  since two items with one verb would differ only by a label. With "a doc" chosen, the dialog is
  main's, and calls `forkDoc`; with a namespace, it shows the name, the variant and the default
  address the server would pick, and calls `forkIntoWiki`. A wiki page's Where offers the same
  three, your namespace first ("Forking into the wiki").
- **The version comes from the scrub bar's getter**, as main's dialog reads it
  (`useDocScrubPosition`), not from `?at=`.
- **Each dialog shows the default address the server would pick**, asked of it only while the
  dialog is open: both are mounted whenever their item is offered, and a lookup from a closed
  one would be a server action on every load of the page. The previews answer a deleted or
  unreadable parent as the fork would, before saying anything about the address.
- **"Move into the wiki…" needs a post count of its own**, deleted posts included, since the
  page's list of posts leaves deleted ones out.
- **Choosing `PUBLIC` says so beside the choice**, in every dialog and the Settings panel, as
  the link text a public page carries goes public with it ("Public pages").

## The family line

**Main's family lines are what the `wiki` branch called its banner** (FORKS.md, "A doc's family": `loadDocFamily` in
`src/lib/doc-family.ts`, `DocFamily`, handed to `DocView` as its `family` prop): "Forked
from" with the parent, "Forks" with up to 20 forks, and each entry's diffs, whose history is
asked once for every doc listed through `docsWithVisibleHistoryWhere`. What the wiki adds:

- **Same name:** other wiki pages whose `wiki_name_key` is this page's and that are neither its
  parent nor its forks, the commons' first, at most 20, saying when there are more without
  counting them. It is a third query beside the two `loadDocFamily` makes, through the wiki
  read rule's `where` ("Public pages") with `deletedByUserId: null` spelled out, as theirs are.
  Each entry links to "how they differ", `/diff/<this>/<other>`, for a viewer with
  `canViewDocs`; the other two diffs are a fork's and a parent's and don't apply.
- **A fork renamed leaves "Same name"** and stays among its parent's forks, keeping its "Forked
  from" and its diffs. The family is the fork relation, and "Same name" is for pages that share
  only a name. Forks may be renamed, by decision: rival schools don't always use one another's
  terms.
- **Entries show their titles, a wiki page's being its name, and link at their wiki addresses**
  (`wikiPath`), where main links `/doc/<slug>`. A doc that isn't a wiki page keeps its `/doc/`
  link, so a doc forked into the wiki names its parent as it does now. Same-name entries, and a
  page's variants, read alike, as forks of one doc do on main; labels here are deferred
  ("Labels").
- **A null viewer.** `loadDocFamily` takes a viewer and answers nothing without `canViewDocs`.
  For the public render it takes none: its queries go through `readableWikiDocsWhere`, so a
  signed-out reader sees `PUBLIC` relatives only, and no diff links at all, since every diff
  needs a sign-in ("Diffs"). The "how they differ now" link, which main shows to any reader of
  both docs, is withheld from a viewer without `canViewDocs`, and `docsWithVisibleHistoryWhere`
  isn't asked for one.
- **The wording follows the surface**: "Forked from a page that isn't public" on the public
  render, "Forked from a page you can't read" in the doc view of a wiki page, and main's
  "Forked from a doc you can't read" for a doc. Left out, a `PUBLIC` fork of a `SHARED` page
  would show its parent's text to the world as the forker's alone, since forks have no
  visibility cap, the public render strips the author marks, and a person's page names its
  owner.
- **The diff links keep main's labels**, "(diff: parent vs. fork, parent, fork)", and Same name's
  is "(how they differ)". `DocFamily`'s lead-in becomes a prop, since main writes `" (diff: "`
  into it. They stay plain `<a>`s, for the scrub bar's reason (FORKS.md).
- **It shows in the doc view and the public render alike**, and wherever main shows it now: on
  every doc that has a parent or forks, wiki page or not.

## Diffs

**A diff of wiki pages is main's diff** (FORKS.md, "Diffs"): `/diff/<left>/<right>`, each side
`<doc id>` or `<doc id>@<update id>`, gated and read by `gateDiffPair` and `readDiffPair`
(`src/lib/diff-pair.ts`) for the page and the pair route alike, and compared in the reader's
browser. Sides stay named by doc id, since an address changes on a rename and a doc id doesn't.
What the wiki adds:

- **An unreadable wiki doc is answered as a missing one.** `gateDiffPair` answers a side the
  viewer can't read as Forbidden. For a wiki doc that would confirm a page exists to someone
  holding its id, so the gate reads `wikiName` with the side (`DOC_SELECT`) and answers
  not-found for an unreadable one, before it asks anything about versions, so no log's
  membership leaks either. The pair route then answers 404, from the same function. The rule
  goes in `gateDiffPair` alone, which both callers share (FORKS.md, "Giving the diff page or
  its pair route a check or a read of its own").
- **A side links at its wiki address.** `DiffSideRead` carries a doc's `slug`, from which the
  page and the slider's pair assembly build `/doc/<slug>` links; it carries the side's path
  instead, built once by `readDiffPair` with `wikiPath` for a wiki page. Four places read it:
  `readDiffPair`, `DiffView`'s heading link, and `diff-slider.ts`'s pair validator and
  `assemblePair`.
- **A wiki page's side is headed by its current name**, at whatever version the side is
  ("The name is the title"). Today a side's heading is its title fragment at that version, read
  by `readDiffPair` on the server and by `doc-version.worker.ts` in the browser. For a wiki page
  both take the name from the row the pair route reads, so a diff slid to a version and the same
  pair reloaded agree (FORKS.md, "Turning a Y.Doc into a doc's blocks anywhere but through
  `docBodyOf`", for why the two builds must agree). Two variants of one name get the same
  heading, each linking to its own page; labels here are deferred ("Labels").
- **Diffs stay signed in.** The diff page is `gated()`, the pair route answers 401 signed out,
  and the index and replay routes refuse a reader without the history. A COMMENTER reads a
  `PUBLIC` page through the public render and is refused any diff of it as a missing page, since
  `canUserReadDoc` refuses them and the side is a wiki doc. Diffs for signed-out readers are
  deferred.
- **History is main's interim rule**, `canUserSeeDocHistory` and its exception for a fork point
  (FORKS.md, "Who may see a doc's history"), with the person's-page rule carried into both of
  its forms ("Permissions"), so a family line never offers a diff that comes back Forbidden.

## Renaming

As the slug tables work (`changeDocSlug` and `revertDocSlug` in `src/lib/doc-slug.ts`), but
where this says otherwise:

- **A rename changes the name, the variant, the namespace, or any of them**, and records the
  address the page leaves in `wiki_address_history`: the doc, the owner (null for the commons),
  the name and its key, the variant, who moved the page and when, and whether the row is
  reserved. A rename to another namespace is a move ("Moving out of the wiki", PR 5); within
  one, it is PR 3's.
- **Within a namespace, the row is reserved: it holds the address it records**, as
  `docSlugInUse` counts a slug in history. Creating, forking, moving, restoring and renaming
  refuse the address, and the default variant sequences pass over it, until the row is deleted
  or released. Reserved rows are unique by owner, key and variant, as live addresses are, with
  the commons' in an index of their own. An address can't be both live and reserved; no index
  spans the two tables, so the address lock is what keeps them apart.
- **Leaving a namespace releases what the page held there.** A move to another namespace, or
  out of the wiki, records the address it leaves as released, and releases the page's reserved
  rows in that namespace. A released row holds nothing: no claim, default or "taken" refusal
  counts it, so the namespace can reuse the name at once. The 404's offer and `/wiki/new`'s link
  to a taken address still reveal nothing, since every address held in a namespace is held by a
  page living in it. A released row stays as the page's history, and redirects when nothing else
  answers (below). No row is reserved again: a page coming back to a namespace finds its old
  names as anyone would.
- **An address answers a viewer with the first of these they may read**: the page living there;
  the page whose reserved row holds it, with a 307; the newest page whose released row names it,
  with a 307. A redirect keeps the sub-path (`…/edit`) and the query string, and goes to
  `/doc/<slug>` for a page moved out of the wiki. A viewer who may read none of them gets the
  missing-page answer, so the answer never says whether something they can't read is there. The
  reasons for a 307, and for readers only, are the case redirect's ("Case"): it tells a viewer
  the page exists, and it ends when its row is deleted, or, for a released row, when a page they
  may read takes the address.
- **Who may rename:**

  | | A person's page, `/wiki/@x/…` | A commons page, `/wiki/commons/…` |
  |---|---|---|
  | Rename within the namespace | its byline (`canUserEditDoc`) | its byline, plus ADMIN and EDITOR: the `SHARED` rule |
  | Move to another namespace | `x` alone, into the commons, as an ADMIN or EDITOR | an ADMIN or EDITOR on its byline, into their own namespace |
  | Move out of the wiki | `x` alone | an ADMIN or EDITOR on its byline |

- **A person's page leaves its namespace only by its owner**, as only the owner deletes it, since
  a co-author could otherwise take the owner's rules from `x` by moving the page into their own
  namespace. The owner is read afresh, by `ownerWhoCanAct`, as for deleting.
- **A commons page leaves the commons only by an ADMIN or EDITOR on its byline**, which is what
  putting a doc there takes. A co-author who is neither could otherwise take a page into their
  namespace that they could never put back.
- **No page moves from one person's namespace to another's.** Leaving `@x` is `x`'s alone and
  entering `@y` is `y`'s, since a move adds no one to a byline, and a rename has one actor. `y`
  can fork the page into `@y` instead.
- **A rename into another namespace meets that namespace's rules for moving a doc in**: into
  `@x`'s for `x` on the byline, with a slug not made from their email; into the commons, a
  `PRIVATE` page made `SHARED` or `PUBLIC` in the same `UPDATE`. The new namespace's owner takes
  the owner's rules, and the variant defaults as a move's does.
- **The locks are taken in moving's and restoring's order.** A rename locks the doc's row first
  (`lockDoc`), refuses a deleted page, and reads the address it leaves under that lock. Only then
  does it take the address locks of the name it leaves and the name it takes, in key order. So
  two renames of one page queue on the row, rather than one recording an address the other has
  already moved the page off; no change to the byline or the visibility authorised under the
  rules of the namespace being left lands after the move; and no two writes take the same locks
  in opposite orders.
- **The page's own history is the exception to a reserved row's refusal**: renaming back to an
  address it had takes it and deletes its own rows for it, reserved or released, so a page's
  history never names where it lives. A slug change does the same, once PR 0's fix lands.
- **A rename that changes only case keeps no row**: the fold already finds the page, and the case
  redirect sends the old capitals on.
- **Revert goes back to the most recent reserved row**, the last rename within the namespace, and
  keeps no row for the address it leaves when that went live within the hour
  (`REVERT_DISCARD_WINDOW_MS`), as `revertDocSlug` does. A move between namespaces is undone by
  moving back, under the rules for that.
- **`Doc.title` follows in the rename's transaction** ("The name is the title").
- **The control and the history.** The editor's name renames ("The name is the title").
  `/doc/<slug>/slug`, which shows a wiki page's address beside its frozen `Doc.slug` ("URLs"),
  lists the history, each row saying whether it holds its address or only redirects when nothing
  else answers, and offers Rename, Revert, and deleting a row, which ends its redirect and, for a
  reserved row, frees its address. Its Rename takes the name and the variant, and is where a
  variant changes, for whoever may rename within the namespace: Move… is offered only to whoever
  may take the page out of it. The editor's Settings row links there.
- **One function taking an `Actor`** (`src/lib/wiki-rename.ts`), with the server action as its
  wrapper (CLAUDE.md). MCP gets a tool for it later ("Deferred").
- **Forks stay where they are.** A fork's family line names its parent by the parent's current
  address, and "Same name" follows the rename.
- **The history table's foreign keys say what a hard delete does**: `onDelete: Cascade` on the
  doc, as `doc_slug_history`'s does, and on the owner, since a hard-deleted person's namespace has
  no addresses left to keep; `SetNull` on who moved the page. Prisma's default for an optional
  relation, `SetNull`, would make a hard-deleted person's rows the commons', held there and
  redirecting, the trap `RESTRICT` on `doc.wiki_owner_user_id` avoids for pages. The key column
  is written only by its trigger.

```sql
-- migration 3: Prisma's table and foreign keys, then
-- Hand-written below this line
CREATE TRIGGER wiki_address_history_sync_name_key
  BEFORE INSERT OR UPDATE OF name ON "wiki_address_history" FOR EACH ROW
  EXECUTE FUNCTION wiki_address_history_sync_name_key();
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_name_valid" CHECK (…);
ALTER TABLE "wiki_address_history" ADD CONSTRAINT "wiki_address_history_variant_is_slug" CHECK (…);
CREATE UNIQUE INDEX "wiki_address_history_personal_reserved_key"
  ON "wiki_address_history" ("owner_user_id", "name_key", "variant")
  WHERE "reserved" AND "owner_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "wiki_address_history_commons_reserved_key"
  ON "wiki_address_history" ("name_key", "variant")
  WHERE "reserved" AND "owner_user_id" IS NULL;
CREATE INDEX "wiki_address_history_address_idx"
  ON "wiki_address_history" ("name_key", "variant", "owner_user_id");
CREATE INDEX "wiki_address_history_doc_idx" ON "wiki_address_history" ("doc_id");
```

## Deleting a page

- **Deleting a page deletes its address history with it**, its reserved rows and its released
  ones, in the delete's transaction, so its old addresses stop redirecting and are free. A
  restore brings back the live address, or the next free variant ("Data model"), and not the
  rows. A doc that isn't a wiki page can have rows too: one moved out of the wiki keeps its
  released ones.
- **Before deleting a doc that has any, the UI says so and lists them**: each old address, when
  the page left it, and whether it holds the address or only redirects. The confirmation says
  that they stop redirecting at once, and that restoring the page won't bring them back. It comes
  from the editor's Delete (`DocSettingsPanel`), the wiki table's row Delete and its bulk
  Delete, and `/docs`' for a doc moved out of the wiki. A bulk Delete lists the selected docs
  that have any before it runs; the table kit's bulk action
  (`softDeleteBulkActions`) gains a confirmation for it, since today it runs at once. A doc with
  no history deletes as now, without asking, since Undelete undoes all of it.
- **MCP's `manage` can't ask**, so its answer to a delete lists the addresses it deleted.
- **A deleted wiki doc is edited at `/doc/<id>/edit`.** Deleting a page releases its address, so
  the wiki editor can't show a deleted page: refreshing after Delete would resolve the address
  again, find nothing, and 404, with Undelete gone. So the wiki editor's Delete goes on to
  `/doc/<id>/edit`, which loads a deleted doc on purpose so that its Settings can offer Undelete,
  and redirects only a live doc to its wiki editor. Undelete there goes to wherever the page now
  lives, which `setDocDeleted` returns.

## Moving out of the wiki

**A page can be made a doc again**, which is not a rename, since the page leaves its address
behind. A person's page is moved out by its owner alone, by `ownerWhoCanAct`, and a commons page
by an ADMIN or EDITOR on its byline ("Renaming").

- **Its address is released, with its reserved rows** ("Renaming"), so the names are free at
  once, and an old address sends a viewer who may read the doc to `/doc/<slug>` when nothing else
  answers. `/doc/<slug>` stops redirecting and is its URL again, and its `Doc.slug`, frozen in the
  wiki ("URLs"), can be changed again.
- **Its name is written into the ydoc's title fragment, through the collab server**
  (`/admin/doc-edit`), before the address is cleared, so the doc keeps its title once `Doc.title`
  reads the fragment again ("The name is the title"). The write is an edit, credited to whoever
  moves the page out. **The transaction that clears the address reads the name again under the
  row lock**: when a rename has changed it since the fragment was written, the transaction ends
  with nothing written and the move starts over with the new name, since the next store would
  otherwise copy the stale name into `Doc.title`.
- **The fragment is never written with the transaction open.** `/admin/doc-edit` answers only
  once the store has written the `doc` row (`server/doc-edit.ts` awaits the disconnect, and that
  the store), and that write waits on the row lock: made under `FOR UPDATE`, it would wait on
  its own caller until the transaction timed out, with no deadlock for Postgres to report.
- **A doc with no ydoc row is refused**, saying to open the page first. `/admin/doc-edit`
  answers 404 for one, and there is no fragment to write. Only a doc made by `+ New doc`, moved
  in and never once opened is in that state, which takes calling the functions directly: the
  doc view and the editor each open the document.
- **A `PUBLIC` page is made `SHARED` or `PRIVATE`**, which the dialog asks for, in the same
  `UPDATE` as the address, since `doc_public_only_wiki` refuses `PUBLIC` on a doc.
- **Its forks stay where they are**, as forks of a doc, which a fork can be, and it keeps its own
  "Forked from" and diffs, since the family line is main's and shows on every doc.
- **The owner's rules end**: raising and deleting go back to its byline, and an ADMIN or EDITOR
  regains the `SHARED` bypass. It can be published as a post again.
- **One function taking an `Actor`** (`src/lib/wiki-move.ts`, beside moving in), wrapped by a
  server action, and the menu's "Move…".
- **The commons' `Front Page` moved out stops being the preamble** ("The front page"); the
  dialog says so.

## Where it will live

| Where | What |
|---|---|
| migrations `doc_visibility_public`, `wiki_pages`, `wiki_address_history` | The enum value; the address columns, the key's function and trigger, the title mirror, their CHECKs and indexes; the history table ("Data model", "Renaming") |
| `src/lib/wiki-name.ts` | The name's rules: normalizing and refusing, with messages. Pure and browser-safe, with its unit test |
| `src/lib/wiki-address.ts` | Addresses: parsing and building (`wikiPagePath`), encoding, the fixed redirects, the reserved list, the held commons names, the email-slug test, the default variant sequences. Pure and browser-safe, with its unit test |
| `src/lib/wiki-claim.ts` | The address lock, the folding helper's query, the held-name check, the variants a claim walks past, the claim itself, and `ownerWhoCanAct` |
| `src/lib/wiki-create.ts`, `wiki-fork.ts`, `wiki-move.ts`, `wiki-rename.ts` | Creating, forking into the wiki, moving in and out, renaming: each a function taking an `Actor` |
| `src/app/actions/wiki.ts` | Their server actions, and the dialogs' default-address previews, named apart from main's `forkDoc`, `forkDocAction` and `ForkDocState` |
| `src/lib/doc-visibility.ts` | `isSharedOrPublic`, `sharedOrPublic()`, `allowedVisibilities`, `FILE_VISIBILITIES` |
| `src/lib/doc-authz.ts` | `canEditDocRow`; the carve-out in `editableDocsWhere`; `canReadWikiDoc` and `readableWikiDocsWhere` |
| `src/lib/doc-manage.ts` | `lockDoc`, and the byline, visibility and deletion rules checked under it |
| `src/lib/doc-create.ts`, `doc-fork.ts`, `doc-family.ts`, `diff-pair.ts` | main's, gaining the `wiki` option, a wiki parent's name as its fork's title, "Same name" and a null viewer, and the wiki doc's not-found and address |
| `src/lib/wiki-pages.ts` | The wiki routes' shared resolution of an owner, a page, a name in the wrong case and an old address |
| `src/lib/front-page.ts` | The commons' `Front Page` |
| `src/lib/mcp/url.ts`, `resolve.ts` | A page's address as a doc reference |
| `src/app/wiki/` | `/wiki`, the namespace lists, a page and its editor, the catch-all, `/wiki/new`, the 404 and its offer, and the public render |
| `src/app/doc/[slug]/doc-reading-view.tsx`, `edit/doc-edit-view.tsx` | The doc view and the editor, rendered at a `/doc/` URL and at a wiki address alike |
| `src/components/wiki/` | The move dialog, the address line, the dialogs' shared parts |
| `src/components/DocActionsMenu.tsx`, `ForkDialog.tsx`, `DocFamily.tsx`, `DiffView.tsx`, `DocRefMenu.tsx` | main's, gaining the wiki's items and Where, "Same name", the side's address and name, and the `[[` menu's label |
| `e2e/wiki.spec.ts` | The rules end to end ("Testing") |

## What comes from the `wiki` branch

**Nothing is merged or cherry-picked.** A file below is read with `git show wiki:<path>` and
written on the new branch against today's main, as the column says. Every hunk is rewritten where
names replace slugs.

| On `wiki` | Here |
|---|---|
| `wiki-address.ts` and its test | Kept for the owner segment, the reserved list, the redirect function and the default sequences; rewritten for names: normalizing moves to `wiki-name.ts`, `wikiPagePath` encodes, the name is never lowercased, the reader-only hops are the route's |
| `wiki-claim.ts` | Kept in shape; the lock key folds in SQL, `takenVariants` compares keys and counts reserved rows |
| `wiki-pages.ts` | Kept in shape; lookups by key, the case and old-address 307s |
| `wiki-create.ts` | One field, the name; `claimableNamespace` kept; the fresh read moves inside the transaction |
| `wiki-fork.ts` | Rewritten as `readForkSource`, `forkSeed` and `createDocWithContent`'s `wiki` option |
| `wiki-move.ts` | Kept in shape; the mover's read moves inside the transaction; `title` joins the `UPDATE`; the front page's refusal goes; moving out is added |
| `doc-visibility.ts` | Kept; the sweep redone against main's literals |
| `doc-authz.ts`' hunks | `canEditDocRow`, `canReadWikiDoc` and `readableWikiDocsWhere` as written; the `editableDocsFor` hunk rewritten onto `editableDocsWhere` |
| `doc-manage.ts`' hunks | As written (the file is unchanged on main), but for names in the restore's variant |
| `route-access.ts`' `gatedAnyViewer` | As written (the file is unchanged on main) |
| `src/app/wiki/**` | Kept in shape; names in place of slugs; `public-page.tsx` rewritten on `docJsonForPostSide` |
| `src/components/wiki/MoveDialog`, `WikiAddressLine`, `wiki-dialog-parts` | Kept in shape; the name's validator in place of `isWikiSlug` |
| `src/components/wiki/DocActionsMenu`, `ForkDialog`, `WikiBanner`; `wiki-family.ts` | Dropped: main's menu, dialog and family line are extended |
| `doc-reading-view.tsx`, `doc-edit-view.tsx` | Redone from main's pages ("The doc view at an address") |
| the diff route, `diff-side.ts`, `doc-diff.ts` | Dropped: main's |
| `front-page.ts` | Rewritten ("The front page") |
| `actions/posts.ts`' hunks | Re-applied, with a transaction for `createPostFromDoc` |
| `server/ydoc-store.ts`' row #1 stamp | Not carried ("The `wiki` option") |
| `e2e/wiki.spec.ts`, its worker helpers and fixtures | Ported, test by test ("Testing") |
| `f869e5f`, `f3ebfc6`, `20a6484`, `b1529fe` | PR 0 ("Build order") |
| `b6126e5`, `1425a6a` | Already on main |
| `202e9d0` | With the ported spec: its wait before Back is a hunk of `e2e/wiki.spec.ts`, and its TODO.md entry, "A discarded server action can undo the next navigation", goes in with PR 2 |

## Before the wiki reaches an instance

- **Postgres 18**, which every instance runs, and DEPLOY.md and docs/DATABASE.md then require.
- **`npx prisma migrate deploy`**, as every migration needs; the three wiki migrations ship in
  PRs 1 and 3.
- **The front page, at PR 4's deploy**: an instance whose landing page shows a `FRONT PAGE` doc's
  body moves that doc into the commons as `Front Page`, `PUBLIC`, by an ADMIN or EDITOR on its
  byline, through the menu's Move into the wiki…. A doc with any post can't be moved, so one that
  has one is forked into the commons instead. DEPLOY.md gains the step, with the query that finds
  such a doc.
- **FORKS.md's integrity check** (`check-ydoc-integrity.ts`) has run wherever forks are deployed,
  and a fork into the wiki meets the same gap a fork does, so it needs nothing new.

## Testing

**Unit**:

- `src/lib/wiki-name.test.ts`: each normalizing step and its order (`Cafe` + U+200E + U+0301);
  each refusal with its message: empty, a lone surrogate, U+FFFD, C0 controls, DEL, `# < > [ ] { }
  |`, `%xx`, `&…;` with `&é;`, `.` and `..`, 256 bytes, `/ \ ? ~`, unbalanced parentheses, a
  final `.rsc`; and what is allowed, a bare `%` included.
- `src/lib/wiki-address.test.ts`: `%40` decoded; the reserved words; `name~variant` and the
  variant's grammar; `Mercury (planet)` ↔ `Mercury_(planet)`, the sub-delims left readable;
  `%20`, runs of `_`, `_` at an end, a decomposed accent and a bidi mark each answered with the
  canonical path; uppercase in the owner, the variant and a sub-path lowercased, never in the
  name; a path needing two redirects answered in one; the default sequences; the email-slug test.
- `allowedVisibilities`: each kind of doc, and on a person's page the owner's values, a
  co-author's and an ADMIN's.
- A Markdown round trip of a doc linking to a name with parentheses, both export forms.
- `src/lib/mcp/url.test.ts`: a page's address parsed, with a variant, `/edit`, a fragment, an
  encoded name and an absolute URL; `/wiki` and a namespace list refused.

**e2e**, `e2e/wiki.spec.ts`, most of it calling the `src/lib/` functions as given actors through
the worker. The `wiki` branch's 46 tests map onto it as follows: 4 are covered by main's
`doc-fork.spec.ts` and `doc-diff.spec.ts` for plain docs, 7 partly, the rest are ported with names
in place of slugs, and its Diffs block is replaced by main's, since the route and the worker
changed. Ported:

- **Doc rules**: `/posts/new` neither offers nor accepts a wiki page; the three publish actions
  refuse one; `FRONT PAGE` as a doc's title is not the preamble, and the commons' `Front Page` is
  when `PUBLIC`, by any capitals, and isn't when `SHARED`, a variant or a person's.
- **Settings**: an EDITOR refused on a person's `SHARED` page with no Edit link in the wiki
  table, and allowed on a commons page; an ADMIN lowering a person's `PUBLIC` page from the wiki
  table and refused
  raising, editing or deleting it; a co-author lowering it and adding to the byline, refused
  raising or deleting; an owner demoted or deleted mid-session refused raising, deleting, forking
  or moving in; the owner refused off the byline, through the editor and MCP's `manage`; MCP's
  `edit_doc` refusing a title; `/doc/<slug>/slug` showing the address history with its controls
  and no `Doc.slug` change; a restore into a taken address at `~2`, a reserved row counting as
  taken; an AUTHOR on a commons page's byline refused renaming it `ABOUT` or `Front Page~x` and
  refused restoring a deleted `About`, an EDITOR allowed each, and `/wiki/@x/About` allowed its
  owner.
- **Addresses**: a page at its address; the `common`, uppercase and canonical-spelling 308s for
  everyone; the case and old-address 307s for readers only, keeping the sub-path and the query,
  and one hop for `/wiki/COMMONS/NAME`; the old user slug 307; `/doc/<id|slug|old slug>` 307s
  keeping `?sel=` and `?at=`, and `/edit` to the wiki editor; a non-reader's 404 at `/doc/`,
  `/edit`, `/slug`, side-by-side, `/diff/` and `/api/diff/`, and the link preview's null; the
  sign-in redirect alike for a missing page, a non-public one, a wrong-case name and an old
  address; empty, unknown and deleted owners' namespaces alike; the editor's Forbidden and 404;
  the editor's Delete landing on `/doc/<id>/edit` with Undelete; a client-side `<Link>` between two
  pages and Back, with names holding spaces, parentheses and non-ASCII; `/annotations`' card
  link; a name with a bare `%` opened, its tab title included; the return path after sign-in
  spelled as `wikiPagePath` spells it; `/doc/a%00b` signed out answered without a 500.
- **Public pages**: each visibility read by a `canViewDocs` reader, a COMMENTER and a signed-out
  viewer, with author marks stripped and a mention and a citation rendered; a COMMENTER refused the
  collab token, replay, the index and diffs; `/wiki` and a namespace list signed out showing
  `PUBLIC` pages only; `/doc/<slug>` sending signed-out viewers and COMMENTERs to a `PUBLIC` page
  only.
- **Creating**: `/wiki/new` with one field, refusing each kind of bad name with its message, and
  a taken address (by key, `ΐ` against `Ϊ́` included, and by a reserved row, not a released
  one) with a link; a nameless
  account refused its namespace and allowed the commons as an EDITOR; the 404's offer to the owner
  and to an EDITOR in the commons, with the name encoded.
- **Forking**: `PUBLIC` allowed into the wiki and refused for a doc; a wiki page forked as a
  doc, titled with its current name after a rename and publishable; an unreadable wiki parent
  not found; the variant defaulting to a `PUBLIC`
  parent's owner slug, else `2`, skipping reserved rows; a typed taken variant refused; two claims
  of `Apple` and `apple` at once at the first two free addresses; a fork to its parent's own
  name racing the parent's rename, neither ended as a deadlock; a demoted session refused.
- **Moving in**: annotations and tags kept and `/doc/<slug>` redirecting; a `PRIVATE` doc made
  `SHARED` or `PUBLIC` by its move into the commons; a doc with any post refused; an EDITOR off
  the byline refused the commons and allowed once on it; a `FRONT PAGE` doc moved in becoming the
  preamble.
- **The menu and dialogs**: each item to whoever may, a doc with only a deleted post included;
  the Fork dialog's Where, your namespace first on a wiki page; each dialog's default address and
  its landing; a title with `?` or `/` edited before the claim.
- **Listing**: the wiki table's rows, sorts and filters, its row and bulk actions to whoever may,
  and `/docs` listing no wiki page; search's "Wiki pages" section, empty signed out, and MCP's
  search unchanged.
- **MCP**: `read`, `add_note` and `tag` given a page's address, in other capitals and by an old
  address; an unreadable page `not_found`, as a missing one is.
- **The `[[` menu**: a wiki page's option showing its label, and the link it inserts carrying the
  name and pointing at `/doc/<slug>`.
- **The family line**: Same name by key, its entries linking at their addresses; "Forked from a
  page that isn't public" signed out.
- **The address line and the `PUBLIC` notice**, following Settings.
- **Renaming**: a rename's reserved row refusing every claim and passing out of the default
  sequences; renaming back consuming the page's own rows; a case-only rename keeping none; the
  who-may-rename table; two renames of one page queueing; Revert, and the hour; a row deleted
  ending its redirect and freeing its address; `Doc.title`, the search vector, the heading, the
  tab, side-by-side and the diff's headings following.
- **Deleting**: the confirmation from the editor and the wiki table's row and bulk Delete, listing
  the addresses, none without history, the rows not restored; MCP `manage`'s answer listing them.
- **Moving between namespaces and out**: the who-may table; person to person refused; released
  rows freeing the name at once and redirecting only when nothing else answers; the answer order;
  the name written into the title fragment through `/admin/doc-edit`, and read again under the lock
  when a rename raced; a `PUBLIC` page lowered on the way out; `Doc.slug` changeable again; forks
  keeping "Forked from"; the doc publishable again.
- **PR 0**: each fix's own test, as on the `wiki` branch: `annotation-readonly.spec.ts` with
  `applyTestAnnotationMark`, `sign-in-callback.spec.ts`'s permalink through an old slug,
  `ydoc-debug.spec.ts` rewritten for the inspector, `doc-edit.test.ts` and
  `markdown-comment.test.ts` for code blocks; and the slug fix taking back an own old slug on
  docs, posts, users and files, with `changeUserSlug`'s mention refresh still scheduled.

**The worker and fixtures**: main has `openDocActions`, `docActionsMenu`, `docActionItems`,
`forkDocAs` (which gains a `wiki` option), `softDeleteTestDoc`, `addTestDocAuthor`,
`setTestUserRole` and `softDeleteTestUser`. The `wiki` branch's `createTestWikiPage`,
`createWikiPageAs`, `moveDocAs`, `getTestWikiFacts`, `findTestWikiPageId` (by key),
`changeTestDocSetting`, `renameTestUserSlug`, `softDeleteTestPost`, `countPostsForDoc`,
`frontPagePreambleText` and `addTestDocSlugHistory` are ported, with `createTestUser({ name: null
})`. **`deleteTestUser` deletes a user's pages before the user**, for the `RESTRICT`, and the
commons pages on a throwaway byline go with their authors, as the `wiki` branch's did.

**Before each UI commit**, the specs it touches run with `npm run e2e:dev -- <spec>`; the full
suite runs before each PR.

## Build order

**Six PRs, one at a time**, each branched from main once the last has merged, and each passing
`npm run check` and the specs it touches, with the full suite before it goes up. The first is
not the wiki's; the other five are its, in an order in which each deployed state makes sense.

0. **Five fixes the wiki leans on, none of them about the wiki. Built 2026-11-18.** Four were
   built on the `wiki` branch, and their code is taken from it, by hand where a bullet says
   main has moved under it; their doc hunks are applied by hand, since the docs they edit have
   moved (FORKS.md's build order ported `b6126e5` and `1425a6a` the same way). The fifth was
   found in review, and is built here.
   - **A code block keeps its lines when MCP writes it** (`f869e5f`): `edit_doc`'s Markdown
     and a note body through `add_note`/`edit_note` collapse every soft line break to a space,
     code blocks included, so a fenced block arrives as one line (`src/lib/doc-edit.ts`,
     `src/lib/markdown-import.ts`).
   - **An annotation's mark is written only for someone who may edit the doc** (`f3ebfc6`):
     `applyAnnotationMark` asks `canUserEditDoc` where it mints the writable token, and answers
     a refusal as `applied: false`, with the empty `chips` main's return has gained since.
     TODO.md's "Posting an annotation trusts two things the client sends" keeps the rest. On a
     person's page, which no ADMIN may edit, this is what keeps a hand-made `postAnnotation`
     from writing into it. **Removing a mark stays as it is**: `removeAnnotationMark` mints its
     token for whoever may delete the annotation, its writer or an ADMIN, and takes from the doc
     only that annotation's own mark, never text.
   - **`/ydoc-debug` is an inspector** (`20a6484`): no editing mode, no token route, no New
     document, so no ADMIN tool types into a doc the ADMIN can't edit. Reading any ydoc stays.
     `YdocDebug.tsx` has changed on main since, so this one is applied by hand.
   - **Sign-in finishes with a full page load when the destination has a fragment**
     (`b1529fe`), so a card's permalink that passes through sign-in and then a redirect still
     lands on the card. A wiki doc's `/doc/<slug>` redirect would otherwise drop the fragment of
     every annotation link into it. `sign-in-form.tsx` has gained its retry loop on main since,
     so the one line is changed by hand.
   - **A slug change can take back the entity's own old slug.** `changeDocSlug`,
     `changePostSlug`, `changeUserSlug` and `changeFileSlug` refuse a slug in the entity's own
     history as "already in use", while "Use this url" on `/doc/…/slug`, `/post/…/slug` and
     `/users/…/slug`, and `/files/…/manage`, offers it, since `unique*Slug` passes over the
     entity's own rows. Each accepts it and consumes its row, as Revert does, and as
     `changeTagSlug` does already. A rename back to an old address does the same ("Renaming").
1. **Names and data. Built 2026-11-18.** `PUBLIC`, in a migration of its own
   (`doc_visibility_public`); the `wiki_pages` migration; `src/lib/wiki-name.ts` and
   `src/lib/wiki-address.ts`, with their unit tests, and the Markdown round trip
   (`wiki-markdown.test.ts`); the folding helper, `foldWikiName`, which is all of
   `src/lib/wiki-claim.ts` so far; the title mirror; `doc-visibility.ts` and every visibility
   comparison through it; `allowedVisibilities`, which the Settings panel and `/docs`' cell and
   bulk action offer (`BulkToolbar`'s `allows`), and `/files`' `FILE_VISIBILITIES`;
   `canEditDocRow` and the carve-out in `editableDocsWhere`; `lockDoc`, under which all five of
   `doc-manage.ts`'s functions ask `canEditDocRow` and `setDocVisibility` asks
   `allowedVisibilities` (`setDocSlug` through `changeDocSlugIn`, in the lock's transaction);
   the doc rules a wiki page doesn't inherit (publishing refused), and `forkDoc` titling a wiki
   parent's fork with its name; the integrity check's title rule; the scripts that refuse
   `PUBLIC`; `getFrontPagePreamble` passing over wiki pages (`wikiName: null`) until PR 4
   replaces its rule, since the title mirror makes every page named `Front Page` a doc titled
   so, a `PRIVATE` one in a person's namespace included. Also here, being the title mirror's:
   MCP's `edit_doc` refusing a title for a wiki page, and the Claude-chat importer's matching
   passing over wiki pages ("The name is the title"). No route, and nothing in the UI offers
   `PUBLIC`, since no doc can hold it yet; `e2e/wiki.spec.ts` makes its pages by writing a
   test doc's address columns (`createTestWikiPage`). **Left for PR 2**, which brings
   `ownerWhoCanAct` and the claims they need: the rules on a person's page beyond
   `canEditDocRow` (the owner kept on the byline, raising, deleting and restoring the owner's
   alone, an ADMIN's lowering, the visibility actions gating on the session alone, and the
   wiki table's `canSetVisibility` and `canDelete` with `softDeleteBulkActions`' `canToggle`),
   and a restore's next free variant.
2. **Pages.** `gatedAnyViewer`; the wiki read rule; `/wiki`, the namespace lists, a page and its
   editor, the catch-all, the fixed redirects and the case 307; `/doc/<slug>`'s redirect and the
   lookups that answer an unreadable wiki doc as a missing one; the public render; a person's
   page's rules and `ownerWhoCanAct`; `/wiki/new` and the 404's offer; the doc view and editor
   split, with the address line and the `PUBLIC` notice; the name shown for the title, read-only
   until renaming lands; the menu's Fork… on a wiki page forking as a doc, as main's does, until
   PR 4 gives the dialog its Where; the held commons names, checked in the claim; the MCP tools
   taking a page's address; TODO.md's entry for the uncached public render; the wiki table at
   `/wiki/special/pages`, with `/docs` listing no wiki page; search's "Wiki pages" section; the
   `[[` menu's label. Both listings land with the pages, since from then on `/docs` and the docs
   search leave wiki pages out.
3. **Renaming within a namespace.** `wiki_address_history`; `wiki-rename.ts`; reserved rows
   counted by every claim; the old-address 307s; Revert; the editor's name as the rename
   control; the history on `/doc/<slug>/slug`; a deleted page's rows deleted with it, after the
   confirmation that lists them; the header's links to `/wiki` and the wiki table.
4. **Into the wiki.** Forking into the wiki and moving a doc in, on main's `readForkSource`,
   `forkSeed` and `createDocWithContent`; the Fork dialog's Where and "Move into the wiki…";
   the family line on the public render, for a null viewer and in its wording, which no page
   needs sooner, since none has a parent or a fork until now; "Same name"; diff sides linked at
   their addresses and headed by name; the front page, with its deploy step ("The front page").
5. **Moving between namespaces and out of the wiki.** Released rows; the title fragment written
   through the collab server; the menu's Move… and its dialog.

**Each PR deploys once it merges**, so after PR 2 an instance has pages whose names can't
change until PR 3. Nothing links to `/wiki` until PR 3 has merged: no header link, no landing
page entry. A page created in between, by someone who typed the URL, is renamed after.

**Why renaming comes before forking and moving in**: every claim counts reserved rows, so
building the claims after the history table means writing each once.

**Why the front page waits for PR 4**: an instance's `FRONT PAGE` doc becomes the commons'
`Front Page` by being moved in, which PR 4 builds. Shipped earlier, the switch would take every
instance's preamble down until then. Main's rule stays until then, hole and all ("The front
page"), by decision: a narrower one in PR 0 would be written to be deleted.

## Open

- **How the diff page shows a fork against its parent**, FORKS.md's open choice, applies to
  wiki forks unchanged.

## Deferred

- **Groups.** They come with group-level permissions, replacing the arrangement in which every
  EDITOR is in effect in one group. Unprefixed segments are held for them, so no URL changes
  when they arrive; the commons then becomes a group row, by a data migration from its null
  owner.
- **Links between wiki pages** (`[[x]]`). The earlier design's late binding carries over with an
  owner in place of an embedding: the page's own namespace first, then the commons.
- **The held routes**: `/wiki/all/<name>`, `recent`, `search`, `random`, `me`, `help`.
- **Diffs and history for signed-out readers**, and annotations and tags on the public render.
- **Public PDFs, files and anchored links**, which a public page's links to `/pdf/`, `/files/`
  and `/link/` would then reach signed out.
- **Quoting a `PUBLIC` page in a public post's comments.**
- **`PUBLIC` for docs that aren't wiki pages.**
- **The rest of MCP's wiki**: creating a page, renaming, moving, making a page `PUBLIC` through
  `manage`, and giving back a page's address where the tools give `/doc/<slug>` ("URLs").
- **A cache for the public render** ("Public pages").
- **Pulling a parent's later changes into a fork**, as FORKS.md defers it.
- **A bot's namespace**, or a bot's writing into its person's, when the MCP tools can make a
  page ("Permissions").
- **Doc links as entity chips**, whose text would follow a rename ("Labels").
- **Labels beyond the `[[` menu**: in the family line, the diff page's headings, the link
  control's search, search hits, the mentions-of and cited-by lists, tag pages and the MCP reads
  ("Labels"), and a doc's byline and date beside its title in the lists that show a title alone.
- **Searching `PUBLIC` pages signed out** ("Listing wiki pages").

## Decisions

Carried over from the `wiki` branch, where its docs/WIKI.md gives the reasoning at length:

- **A wiki page is a doc**, not a row in a table of its own, so annotations, tags, anchored
  links, side-by-side, doc links, entity chips, search and the MCP tools come with it.
- **People carry `@`**, rather than groups a `g-` prefix, and **`commons`, not `common`**, with
  the singular redirecting.
- **The variant is in the path**, and is called a variant.
- **Commons pages keep the `SHARED` rule**, with ADMIN and EDITOR creating them, and are never
  `PRIVATE`.
- **A person's page is its byline's alone**: no ADMIN/EDITOR bypass, the owner always on the
  byline, raising and deleting the owner's alone, judged by a fresh read of the owner's row; an
  ADMIN may lower it, and nothing more. Co-authors may add to its byline.
- **A person's namespace needs a slug not made from their email.**
- **`PUBLIC` is a third value of `DocVisibility`**, behaving as `SHARED` everywhere outside the
  wiki's routes, whose read rule stays outside `canUserReadDoc`.
- **The public render shows no byline.**
- **An address is claimed under an advisory lock**, and a collision takes the next variant.
- **A doc with a post can't be moved into the wiki, only forked**, whatever the post's status.
- **`/doc/<slug>` redirects only a viewer who may read the page, by the wiki read rule**, with a
  307; a wiki doc's `Doc.slug` is frozen.
- **A namespace with nothing the viewer may read answers as an unknown owner does.**
- **No visibility cap on forks**, and a fork whose parent the reader can't read still says it
  is one: main's rules (FORKS.md), unchanged.

From the titles amendment (2026-10-22, reviewed 2026-10-23):

- **A name is a title**, by MediaWiki's rules less `/ \ ? ~` and with balanced parentheses, and
  `Doc.title` mirrors it.
- **Names compare without case**, by a key Postgres 18 folds, and Postgres 18 is required.
- **Old addresses are kept as history rows, reserved within a namespace and released when the
  page leaves it.** No page moves from one person's namespace to another's.
- **The labels are `@person/Title~variant`**, and for now only the `[[` menu's options show them
  (2026-11-17).
- **Deleting a page with history asks first**, listing what stops redirecting.
- **The wiki is rebuilt rather than migrated from slugs**, being unmerged and undeployed.

Made on 2026-11-17:

- **Built fresh on main**, with the `wiki` branch as a reference, rather than merged, rebased or
  replayed: main's forks and diffs replace the branch's own, and the branch's changes to the doc
  page would have to be redone by hand in any of the three.
- **`?` and `/` are refused in names.**
- **`PUBLIC` comes now**, without waiting for the permissions redesign.
- **The landing page's preamble is the commons' `Front Page`, when it is `PUBLIC`**, and nothing
  otherwise; a doc's title no longer decides it.
- **Wiki pages have their own admin table**, `/wiki/special/pages`, and `/docs` lists none;
  search gives them a section of their own.

Made while checking the plan against main, 2026-11-17:

- **`Doc.title` mirrors the name by a trigger**, not by a raw `UPDATE` in the cache write ("The
  name is the title").
- **The menu has one Fork item with a Where** ("The Actions menu").
- **A bot has no namespace** ("Permissions").
- **An unreadable wiki doc is not found by id too**: in the diff gate and in forking.
- **The person's-page rule is carried into `editableDocsWhere`**, so main's history filter and
  its per-row check keep agreeing ("Permissions").
- **Renaming comes before forking and moving in**, and the front page with moving in ("Build
  order").

Made on 2026-11-18, after the plan's review:

- **A wiki page forks as a doc too** ("Forking into the wiki"): no refusal keeps a page's text
  out of a doc or a post.
- **Some commons names are an ADMIN's or EDITOR's to claim**: `Front Page` and `About`
  ("Permissions").
- **The MCP tools take a page's address** from PR 2, and nothing more of the wiki yet ("URLs").
- **The public render is uncached**, with a TODO.md entry ("Public pages").
- **Main's front-page rule stays as it is until PR 4** ("Build order").
- **The name's key is the NFC form of the fold** ("Case").
- **A name can't end in `.rsc`** ("What a name may hold").
