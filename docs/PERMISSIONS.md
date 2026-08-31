# MultiBlog — Permissions

Who may do what, as tables. Derived by reading the gates rather than by testing them, so
treat this as a map of the code and not as the code: **the authoritative rules live in
`src/lib/role-checks.ts` and `src/lib/doc-authz.ts`**, plus each page's and action's own
check. The "Where each rule lives" section at the end lists every file consulted, so any
row here can be re-derived rather than trusted.

Assumes PLAN.md §12e's two-doc-gates distinction (`canViewDocs` governs reading and
annotating a `SHARED` doc; `canManageDocs` governs `/docs` management) and the per-doc
`visibility` rule stated there — a `PRIVATE` doc readable and editable by its listed
`DocAuthor`s alone, with no ADMIN/EDITOR bypass. §12f covers the two admin listings and the
ADMIN-only "Show all docs" override. `/site-settings` is deliberately out of scope.

**`PRIVATE`/`SHARED` is `Doc.visibility`.** Posts have no visibility column at all, so the
four tables below are about docs and the surfaces derived from them. Post permissions vary
along neither axis and live in their own table at the end rather than being repeated four
times.

## Roles and the predicates built on them

Five roles, in descending privilege: `ADMIN`, `EDITOR`, `AUTHOR`, `AUTHORIZED`, `COMMENTER`.
Every gate in the app is one of these predicates, sometimes combined with a
`DocAuthor`/`PostAuthor` membership test:

| Predicate | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER | Defined in |
|---|---|---|---|---|---|---|
| `isAdmin` | ✅ | ❌ | ❌ | ❌ | ❌ | `role-checks.ts` |
| `canEditAnyPost` | ✅ | ✅ | ❌ | ❌ | ❌ | `role-checks.ts` |
| `canEditAnySharedDoc` | ✅ | ✅ | ❌ | ❌ | ❌ | `doc-authz.ts` |
| `canManagePosts` | ✅ | ✅ | ✅ | ❌ | ❌ | `role-checks.ts` |
| `canManageDocs` | ✅ | ✅ | ✅ | ❌ | ❌ | `role-checks.ts` |
| `canViewDocs` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `canViewFiles` | ✅ | ✅ | ✅ | ✅ | ❌ | `role-checks.ts` |
| `canManageFiles` | ✅ | ✅ | ✅ | ❌ | ❌ | `role-checks.ts` |
| `canManageAnySharedFile` | ✅ | ✅ | ❌ | ❌ | ❌ | `file-authz.ts` |
| `canApplyTags` | ✅ | ✅ | ✅ | ✅ | ❌ | `role-checks.ts` |
| `canCurateTags` | ✅ | ✅ | ❌ | ❌ | ❌ | `role-checks.ts` |

Two pairs here hold the same roles as each other and are still kept apart on purpose, so
that the doc rule and the post rule can move independently rather than one silently dragging
the other:

- `canManageDocs` / `canManagePosts` — same three roles. `DOC_MANAGER_ROLES`' comment
  explains only why `AUTHORIZED` is excluded (it grants reading and annotating docs, not
  managing them); whether the two sets are *meant* to be able to diverge isn't stated.
- `canEditAnySharedDoc` / `canEditAnyPost` — same two roles, and deliberately not defined in
  terms of each other. `canEditAnySharedDoc` is the doc-side rule (who edits a `SHARED` doc
  with no byline on it); `canEditAnyPost` stays with posts, where its name is accurate. A
  delegation between them would have preserved exactly the coupling the split exists to
  break.

`canEditAnySharedDoc` is the one predicate not in `role-checks.ts`, which is deliberate:
what earns a place in that file is a **client** consumer, not a subject. `canViewDocs` and
`canManageDocs` are doc predicates living there because `SiteHeader` needs them in the
browser; nothing client-side asks who may edit a `SHARED` doc without a byline, and both
halves of that rule (`canUserEditDoc`'s SHARED branch and `editableDocsFor`'s carve-out) are
in `doc-authz.ts`, so it sits with them.

**Legend for every table below.** ✅ allowed · ❌ denied · `—` the page itself is denied by
its `canManageDocs` gate, so the row can never arise · `own` only rows that user authored ·
⚠️ only with the ADMIN-only "Show all docs" checkbox (`?showAllDocs=1`) · † the action is
doc-independent, so it is callable directly but unreachable through the UI.

## 1. PRIVATE & in `doc_author`

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER |
|---|---|---|---|---|---|
| Read `/doc/[slug]` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Edit `/doc/[slug]/edit` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Collab connection | write | write | write | ✗ | ✗ |
| Replay history | ✅ | ✅ | ✅ | ❌ | ❌ |
| Visibility / byline / slug / delete | ✅ | ✅ | ✅ | ❌ | ❌ |
| Listed in `/docs` | ✅ | ✅ | ✅ | — | — |
| Edit link in `/docs` | ✅ | ✅ | ✅ | — | — |
| Annotate | ✅ | ✅ | ✅ | ❌ | ❌ |
| Open annotation ydoc | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete/restore **any** annotation | ✅ | own | own | own | own |
| Listed in `/annotations` | ✅ | ✅ | ✅ | — | — |
| Create doc link | ✅ | ✅ | ✅ | ❌ | ❌ |
| Side-by-side | ✅ | ✅ | ✅ | ❌ | ❌ |

## 2. PRIVATE & not in `doc_author`

The table the whole rule exists to produce: a `PRIVATE` doc is invisible to everyone but its
byline, role notwithstanding.

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER |
|---|---|---|---|---|---|
| Read `/doc/[slug]` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Edit `/doc/[slug]/edit` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Collab connection | ✗ | ✗ | ✗ | ✗ | ✗ |
| Replay history | ❌ | ❌ | ❌ | ❌ | ❌ |
| Visibility / byline / slug / delete | ❌ | ❌ | ❌ | ❌ | ❌ |
| Listed in `/docs` | ⚠️ | ❌ | ❌ | — | — |
| Edit link in `/docs` | ❌ | ❌ | ❌ | — | — |
| Annotate | ❌ | ❌ | ❌ | ❌ | ❌ |
| Open annotation ydoc | ❌ | ❌ | ❌ | ❌ | ❌ |
| Delete/restore **any** annotation | ✅† | own | own | own | own |
| Listed in `/annotations` | ❌ | ❌ | ❌ | — | — |
| Create doc link | ❌ | ❌ | ❌ | ❌ | ❌ |
| Side-by-side | ❌ | ❌ | ❌ | ❌ | ❌ |

## 3. SHARED & in `doc_author`

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER |
|---|---|---|---|---|---|
| Read `/doc/[slug]` | ✅ | ✅ | ✅ | ✅ | ❌ |
| Edit `/doc/[slug]/edit` | ✅ | ✅ | ✅ | ❌ | ❌ |
| Collab connection | write | write | write | read-only | ✗ |
| Replay history | ✅ | ✅ | ✅ | ❌ | ❌ |
| Visibility / byline / slug / delete | ✅ | ✅ | ✅ | ❌ | ❌ |
| Listed in `/docs` | ✅ | ✅ | ✅ | — | — |
| Edit link in `/docs` | ✅ | ✅ | ✅ | — | — |
| Annotate | ✅ | ✅ | ✅ | ✅ | ❌ |
| Open annotation ydoc | ✅ | ✅ | ✅ | ✅ | ❌ |
| Delete/restore **any** annotation | ✅ | own | own | own | own |
| Listed in `/annotations` | ✅ | ✅ | ✅ | — | — |
| Create doc link | ✅ | ✅ | ✅ | ✅ | ❌ |
| Side-by-side | ✅ | ✅ | ✅ | ✅ | ❌ |

## 4. SHARED & not in `doc_author`

The only table where a role, rather than a byline, decides editing — see "Two known
inconsistencies" below, both of which are visible here.

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER |
|---|---|---|---|---|---|
| Read `/doc/[slug]` | ✅ | ✅ | ✅ | ✅ | ❌ |
| Edit `/doc/[slug]/edit` | ✅ | ✅ | **❌** | ❌ | ❌ |
| Collab connection | write | write | **read-only** | read-only | ✗ |
| Replay history | ✅ | ✅ | ❌ | ❌ | ❌ |
| Visibility / byline / slug / delete | ✅ | ✅ | ❌ | ❌ | ❌ |
| Listed in `/docs` | ✅ | ✅ | **❌** | — | — |
| Edit link in `/docs` | ✅ | ✅ | ❌ | — | — |
| Annotate | ✅ | ✅ | ✅ | ✅ | ❌ |
| Open annotation ydoc | ✅ | ✅ | ✅ | ✅ | ❌ |
| Delete/restore **any** annotation | ✅ | own | own | own | own |
| Listed in `/annotations` | ✅ | ✅ | **✅** | — | — |
| Create doc link | ✅ | ✅ | ✅ | ✅ | ❌ |
| Side-by-side | ✅ | ✅ | ✅ | ✅ | ❌ |

## Axis-independent — neither visibility nor byline applies

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER | signed out |
|---|---|---|---|---|---|---|
| Create a doc | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `/posts`, `/comments` (page) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `/posts` + `/comments` rows | all | all | own | — | — | — |
| Edit post / post history | ✅ | ✅ | own | ❌ | ❌ | ❌ |
| `/users`, `/users/[id]/slug` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/ydoc-debug`, `/api/ydoc/*` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/dashboard` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Read a published post, submit a comment | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Two of these are worth not mistaking for doc rules. **Creating a doc** is `canManageDocs`
with no doc to scope against yet, so it sits outside all four tables. **Deleting or
restoring an annotation** is `requireOwnOrAdmin` (`src/app/actions/annotations.ts`) — ADMIN
or the annotation's own author — and never consults the doc, which is why that row reads
identically in all four tables and why an ADMIN retains it even where the doc is otherwise
invisible to them (the † in table 2).

## Two known inconsistencies

Both are live decisions rather than bugs, recorded so the tables aren't mistaken for a
coherent design they don't quite have.

**`/docs` and `/annotations` scope on different rules.** In table 4, an AUTHOR on a `SHARED`
doc they don't author is absent from `/docs` but present in `/annotations`. `/docs` scopes on
`canEditAnySharedDoc` (roughly "who may manage this"), `/annotations` on `canUserReadDoc`
(roughly "who may see this doc's content") — the latter because `/annotations` selects
`doc.proseJson` and renders an excerpt as its Quote column, making it a content boundary.
Each rule is defensible alone; together they are arbitrary, and aligning them means choosing
one for both.

**`canEditAnySharedDoc` is what makes table 4's edit rows differ from table 2's.** The three
bolded ADMIN/EDITOR cells are the only places a role, rather than a byline, still decides doc
editing. If the rule became "editing a doc always requires a byline; visibility governs
reading only", table 4's edit rows would collapse onto table 2's, `canUserEditDoc` would
reduce to a plain `DocAuthor` lookup with no visibility read, and this predicate would be
deleted outright rather than merely renamed. Not decided.

## Files (PLAN.md §19)

**An uploaded file carries docs' visibility model, with its own predicates.** `StoredFile`
reuses the `DocVisibility` enum — PRIVATE/SHARED already means one thing site-wide, and a
third word would be a UI regression — but `canViewFiles`/`canManageFiles`/`canManageAnySharedFile`
are stated independently of their doc counterparts rather than delegating to them. Same role
sets today; the separation exists so the two can diverge without one silently dragging the
other, which is the reasoning `canManageDocs` vs. `canManagePosts` already records.

**A file's listed users are its owners, not its authors.** The join table is `file_owner`
(`FileOwner`), not `file_author`, and `/files`' column is Owner(s) — nobody listed on an
uploaded PDF wrote it. The list is seeded with whoever uploaded the file and is editable
afterwards, and what it grants is control plus read access to a PRIVATE file. Everywhere
below, read "in `file_owner`" for the doc tables' "in `doc_author`"; `doc_author` and
`post_author` keep their name because a doc's or post's listed users really did write it.

The four tables above therefore apply to files as written, with these substitutions and one
structural difference:

| Doc rule | File equivalent |
|---|---|
| Read `/doc/[slug]` | Read `/pdf/[slug]`, and fetch its bytes from `/api/files/…` |
| Edit `/doc/[slug]/edit` | **No equivalent** — a file has no editable content |
| Visibility / owners / slug / delete | `canUserManageFile` (`src/app/actions/files.ts`) |
| Listed in `/docs` (+ ADMIN "Show all docs") | Listed in `/files` (+ ADMIN "Show all files") |
| Annotate | Annotate — same `Annotation` row, same DRAFT privacy, same `requireOwnOrAdmin` |
| Collab connection | Presence only, and **always read-only** (`/api/file/[id]/token`) |

Two consequences worth stating plainly, because they are what the user-facing rule asked for:

- **An AUTHOR sees only their own files**, PRIVATE *and* SHARED, because
  `canManageAnySharedFile` is ADMIN/EDITOR — exactly as `/docs` behaves.
- **The bytes route answers 404, not 403**, to someone who may not read a PRIVATE file.
  Whether such a file exists is itself something its non-owners shouldn't learn, and unlike
  `/pdf/[slug]` (which shows a visible Forbidden, matching `/doc/[slug]`) that route is
  reachable by guessing an id.

`/annotations` lists annotations on **both** containers, each scoped by its own read rule.
That it can see PDF annotations at all is one of the reasons they are Postgres rows rather
than entries in a per-file ydoc (PLAN.md §19).

## Tags (PLAN.md §20)

**A term is vocabulary; an assignment is one person's act of tagging.** The two have
different owners and therefore different rules, and conflating them is the mistake this
section exists to prevent — a term belongs to the site, an assignment belongs to whoever made
it.

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER | signed out |
|---|---|---|---|---|---|---|
| See a chip on something you can already read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/tag/[slug]` (the page itself) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create a term | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Apply a term to an object you may read | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remove **your own** tag | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remove **anyone's** tag | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Rename a term / change its URL | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Delete or restore a term | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `/tags` (the admin table) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

**Chips are as private as the thing they are on, structurally.** `TagChips` is rendered
from inside a page that has already run its own gate — `canUserReadDoc`, `canUserReadFile`,
`publishedPostWhere` — and takes a resolved target rather than a slug, so there is no way to
mount it on a surface that hasn't gated first. It deliberately runs no second check of its
own: a second gate is a second thing that can disagree with the first.

**One surface reaches the chips by a different path, and it is gated differently.** The doc
editor's Settings panel (`/doc/[slug]/edit`) renders `TagStrip` directly, fed by
`loadTaggerState` rather than by `TagChips`' server-side read — so its chips are gated by
`canUserTagTarget`, the *tag* rule, on top of the edit gate the page itself already ran. That
is stricter than the read rule above, never looser: `canUserTagTarget` is "you may tag what
you may read, plus a role floor", so anything it returns was readable anyway. Worth knowing
because the paragraph above is about `TagChips`, and this surface does not go through it.

**`/tag/[slug]` is three queries, not one UNION.** Each per-type section wears the
predicate that already governs its own type, so the PRIVATE-doc rule in tables 1–4 holds
there unchanged, ADMIN and EDITOR included. An interleaved timeline would mean
re-implementing three permission models in one query — the easiest leak to write and the
hardest to see, since a wrong answer looks exactly like a right one. The counts each section
shows come from those filtered queries and **never** from the `tag_metrics` view, which
counts everything live and has no viewer.

**Tagging requires a signed-in AUTHORIZED account on every surface — including posts.** §20d
frames the rule as "applying a tag follows the permission to annotate that surface", and read
literally that would open post-tagging to COMMENTER and to signed-out visitors, since
commenting on a published post is open to both. That is not what it means. A tag is
curatorial where a comment is conversational: it changes what a term denotes and what
`/tag/[slug]` lists, for everyone. So all three surfaces take the same role floor, and
`canUserTagTarget` ANDs it with the object's own read gate. **Recorded as a judgment call**,
not a reading — §20d's wording admits the looser interpretation and this deliberately
declines it.

**Who may mint a term is PLAN.md §20j-1, and this is the answer.** Creating a term is the
same permission as applying one, so AUTHORIZED users grow the vocabulary. The alternative —
AUTHORIZED users apply only existing terms, AUTHOR+ mint new ones — trades friction for
curation and is a one-line change in `role-checks.ts` plus a branch in `createTag`. Worth
making the moment the vocabulary shows drift rather than growth; not worth pre-empting.

**`/tags` sets the same bar as every other admin table** (`canManageDocs`, AUTHOR and up)
rather than matching `canApplyTags`. An AUTHORIZED user who may create and apply terms
still cannot open the table — they reach the vocabulary through the tagger's picker and
through `/tag/[slug]`. Inventing a seventh visibility tier for one listing would be a UI
regression before it was a security improvement.

**A term carries no visibility of its own.** The tagger's picker offers every live term to
anyone who may tag anything, unfiltered — knowing that "Epistemology" exists reveals nothing
about what has been tagged with it. Everything that *would* reveal something is behind the
per-type sections above.

**Deleting a term is a soft delete that keeps its assignments.** Every reader filters on the
term's own `deleted_at`, so a deleted term draws no chips and answers no `/tag/[slug]`,
while the record of who applied it to what survives for a restore to bring back. Deleting the
*object* instead cascades its anchors away outright — an anchor pointing at a deleted doc is
unreachable, not merely stale.

## Anchored links (docs/ANCHORED_LINKS.md)

**A link is one person's act of pointing, and pointing claims nothing about the target.**
That is what separates its rules from tags: a tag is curatorial (it changes what a term
denotes, for everyone) and takes a role floor; a link is a pointer that only its recipients
ever see, so its create rule is the annotate precedent — signed in, plus the target's own
read gate, and nothing else.

| Permission | ADMIN | EDITOR | AUTHOR | AUTHORIZED | COMMENTER | signed out |
|---|---|---|---|---|---|---|
| Add a passage you may read to your draft | ✅ | ✅ | ✅ | ✅ | ❌* | ❌ |
| See / edit / mint / discard **your own** draft | ✅ | ✅ | ✅ | ✅ | ❌* | ❌ |
| See **someone else's** unminted draft | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Follow a minted link (per readable target) | ✅ | ✅ | ✅ | ✅ | ❌* | ❌ |

\* By inheritance, not by a link rule: `addAnchoredLinkPart` has **no role floor of its
own** — the target's read predicate is the whole gate — but both reading routes gate on
`canViewDocs`/`canViewFiles` (AUTHORIZED+), so a COMMENTER can reach no surface that
creates or follows a link today. If those floors ever move, links move with them for free;
that is the design, not an accident.

**Following is a per-target read filter with silent omission — a recorded deviation from
§20i's conjunctive default.** §20i pre-declared that a cross-container reference is
"visible only if every target is"; anchored links deliberately decline that.
`anchoredLinkForViewer` rebuilds each target from the arc and wears its existing predicate
(`canUserReadDoc`, `canUserReadFile` — so a PRIVATE doc keeps its no-admin-bypass by
inheritance), and a group whose target is unreadable, deleted, or of a kind the writer
never produces is omitted with **no acknowledgment**: no placeholder, no count. The
rationale (docs/ANCHORED_LINKS.md, "Following a link"): §14c's conjunctive precedent
protects a surface that *jointly renders* two documents, while a link's groups are
independent pointers like `/tag/[slug]`'s three sections — and silent omission leaks
nothing, since "references something I can't see" and "references nothing else" are
indistinguishable. `?sel=` grants nothing: a link naming a PRIVATE doc still meets that
doc's own Forbidden page.

**An unminted draft is its creator's alone** — `anchoredLinkForViewer` returns null for
anyone else, whatever their role, and every mutation (`add`/`remove`/`discard`/`mint`)
scopes to `createdById` server-side. One open draft per user is DB-enforced
(`anchored_link_one_draft_per_user`, a partial unique index), so there is no draft-picker
surface to gate.

**The banner and tray add no second check.** `AnchoredLinkBanner` renders only what the
server's filtered view handed it, from inside a page whose gate already ran — `TagChips`'
stance. The tray shows only `loadMyDraftLink()`'s answer, which is creator-scoped by the
query itself.

## Where each rule lives

Re-derive from these rather than trusting the tables after an authz change:

| Rule | File |
|---|---|
| The role predicates (all but `canEditAnySharedDoc`) | `src/lib/role-checks.ts` |
| Read / edit a doc; the two `where`-clause equivalents | `src/lib/doc-authz.ts` |
| Read / manage a file; its `where`-clause equivalent | `src/lib/file-authz.ts` |
| `/files` row scoping + the "Show all files" override | `src/app/files/page.tsx` |
| File mutations (visibility, title, slug, delete) | `src/app/actions/files.ts` |
| Who owns a file (`file_owner`, the doc tables' `doc_author`) | `prisma/schema.prisma`'s `FileOwner` |
| File bytes: who may download | `src/app/api/files/[id]/[hash]/route.ts` |
| File presence token (always read-only) | `src/app/api/file/[id]/token/route.ts` |
| Annotation ydoc access (DRAFT is owner-only, even from ADMIN; asks whichever container the annotation has) | `src/lib/annotation-authz.ts` |
| `/docs` row scoping + the "Show all docs" override | `src/app/docs/page.tsx` |
| `/annotations` row scoping | `src/app/annotations/page.tsx` |
| `/doc/[slug]` read gate · `/doc/[slug]/edit` edit gate | `src/app/doc/[slug]/page.tsx`, `…/edit/page.tsx` |
| Collab token: writable vs read-only vs refused | `src/app/api/doc/[id]/token/route.ts` |
| Doc mutations (visibility, byline, slug, delete) | `src/app/actions/docs.ts` |
| Annotation create / delete / restore | `src/app/actions/annotations.ts` |
| Doc links | `src/app/actions/doc-links.ts` |
| Tag role floors (`canApplyTags`, `canCurateTags`) | `src/lib/role-checks.ts` |
| Who may tag which object; who may retract an assignment | `src/lib/tag-authz.ts` |
| Tag mutations (create, tag, untag, rename, slug, delete) | `src/app/actions/tags.ts` |
| `/tag/[slug]`'s three per-type predicates | `src/lib/tag-browse.ts` |
| `/tags` row scoping (there is none) + the curate gate | `src/app/tags/page.tsx` |
| Anchored-link follow filter (per-target, silent omission) | `src/lib/anchored-link-data.ts` |
| Anchored-link create/draft/mint (read-the-target, creator-scoped) | `src/app/actions/anchored-links.ts` |
| Post editing and history | `src/lib/authz.ts`, `src/app/posts/**` |
| Admin-only surfaces | `src/app/users/**`, `src/app/ydoc-debug/**`, `src/app/api/ydoc/**` |

`e2e/tags.spec.ts` pins the tag table's load-bearing rows — the signed-out reader
seeing a public post's chip but no tagger, and the EDITOR who cannot see a PRIVATE doc under
a term they can otherwise browse.

`e2e/anchored-links.spec.ts`'s second test pins the link rules' load-bearing row — the
reader who may see only the PDF half of a PRIVATE-doc+shared-PDF link gets that page's
banner and regions with nothing acknowledging the doc group, while the doc's own URL still
forbids the page.

`e2e/doc-visibility.spec.ts` pins these tables' load-bearing rows — the PRIVATE denials for
ADMIN and EDITOR, the byline author's access, the `SHARED` carve-out, the `/docs` override's
scope, and `/annotations`' content boundary.
