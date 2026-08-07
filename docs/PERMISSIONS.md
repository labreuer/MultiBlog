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

## Where each rule lives

Re-derive from these rather than trusting the tables after an authz change:

| Rule | File |
|---|---|
| The role predicates (all but `canEditAnySharedDoc`) | `src/lib/role-checks.ts` |
| Read / edit a doc; the two `where`-clause equivalents | `src/lib/doc-authz.ts` |
| Annotation ydoc access (DRAFT is owner-only, even from ADMIN) | `src/lib/annotation-authz.ts` |
| `/docs` row scoping + the "Show all docs" override | `src/app/docs/page.tsx` |
| `/annotations` row scoping | `src/app/annotations/page.tsx` |
| `/doc/[slug]` read gate · `/doc/[slug]/edit` edit gate | `src/app/doc/[slug]/page.tsx`, `…/edit/page.tsx` |
| Collab token: writable vs read-only vs refused | `src/app/api/doc/[id]/token/route.ts` |
| Doc mutations (visibility, byline, slug, delete) | `src/app/actions/docs.ts` |
| Annotation create / delete / restore | `src/app/actions/annotations.ts` |
| Doc links | `src/app/actions/doc-links.ts` |
| Post editing and history | `src/lib/authz.ts`, `src/app/posts/**` |
| Admin-only surfaces | `src/app/users/**`, `src/app/ydoc-debug/**`, `src/app/api/ydoc/**` |

`e2e/doc-visibility.spec.ts` pins these tables' load-bearing rows — the PRIVATE denials for
ADMIN and EDITOR, the byline author's access, the `SHARED` carve-out, the `/docs` override's
scope, and `/annotations`' content boundary.
