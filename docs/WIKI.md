# Wiki pages — docs whose permissions come from an embedding

**Status: planned, first cut; nothing is built.** A **wiki page** is a doc in every respect
[DOCS.md](DOCS.md) describes, except that it belongs to an embedding
([EMBEDDING.md](EMBEDDING.md)), which decides who reads and writes it and what the page is
called. This file records only what differs from those two files or doesn't appear in them.
Where it is silent, a wiki page behaves as a doc does: the ydoc stack, `gc: true`, eager
creation, the `title` and `prose_json` caches, the title following the fragment live, the
reading view with its scrub bar, `?at=` and freezing, and the editor.

## Ownership and names

**Exactly one embedding owns a wiki page**, through an `embedding_member` row with `is_owner =
true`: the whole page, unpinned, because an owned page is held live. A partial unique index
keeps it to one (EMBEDDING.md, "Data model"). Other embeddings can include the same page, whole
or as passages, with `is_owner = false`, pinned like any other member.

**A wiki page has no name of its own; each embedding names it.** The name is
`embedding_member.slug`, unique within its embedding. So every embedding is its own
namespace, and two embeddings can each have an `institution` page that are different pages.
An embedding that includes another's page can give it a name too, under which the page is
reachable in that embedding (below).

**A wiki page is created inside an embedding**, from "New page" on `/embedding/[slug]` or from
a new-page link ("New pages"). One transaction writes the `wiki_page` row, its `ydoc` row and
the owning member with its name, the same eager creation docs use.

**Deleting an owned page soft-deletes its `wiki_page` row.** Members of it in other
embeddings then go dark, omitted like any target the viewer can't read. The owning member is
never removed alone, because that would leave the page with no owner.

## The commons

**The commons is an ordinary embedding with the reserved slug `commons`.** It has its own
`embedding` row, its own owners and its own visibility, and permissions work exactly as for
any other embedding. What sets it apart is URLs and link resolution only:

- its names are the short URLs, `/wiki/[name]`;
- it is the fallback when a page's own embedding has no page by a name ("Links between
  pages").

**It is created by a seed script**, like `scripts/seed-front-page.ts`, with its first owner
named on the command line. The slug validator refuses `commons` for any other embedding. The
commons can't be renamed or deleted, because every `/wiki/*` URL depends on it.

## Data model

```sql
CREATE TABLE wiki_page (
  id                     text PRIMARY KEY,                                  -- cuid
  title                  text NOT NULL DEFAULT '',                          -- cache of the "title" fragment
  prose_json             jsonb,                                             -- cache of the "default" fragment
  prose_json_update_id   bigint,                                            -- which ydoc_update the cache is
  forked_from_page_id    text REFERENCES wiki_page(id) ON DELETE SET NULL,  -- set on a fork-on-write copy
  forked_from_update_id  bigint,                                            -- the revision it was copied at
  created_by_id          text NOT NULL REFERENCES "user"(id),
  created_at             timestamp(3) NOT NULL DEFAULT now(),
  updated_at             timestamp(3) NOT NULL,
  updated_by_user_id     text REFERENCES "user"(id),
  deleted_by_user_id     text REFERENCES "user"(id),
  deleted_at             timestamp(3),
  CHECK (forked_from_page_id IS NULL OR forked_from_update_id IS NOT NULL)
);
```

**The table is `wiki_page` because a row is one page;** "wiki" names the whole section. The
URLs and the ydoc namespace keep `wiki` for that reason, the way PDFs are `ydoc:pdf:` but
`ydocIdForFile` and `/api/file`.

Compared with `doc`, it has:

- **no `slug` and no slug history.** Its names are its members' slugs, and renames aren't
  built.
- **no `visibility` and no `wiki_page_author`.** The owning embedding supplies both rules.
- **no `prose_json_length`.** That column exists to sort `/docs`, and there is no `/wikis`
  yet.
- **`created_by_id`,** because with no byline table it is the only record of who started
  the page.
- **fork provenance.**

`src/lib/prisma.ts`'s soft-delete extension gets a `wikiPage` entry beside `doc`'s.

## Permissions

| | Who |
|---|---|
| Read a wiki page | anyone who can read its owning embedding |
| Write a wiki page | the owning embedding's owners |
| Fork a wiki page | an owner of the embedding the copy goes into ("Fork on write") |
| Create a wiki page | an owner of the embedding it goes into |

**A wiki page's read and write rules are its owning embedding's, and nothing else's.**
Another embedding including it grants no reader anything: a `SHARED` embedding that includes a
page owned by a `PRIVATE` one shows that member only to readers of the owner. There is no
ADMIN/EDITOR bypass, following the `PRIVATE`-doc rule, and a role never substitutes for
ownership the way `canEditAnySharedDoc` substitutes for a byline. The commons is no exception.

## URLs

| Route | What it is |
|---|---|
| `/wiki/[name]` | the commons' page by that name; an id is tried first, as `resolveDocParam` does |
| `/wiki/[name]/edit` | its editor, for the commons' owners |
| `/wiki/[name]/all` | every version of that name the viewer can read |
| `/wiki/[name]/new` | the offer to create a page by that name |
| `/embedding/[e]/wiki/[name]` | E's page by that name: one E owns, or one it includes, shown as pinned |
| `/embedding/[e]/wiki/[name]/edit` | the editor, for E's owners; on an included page, "Edit a copy here" instead |
| `/embedding/[e]/wiki/[name]/new` | the offer to create it in E |
| `POST /api/wiki-page/[id]/token` | the collab token |
| `GET /api/wiki-page/[id]/replay` | the update log the scrub bar replays |

**Every URL means one thing, permanently.** `/wiki/x` is always the commons' `x`, and
`/embedding/e/wiki/x` is always e's. A URL's shape never depends on who is looking, so no
URL can reveal that a private page exists.

The alternative considered was a short URL for whichever page held a name while nothing else
did. It was rejected because a URL's meaning would change as names collided, and because
short-or-long would have had to be computed per viewer to avoid revealing private pages.

The cost of this shape is that the commons is privileged: it has the short URLs, and every
embedding's links fall back to it. That is Wikipedia's "primary topic", and the earlier
research's warning about a privileged default applies (Wikinfo's default article ended up
with the rivals as its satellites). The note on commons pages, below, is the mitigation.

**No context in query strings.** Links carry no `?in=` or anything like it, so a link means
the same to everyone who follows it. The query strings that remain say *what* is pointed at:
`?at=` (a revision someone chose to share) and `?sel=` (an anchored link).

### Requests and responses

| Request | Response |
|---|---|
| `/wiki/x`, the commons has an `x` the viewer can read | 200 |
| `/wiki/x`, it doesn't | 307 to `/wiki/x/all`: temporary, because the commons may create `x` later |
| `/wiki/x/all`, one or more readable versions | 200, even for one |
| `/wiki/x/all`, none | 404, with the new-page offer in the body |
| `/embedding/E/wiki/x`, E owns `x` | 200 |
| `/embedding/E/wiki/x`, E includes a page as `x` | 200, that page at the revision E pinned |
| `/embedding/E/wiki/x`, E has no `x`, or the viewer can't read E | 404; if the viewer owns E, with the offer to create it in E |
| `/embedding/commons/wiki/x` | 308 to `/wiki/x`: permanent, because that mapping never changes |
| any of these, signed out | the sign-in redirect, through `signInPath` (`npm run check:sign-in`) |

**An included page has an address in the embedding that includes it.**
`/embedding/E/wiki/x` shows F's page at the revision E pinned, labeled "From F, as pinned on
<date> · current version", where the last part links to F's address for it. E's version of a
page it includes *is* the pinned one. The page's links still resolve in F, because the text
shown is F's.

### Links between pages

**Links bind late.** A wiki-link mark in the ydoc stores `{ name }`, or `{ embedding, name }`
when qualified. A `[[…]]` input rule writes it: `[[institution]]`, or
`[[austrian:institution]]` for a qualified link, and the colon is safe because slugs can't
contain one. The renderer resolves each link as the page renders and writes the result into
the `href`, so following a link almost never redirects.

**A bare `[[x]]` on a page owned by E resolves in this order**, among the pages the viewer can
read:

1. E's own names, meaning pages E owns and pages it includes under a name. The link goes to
   `/embedding/E/wiki/x`, or `/wiki/x` when E is the commons.
2. The commons' `x`, at `/wiki/x`.
3. Any other embedding's `x`, even if there is only one, at `/wiki/x/all`. Crossing into a
   third embedding is a visible step, never an automatic one.
4. Nothing: a new-page link, styled as one, to `/wiki/x/new`. It never links to a 404.

**A qualified `[[F:x]]` is early binding.** It goes to `/embedding/F/wiki/x`, or to
`/embedding/F/wiki/x/new` when F has no `x`. It means F's page specifically, and a fork
elsewhere leaves it alone.

**A page's links resolve in its own embedding, never the reader's.** They are part of its
text, and its text belongs to its owner. Resolving them in the reader's context would
translate one embedding's page into another's terms.

**Forking needs no re-pointing.** When E forks a page it includes, the member is updated in
place and keeps its name, so every `[[x]]` in E's pages follows the copy on the next render.

**Wiki links in docs and posts are deferred.** When they come, a post's links will be
resolved at publish and stored resolved, because a post is an immutable snapshot.

### The note on commons pages

Every commons page starts with "Also in: Austrian, Veblenian · all versions". It lists:

- the other embeddings with a page of the same name;
- forks of this page under any name, found through `forked_from_page_id`.

The list is filtered by permission, with no count of what is hidden, and "all versions" links
to `/wiki/x/all`. The note is left out when there is nothing to list. Without it, rival
versions couldn't be found from `/wiki/x`, which always shows the commons.

### The versions page, `/wiki/x/all`

**It is named for what it lists: versions.** The entries are usually rival treatments of one
subject, not unrelated things that happen to share a name, so it isn't called
"disambiguation".

**It lists every page named `x` that the viewer can read**, and shows them even when there is
only one:

1. the commons' page first, if there is one;
2. then the embedding of the page the reader came from (by Referer, below);
3. then the embeddings the viewer owns;
4. then the rest.

Each entry shows its embedding, its title, when it was last edited, and what it was forked
from.

### New pages

A new-page link, or a 404 that carries the offer, asks where to create `x`:

- **If the link names an embedding** (`[[F:x]]`, or `/embedding/F/wiki/x/new`): offer to
  create `x` in F, if the viewer owns F. Otherwise say that F has no `x`.
- **Otherwise, if the Referer names a page in an embedding E that the viewer owns**, and E
  isn't the commons: offer a choice between E and the commons. The commons is offered only if
  the viewer owns it.
- **Otherwise:** ask explicitly whether to create `x` in the commons.
- **In both "otherwise" cases,** a search box finds another embedding the viewer owns, to
  create `x` there instead.

If the viewer owns nowhere it could go, the page says so and offers nothing. Creating writes
the `wiki_page` row, its `ydoc` row and the owning member named `x`, then redirects to the
editor.

### Context without query strings

**The Referer supplies context, and only ever as a hint.** No `Referrer-Policy` is configured
in `next.config`, the root layout or `deploy/nginx-app.conf.sample`, so browsers apply their
default, `strict-origin-when-cross-origin`. A navigation within the site therefore sends the
full URL of the page the link was on. A path under `/embedding/[e]/` names E, and one under
`/wiki/` names the commons.

The Referer is used for three things only, each with a default when it is missing:

- the new-page offer;
- the "Fork into…" offer;
- the order of `/wiki/x/all`.

It never decides what a URL shows. It is also client-controlled, so the embedding it names is
used only if the viewer may read it (for ordering) or owns it (for offers). Otherwise it is
ignored, so a crafted header can't confirm that a private embedding exists.

## Fork on write

**An embedding gets its own copy of a page it doesn't own the moment one of its owners writes
it.** There are two ways in.

**"Edit a copy here", on `/embedding/E/wiki/x` for a page E includes.** The server action
does five things in one transaction:

1. builds the page's state at the member's pinned revision with `materializeYdocAt`;
2. creates a new `wiki_page` row with `forked_from_page_id` and `forked_from_update_id` set;
3. creates its `ydoc` row seeded with that state, which gives it a new lineage (YDOC.md,
   "The database is keyed by lineage"), so no browser's IndexedDB copy of the original can
   merge into it;
4. updates the member in place: `wiki_page_id` becomes the copy, `is_owner` becomes true,
   `ydoc_update_id` becomes null, and the name stays;
5. redirects to `/embedding/E/wiki/x/edit`.

**"Fork into…", from a page the target embedding doesn't hold.** The target is chosen by the
rules in "New pages": the embedding a qualified link names, or else the Referer's embedding
and the commons, or else the commons, with the same search box. Then one of three things
happens:

- **The target already includes this page, under any name.** That member forks in place and
  keeps its name.
- **The target has no page by this name.** The page is first included under its name and
  then forked in place ("forking includes").
- **The target has a different page by this name.** The forker must choose another name
  first, so names stay unique within an embedding.

**Three decisions apply to both:**

- **It forks when an owner chooses to write, not on the first keystroke.** An editor is bound
  to one ydoc, and switching documents mid-edit would mean replaying the local keystrokes onto
  a new document.
- **It copies the pinned revision, not the latest.** That is what the embedding actually
  holds. An owner who wants the latest re-pins first. A page included by "Fork into…" is
  pinned at the current revision, so there the two are the same.
- **The copy keeps the original's attribution.** The seeded state carries the `clients` map,
  so text the fork inherited still shows who wrote it.

**This is what makes forking a whole embedding cheap.** The fork includes its parent's pages
unowned and pinned, under the same names (EMBEDDING.md, "Forking an embedding"). Only the
pages its owners actually write are ever copied.

## The ydoc and the collab server

- **`ydoc:wiki:<id>`, a third sub-namespace** beside `ydoc:annotation:` and `ydoc:pdf:`.
  `ydocIdForWikiPage` and `wikiPageIdFromYdocId` go in `src/lib/ydoc-names.ts`, and
  `docIdFromYdocId` must exclude the new prefix, for the reason its comment gives for the
  other two. CLAUDE.md's "two sub-namespaces" line needs updating when this lands.
- **The cache writer is `server/wiki-page-cache.ts`,** beside `doc-cache.ts` and
  `annotation-cache.ts`, at the end of the store debounce, with the same `docContentFromYdoc`
  derivation.
- **`POST /api/wiki-page/[id]/token`** mints a writable token for an owner of the owning
  embedding, and `readOnly` for anyone who can only read it. `ydocOnAuthenticate` needs no
  wiki knowledge, because the token names the document.

The doc surfaces (`DocView`, `DocReadingBody`, `DocScrubBar`, `DocEditor`) are written
against docs and their API routes, so they either take the kind of entity as a parameter or
get thin wiki wrappers. Deciding which is the first implementation task.

## What a wiki page doesn't have yet

- **Annotations, tags, anchored links, comment quotes, publishing a post from a wiki page,
  `/side-by-side` and doc links.** Each of the anchor-based ones needs a `wiki_page_id` leg on
  its anchor table: one column, one index and one CHECK edit per table (CLAUDE.md's "a new
  targetable kind is a migration"). `embedding_member` is the only anchor table that has the
  leg from the start.
- **An admin table.**
- **Renames.** Changing a page's name or an embedding's slug changes its URLs, and there are
  no history tables to redirect the old ones.

## Open questions

- **Who owns the commons:** site editors, every `canViewDocs` user (an open, Wikipedia-style
  commons), or a list?
- **Can ownership be transferred**, and what happens to a page whose owning embedding is
  deleted while others still include it?
- **Who may create wiki pages?** Creating an embedding needs only `canViewDocs`, which includes
  AUTHORIZED, but creating a doc needs `canManageDocs`, which is AUTHOR and up. As planned,
  an AUTHORIZED user could write wiki pages without being allowed to write docs.
- **To verify once built:** that a `<Link>` navigation on Next 16 delivers the Referer to
  `headers()`, and that a reload resends it.
