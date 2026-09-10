# Anchored links — a URL for a set of passages across docs and PDFs

**Status: built** (2026-08-31; editing a minted link since 2026-09-08; names since
2026-09-09). This file began as the implementation plan and is rewritten as-built per the
house convention — "Deviations from the plan" below records where the build differs from
what was designed; the plan text itself lives in this file's git history (first commit of
the `anchored-links` branch). UI sketch, drawn in `globals.css`'s own tokens:
[docs/Anchored_Links.html](Anchored_Links.html) — its "immutable in v1" note predates
editing.

## What an anchored link is

An **anchored link** is a hyperlink that refers to one or more text selections of a doc
and/or a PDF — "these two paragraphs of doc X plus this passage on page 2 of PDF Y" as a
single shareable URL. The load-bearing decisions:

1. **DB-backed**: a link is a database object, and the URL carries its id — `/link/<cuid>`,
   the landing route ("The landing route" below), which forwards onto the reading routes
   as `?sel=<cuid>`. No separate token column, no stateless self-describing blob. Shipped
   without the route (the minted href was part 0's own page, and "a redirect route stays a
   cheap later addition"); it exists since 2026-09-07 because where a link should land
   turned out to be a per-*viewer* question, not a mint-time one.
2. **Cross-surface**: one link may gather selections across several docs/PDFs. Creation
   happens from the reading views `/doc/[slug]` and `/pdf/[slug]` via a draft-link tray
   that persists across navigation; the minted href routes each recipient onto one of
   those two routes with a `?sel=` param, or renders the passages itself when there is no
   one page to send them to.
3. **No inline doc marks** — docs use the offsets+version-stamp mechanism (PLAN.md §13o
   reading-view style), PDFs the quads blob. Nothing writes into any ydoc.
4. **Per-target visibility** ("Following a link" below): the banner shows on `?sel=` pages
   even when the viewer cannot read every referenced object — unreadable targets are
   simply omitted, silently.

Architecturally this is a **consumer family on the §20a/§20b anchor envelope** —
`AnchoredLink` ≈ `TagAssignment`, one act owning 1..n anchor rows ordered by `part_order`
— and the **first writer of `selector`/`selector_kind` on main**. Two shaping decisions
govern everything else:

- **Each "Add to link" posts its part to the server immediately**, captured and verified
  against its own `atVersion` stamp at that instant. There is no client-side part bank, so
  the part-anchors branch's §20l constraint ("multi-part capture leans on the freeze" —
  which cannot hold across pages) never applies; each anchor row carries its own
  `ydocUpdateId`, and the server row *is* the tray's cross-page persistence.
- **Both links a page can be showing are painted**: the one being *followed* (`?sel=`,
  delivered as initial server props) and the one that is *open* (the viewer's own draft,
  or a minted link they have reopened to edit — fetched client-side). They share the
  highlight and differ in the underline — solid vs. dashed; "Painting a draft" below. The
  draft started tray-only, as text; the reason it isn't is that adding a part to a
  passage you are looking at and seeing nothing happen to it reads as a failure.

Origins: `b5fa049` was cherry-picked clean from the `part-anchors` branch (the
one-writer-per-anchor-field refactor: `deriveDocRangeSelector`, `captureAnchorInYdoc`
returning the selector, `capturePdfTextAnchor`); `docs/research/multi-anchoring.md` came
over verbatim. The highlight-extension and anno-layer generalizations were **re-expressed
from that branch's commits as templates** (`kind: "link"` where it says `"tag"`), not
picked — its `annotation_anchor` migration/backfill was deliberately not depended on, and
`resolveCaptureStamp` is duplicated into the actions file until that branch lands.

## Schema

Two models after the tag block in `prisma/schema.prisma`, migration
`20260831200826_add_anchored_links`:

- **`anchored_link`** — id (cuid, the URL id), `created_by_id`, `created_at`,
  `minted_at` (null = the creator's open draft), `reopened_at` (a minted link back in its
  creator's tray — "Editing a minted link" below; migration
  `20260908210830_reopen_anchored_links`), `edited_at` (when a minted link's parts or name
  last changed; null until its first edit), `name` (optional, creator-given — "Naming a
  link" below; migration `20260910012608_name_anchored_links`), soft-delete pair. Like
  `TagAssignment`, deliberately outside `prisma.ts`'s soft-delete `$extends` (read
  through anchor includes, which the extension cannot reach); `deletedAt` filters by hand.
- **`anchored_link_anchor`** — the §20b row shape verbatim under `link_id`
  (`onDelete: Cascade`): the four-FK object arc, `selector_kind`/`anchor_from`/
  `anchor_to`/`quoted_text`/`selector`, the `ydoc_update_id`/`anchored_event_id` stamps,
  `part_order`. Hard-delete only — an anchor is a part of a record, not a record.

Hand-appended DDL (the `add_tags` convention — Prisma has no CHECK or partial-index DSL):

- `anchored_link_anchor_one_target_check` — `num_nonnulls(doc_id, post_id, file_id,
  target_annotation_id) = 1`.
- `anchored_link_anchor_selector_columns_check` — the group-wide null-together equality.
  Unlike `tag_anchor`, every row this table's writer produces has the group non-null: a
  selector-less anchored-link anchor would be a link to a whole object, which is what an
  ordinary href already is.
- **`anchored_link_one_open_per_user`** — a partial unique index on `(created_by_id)
  WHERE (minted_at IS NULL OR reopened_at IS NOT NULL) AND deleted_at IS NULL`: one link
  in the tray per creator, a draft or a reopened minted one. This is what makes
  `loadMyOpenLink` a definite article and the get-or-create race a catchable P2002;
  minting and Done both free the slot, which is the whole lifecycle. It replaced
  `anchored_link_one_draft_per_user`, whose predicate was the draft half of this one.
- **`anchored_link_reopened_only_when_minted_check`** — `reopened_at IS NULL OR minted_at
  IS NOT NULL`. A draft is open by being unminted and never carries the column, so "open"
  stays one predicate rather than two columns that could disagree.
  `scripts/integrity/check-tag-constraints.ts` probes all four, in both directions for the
  index (a second open draft must be refused, and so must a reopened link beside a draft; a
  second link for a user whose first is *minted* must go in, and so must a reopened link
  once the slot is free — the WHERE clause is the feature).
- **`anchored_link_name_not_blank_check`** — `name IS NULL OR btrim(name) <> ''`. A name
  is null or a name, never a blank: the writer already stores whitespace-only input as
  null (`normalizeLinkName`), and this keeps any other writer honest, so every reader's
  `?? "Linked passages"` is the whole fallback. Probed both ways beside the four above.

The v1 writer produces only `doc_id`+`DOC_RANGE` and `file_id`+`PDF_TEXT` rows;
`post_id`/`target_annotation_id`/`anchored_event_id` ship inert on `tag_anchor`'s
one-column-now reasoning.

## Read path — `src/lib/anchored-link-data.ts`

`anchoredLinkForViewer(linkId, viewer)` is the follow path's one read (server-only, the
`tag-browse.ts` of this feature): load the link (`deletedAt` null; an unminted draft is
visible to its creator alone), anchors ordered `[partOrder, id]` — removals leave gaps and
nothing renumbers — every jsonb `selector` through `parseSelector`, never a cast. Each
distinct target is rebuilt via `targetFromColumns` and gated by its own existing read
predicate (`canUserReadDoc` / `canUserReadFile`; the doc/file lookups ride the soft-delete
`$extends`, so a deleted target simply comes back null). Groups keep the order their first
part appears in; hrefs carry `?sel=` — **doc by id** (docs have no slug history;
rename-proof beats pretty), file by slug. No group surviving returns null and callers
behave as if `?sel=` were absent. The view carries `canEdit` (this viewer is the creator
and the link is minted), the Edit affordance's gate, decided here beside the filter so the
banner renders what it is handed. The returned view is BigInt-free by design (stamps
omitted): it crosses into client props on both surfaces.

`anchoredLinkLandingFor(linkId, viewer)` is the landing route's read on top of it: the
same existence rule (deleted, and someone else's draft, read as absent) answered
*separately* from the per-target filter, so the route can tell "no such link" (404) from
"a link none of whose passages you may read" (a page), plus the creator's name and mint
date the excerpt page shows. The two share one rule by restating it, not by widening
`anchoredLinkForViewer`'s null — both reading pages still treat that null as "`?sel=`
absent".

## Following a link — the visibility rule

**Per-target filtering, not a conjunctive gate.** The banner ("Linked passages") renders
on a `?sel=` page whenever the link resolves at all for this viewer; each target group
shows only if the viewer may read that target, and an unreadable group is omitted with
**no acknowledgment that it exists** — no "N hidden passages", no placeholder row.

This deviates from §20i's pre-declared conjunctive default ("visible only if every target
is"), deliberately, and docs/PERMISSIONS.md records it. §14c's precedent (side-by-side
forbids the whole page if either doc is unreadable) protects a surface that *jointly
renders* two documents; an anchored link's groups are independent pointers, each wearing
its own target's existing read predicate, like `/tag/[slug]`'s three per-type queries.
Silent omission leaks nothing: the viewer cannot distinguish "this link references
something I can't see" from "this link references nothing else." The page's own passages
are readable by construction — the route gate already ran before the banner renders, and
`?sel=` grants nothing (a link naming a PRIVATE doc still meets that doc's own Forbidden).

Consequences, all covered by `e2e/anchored-links.spec.ts`'s second test: a viewer who can
read only the PDF target of a doc+PDF link still gets the PDF page's banner, outline
regions and jump, with no "Also referenced" row naming the doc; the mint-time tray copy
says what's true ("Recipients see only the passages they have permission to read"). On
the landing route the same filter decides the *page*: one readable group redirects into
it, several render as excerpts, none renders a page that acknowledges the link — the
viewer holds its id already — and nothing about what it points at: not a count, not a
kind.

## Highlight machinery

- **Doc side** (`src/lib/annotation-highlight-extension.ts`): link parts ride the
  existing `AnnotationHighlight` plugin under `kind: "link"` (or `"draft-link"`) — one
  list, one plugin state, one per-transaction 3-tier re-resolve, so twenty link ranges
  cost what twenty more annotations would. State keeps a separate `linkRanges` map
  (`getAnchoredLinkRanges`) keyed by anchor row id — one family, minted or draft — so a
  rail card and a thread jump can't mistake it for an annotation id. One `buildSegments`
  pass over every kind: an overlap becomes one segment carrying both classes
  (`annotation-highlight anchored-link-highlight`) and both plural data attributes;
  link sources are excluded from the `--thread-color` vote. No drift persistence —
  re-derive only, like doc-links. `decoration-segments.ts` unchanged;
  `anchoredLinkAnchorInputs(parts, kind)` filters to DOC_RANGE parts (PDF parts have null
  offsets and fall out).
- **Paint** (`src/styles/prose.module.css`): a wash off `--link` **plus an underline**,
  with an explicit overlap rule at (0,3,0) specificity handing the background to the
  annotation's author tint — one span has one background, and wayfinding yields to
  discussion; the underline is what keeps the link's extent visible underneath. `.pulse`
  is the banner's *click*-jump flash (the `QuoteThreadHeader.jumpToQuote` pattern) — the
  on-load `?sel=` jump scrolls without it.
- **Clicks**: link-only spans are deliberately **not** in `AnnotationClick`'s union —
  structurally free, since the union never consults `linkRanges` — and the absence is
  recorded as a comment there so a future `part-anchors` merge doesn't sweep them in. The
  banner (or, for a draft part, the tray) is the affordance.
- **PDF side** (`src/components/pdf/anno-layer.ts`): `AnnoLayerEntry.variant: "link"`
  draws `annoRect annoRectLink` — an **outline** in `var(--link)`, no fill (inside the
  layer's shared group opacity a second fill would shift every annotation it overlaps) —
  and carries **no `data-anno-id`**, so the delegated click handler never sees it:
  annotations stay clickable straight through a link region. `"draft-link"` adds
  `annoRectDraftLink` (`outline-style: dashed`) and is a link region in every other
  respect — the layer asks "is this a link region" once rather than testing the variant
  in three places. The surface appends link regions *before* annotation entries; append
  order is stacking order in that layer.

## Painting a draft

The passages already in the viewer's open link — the draft, or a minted link reopened for
editing ("Editing a minted link" below) — are drawn on whichever surface they belong
to, so "Add to link" visibly does something to the passage it was invoked on. **Same
highlight as a followed link's, dashed underline instead of solid** (doc:
`anchored-link-draft-highlight` over the base class, `border-bottom-style: dashed`; PDF:
`annoRectDraftLink`, `outline-style: dashed`). Both facts are deliberate: it *is* a link
part, so it gets the link wash rather than a colour of its own, and what marks it as
in-progress is the **same dashed underline `.pending-annotation` already uses** for a
composing annotation — one vocabulary for "not committed yet" across the surface, not a
second dash pattern to be learned separately. The two stay distinguishable by colour (the
composing author's own vs. `--link`) and by wash, which is what they already differ in.

- **Only its creator ever sees it.** `loadMyOpenLink` is session-scoped, so there is no
  other viewer's draft to leak and nothing here re-checks anything (`TagChips`' stance).
- **Delivery is client-side, and had to be.** Adding a part revalidates nothing on
  purpose (above), so a server prop would paint one navigation late.
  `src/components/anchored-link/open-link-store.ts` is **one** module-scope copy of the
  open link shared by every consumer: it subscribes to the tray-events channel on the first
  mount, re-reads on each notify, and hands the same answer to the tray's text list and
  to each surface's highlights — a store rather than a hook per consumer because the
  consumers have no common React ancestor to hang a context off (the PDF page's surface
  is inside the `ssr:false` island, the tray is the page's own sibling), and because two
  self-fetching consumers would be two round trips per notify. A notify arriving
  mid-flight queues one more read rather than reusing the answer in progress, which may
  have been taken before the mutation that prompted it committed.
- **Minted and draft ids stay in separate DOM attributes** (`data-anchored-link-ids` vs.
  `data-anchored-link-draft-ids`): the banner's jump queries the first, and a draft part
  is not a jump target — nothing links to a link that doesn't exist yet.
- **The PDF surface keeps draft regions in a second list**, not merged into `linkParts`:
  that list also decides the on-load `?sel=` jump, and a draft part must never hijack
  where a followed link lands.
- `loadMyOpenLink` therefore returns each part's target, offsets and selector, not just
  its label and quote — still BigInt-free (no `ydocUpdateId`), the same rule
  `anchoredLinkForViewer` follows for the same reason.

## Server actions — `src/app/actions/anchored-links.ts`

`loadMyOpenLink` / `addAnchoredLinkPart` / `removeAnchoredLinkPart` /
`reorderAnchoredLinkParts` / `discardDraftLink` / `mintAnchoredLink` /
`openAnchoredLinkForEditing` / `closeAnchoredLinkEdit` / `renameAnchoredLink`. The
load-bearing rules:

- **Create-permission is read-the-target** — signed in plus `canUserReadDoc`/
  `canUserReadFile`, the annotate precedent, no role floor of its own (docs/PERMISSIONS.md
  records why that differs from tags). `post`/`annotation` targets are rejected as
  deferred; kinds parse via `parseAnchorTargetKind`, never a cast.
- Doc part: `ydocIdForDoc` → `resolveCaptureStamp` (client's `atVersion` first, log tail
  as fallback — `postAnnotation`'s §13q order; duplicated from the branch, unify if it
  lands) → `captureAnchorInYdoc` with `docContentExtensions`. What lands in `quoted_text`
  is this server's own reading of the stamped state, never the client's. **Capture failure
  is an error and nothing is stored** — a link part IS the content; degrading to
  whole-object would mint what an ordinary href already is (`tagObject`'s stance).
- PDF part: `capturePdfTextAnchor` → `{fileId, PDF_TEXT, selector: target, quotedText}`,
  null offsets/stamp (the `KNOWN_RESIDUALS` shape `check-tag-constraints` names as
  intended).
- `partOrder` = current count at add time; remove is a hard delete on the viewer's open
  link with no renumbering (and, on a minted link, never of the last part); reorder
  renumbers the whole set 0..n-1 in a transaction and refuses a set that no longer matches
  the row; discard hard-deletes the draft (cascade). `mintAnchoredLink` requires ≥1
  part, refuses to mint when no part's target still exists (a link that would land
  nowhere), stamps `mintedAt`, and returns `appUrl(/link/<id>)`. Which target a recipient
  lands on is the landing route's question, answered per viewer at follow time — it used
  to be answered here, once, as part 0's page.
- **No `revalidatePath` anywhere, deliberately** (contrast `untagObject`): both routes are
  per-request dynamic, and everything showing the draft self-fetches on
  `src/lib/anchored-link-tray-events.ts` — a module-scope listener set
  (`onAnchoredLinkChanged`/`notifyAnchoredLinkChanged`), because on the PDF page the
  popover, the tray and the surface live in different trees with an `ssr:false` boundary
  between them. "Painting a draft" above is the reader side of that channel.

## Surfaces

**The landing route** (`src/app/link/[id]/page.tsx`; `"link"` in `RESERVED_SLUGS`; the
same `gated` envelope as the reading routes): the URL a minted link *is*. A router before
it is a page —

| For this viewer | `/link/<id>` |
|---|---|
| exactly one readable group | redirects to that group's href — `?sel=` and all; the surface scrolls, highlights and lists |
| two or more readable groups | renders the excerpt page |
| a readable link, no readable group | renders a page that says so and names nothing |
| no such link, deleted, someone else's draft | 404 |
| any of the above with `?noredirect=1` | never redirects — the excerpt page, or the empty one |

The excerpt page (`data-testid="anchored-link-landing"`): the link's name, or "Linked
passages" for an unnamed one ("Naming a link" below), as heading and tab title; who shared
it and when; then one `<section data-testid="anchored-link-group">` per readable group in
first-part order — kind, title, each part's stored `quoted_text` as a `<blockquote>` in
part order, and an "Open in context" link carrying `?sel=` onward. Quotes are shown
**plain and labelled as captured**: the doc side's `textBetween(…, " ")` flattens a
paragraph break to a space and drops headings, lists and images, and the PDF side is
normalised text — thinner than the passage, and exactly what the anchor holds, which is
what makes the page cheap (no ydoc tap, no editor, no pdfjs, no file download) and keeps
it honest after the target changes. When the readable groups are exactly two docs it also
offers **"Open side by side"** (`/side-by-side/<a>/<b>` — both passed the predicate that
route gates on), hidden by CSS below the 900px width where §14f's layout stacks; that
surface does not yet paint link parts ("Explicitly deferred"). The signed-out redirect
carries `?noredirect=` through `signInPath`, so signing in returns to the page asked for
rather than the redirect it declined; `check:sign-in` covers the gate like any other. The
creator sees an **Edit link** button under the meta line and the tray is mounted on this
page ("Editing a minted link" below); once a minted link's parts have changed the meta
line reads ", edited <date>" after the share date.

**Doc follow** (`src/app/doc/[slug]/page.tsx`): reads `searchParams.sel` after the gate,
outside the `gated` memo (it keys on arguments and `generateMetadata` already ran it).
This doc's DOC_RANGE parts merge into the **same `annotationAnchors` array** the
annotations ride — no DocView/DocReadingBody prop changes for paint. All surviving groups
feed `AnchoredLinkBanner` above `DocView`.

**The banner** (`src/components/anchored-link/AnchoredLinkBanner.tsx`, client, shared by
both surfaces, `data-testid="anchored-link-banner"`): titled with the link's name, or
"Linked passages" ("Naming a link" below); this surface's part quotes as jump
handles (DOM query on `data-anchored-link-ids`, scroll+pulse; doubles as
cycle-through-parts), every *other* readable group as a link carrying `?sel=` onward; a
**"View as excerpts"** link to `/link/<id>?noredirect=1` (also where a part that resolves
nowhere on this surface still reads); dismissible. On-load scroll-to-first retries ~10×300ms until the read-only editor mounts —
doc mode only, and it scrolls without the pulse (the flash marks a deliberate click, not
arrival); supplying `onJumpToPart` (the PDF surface does) hands over both the click
jump and the on-load jump. Parts that fail to resolve are listed, painted nowhere,
silently (doc-link behavior). It renders what it is handed and adds no second permission
check — `TagChips`' stance; the type import from `anchored-link-data` is type-only, so the
server module never reaches the client bundle.

**PDF follow** (`src/app/pdf/[slug]/page.tsx` → `PdfSurfaceClient` →
`PdfAnnotationSurface`): the link view is delivered as an **initial prop through the
`ssr:false` boundary** — the one delivery CLAUDE.md's `router.refresh()` trap permits. The
slug-history redirect re-appends `?sel=` (it used to drop the querystring — a shared link
minted against a renamed slug would have landed with its passages silently gone). The
surface prepends this file's PDF_TEXT parts into `entriesForPage` as outline regions,
jumps to part 0 once on `ready` via `jumpToTarget` (the target-based core extracted from
`jumpTo`), and positions the banner as a fixed overlay (`.anchoredLinkOverlay`, z-index
below the selection popover — a live selection outranks wayfinding).

**Creation**: `AnnotationPopover` takes an optional `onAddToLink?: () => Promise<string |
null>` (error message or null; success clears the selection upstream, which unmounts the
popover; errors land in the shared error slot). `DocReadingBody` supplies it on reading
views only — the doc editor's widget leaves it undefined and gets no button. The PDF
surface's `selectionPopover` gets a second button beside Annotate; its error is
identity-keyed to the popover object (the `refetched` pattern), so a new selection simply
stops rendering the stale message. Both paths post immediately, clear the selection, and
`notifyAnchoredLinkChanged()`.

**The tray** (`src/components/anchored-link/AnchoredLinkTray.tsx`,
`data-testid="anchored-link-tray"`, `data-mode="draft"|"editing"`): a fixed bottom-right
island both reading pages and the landing route mount as a **self-fetching sibling** (doc:
end of `<main>`; pdf: sibling of `PdfSurfaceClient`, outside the `ssr:false` boundary).
Reads the shared open-link store — which fetches on the first consumer's mount and on
every notify — rather than owning the fetch itself, so the list and the surface's
highlights can never disagree about what is open; renders nothing without an open link or
with an empty draft. A name field ("Naming a link" below), the part list (a grip, label +
~60-char snippet, per-part ✕), then the mode's buttons. **Reorder is a drag** by the grip
or the text — both show the hand, and a rule between rows marks the slot the held row
would drop into; pointer events rather than HTML5 drag-and-drop, which iOS never delivers
for touch, and no library for a handful of rows. The grip takes the arrow keys, so the
keyboard kept what the up/down buttons gave it. A draft: **Copy link** (mint → clipboard →
"Link copied" note with the recipients-see-only-what-they-may-read sentence → tray clears;
a clipboard-permission failure still mints and shows the URL as text) and **Discard**. A
reopened link: **Copy link** (the URL it has had all along — no mint; an inline "Link
copied." note), **View** (the excerpt page) and **Done**. Fixed positioning keeps it out
of every page's layout math.

**The management table** (`src/app/links/page.tsx`, `src/components/LinksTable.tsx`,
`src/lib/links-query.ts`; `"links"` in `AdminTableName`, `RESERVED_SLUGS` and the
site-settings column defaults; the header's **Links** entry sits after Files, top level
rather than in the Docs dropdown because a link spans docs *and* PDFs): the §16
admin-table kit over `anchored_link`, added 2026-09-08. Gated on `canManageDocs` like
every other listing. **Row scoping is the follow rule as a `where`**: a link lists for its
creator (their own draft included — nobody else's, ever) or when it is minted and *some*
anchor points into a doc or file the viewer may read, with
`canUserReadDoc`/`canUserReadFile` restated as relation filters the way `/annotations`
restates them. Within a row the cells re-apply the filter **per target**, once per page
rather than per group (two `findMany`s over the page's distinct doc and file ids, both
wearing the read clause and riding the soft-delete `$extends`), so a
readable-PDF-plus-unreadable-doc link lists and shows the PDF's passages alone — no count,
no placeholder, the banner's rule. The free-text search is bounded by the same clause, or
`?q=` would be a probe into quotes the viewer cannot see (the link's *name* is searched
unbounded: it is the creator's text, not an excerpt, and the row is already in scope).
Columns: Name (the creator-given name, sortable, edited in place where the viewer may
rename — "Naming a link" below), Passages (readable parts' count, linking to
`/link/<id>?noredirect=1`, with each quote as a snippet beneath), Targets (kind + title,
each carrying `?sel=`), Created by, Created at, Minted at (*draft* for the viewer's own
open one; *· editing* beside the date for their own reopened one), Edited at
(default-hidden; null until a minted link's first edit), Id and Deleted at (both
default-hidden), Edit (the creator's own minted rows only — "Editing a minted link"
below), and the delete/restore control. **Passages and Targets carry no sort key** — they
are per-viewer values, and nothing Postgres could `ORDER BY` (a view has no viewer)
matches what the cell shows; `/annotations`' Quote is the precedent. Deep links `?user=`,
`?doc=`, `?file=`. No ADMIN "Show all": an override here would widen which excerpts are
shown, not just which rows.

An **Owners** dropdown (`?owners=<slugs>`, `/files`' control under `/files`' name) filters
by creator, with two departures from `/files`. **Its list is the distinct creators of the
rows this viewer may list**, not every ADMIN/EDITOR/AUTHOR: a link's creator has no role
floor (an AUTHORIZED reader mints links), so the byline-eligible set would omit exactly the
people worth finding, and "every account" would hand an AUTHOR the whole user list — the
scoped list shows no name the Created by column doesn't already. It is drawn from the scope
alone, never the deep links, the search or the deleted toggle, so narrowing the table never
empties the dropdown of the person it was narrowed to. And **there is no `ownerMode`**: a
link has one creator, so ALL and EXACTLY collapse into ANY and the Match select is not
rendered (`AuthorFilterPanel` takes `mode` as optional for this). If links ever gain
co-owners, the mode comes back with the relation.

Its delete is a **soft delete of a minted link** — `deleteAnchoredLink` /
`restoreAnchoredLink` and their bulk pair in `src/app/actions/anchored-links.ts`, gated by
`canUserDeleteAnchoredLink` (`src/lib/anchored-link-authz.ts`): the creator or
ADMIN/EDITOR, never a draft (a draft is discarded from its tray, and a restorable
soft-deleted draft could later collide with the one-open-draft partial index). The anchors
stay; `anchoredLinkForViewer` reads `deletedAt`, so a deleted link 404s for everyone until
restored. Deleting also clears `reopened_at`, closing an edit in progress, so a restore can
never collide with the one-open index. docs/PERMISSIONS.md carries the rows.

## Editing a minted link

Since 2026-09-08 a minted link is editable by its creator: reopen it into the tray, add,
remove and reorder passages, Done. The decisions, each recorded because the obvious
alternative was considered:

- **In place, and live.** The URL is the row id and recipients keep it, so every add,
  remove and reorder lands on the row they are following the moment it happens — exactly
  as "Add to link" already posts each draft part. Staged edits (a copy of the part rows
  and a swap on Save) were rejected: a second row set for parts that cost one click to add
  back, and a Save button whose only job is to make a wayfinding pointer atomic.
- **The tray is the editor.** A reopened link shows in the tray with the same part list
  and controls as a draft; only the title and the buttons differ ("The tray" above). One
  editing surface: the landing page mounts the tray too, so remove/reorder/Done work from
  the excerpt page, and adding a passage means "Open in context" onto a reading view.
- **`reopened_at`, not a nulled `minted_at`.** Nulling `minted_at` to reopen would make
  the row indistinguishable from a never-shared draft, and every reader treats one as
  such: the follow read hides it from everyone but its creator (the URL goes dark for the
  duration), Discard hard-deletes it, the delete guard refuses it, a re-mint restamps the
  share date, and the last-part rule below would not apply. Each is patchable by asking
  "a real draft, or a reopened link?", which needs a second bit on the row — and once
  there is one, `minted_at` keeps meaning "shared since" and the bit means "in the tray".
  A draft never carries it (the CHECK), so "open" is one predicate, `minted_at IS NULL OR
  reopened_at IS NOT NULL`, which the partial unique index and `openLinkWhere` both spell.
- **One open link per creator, draft or reopened**, by that index. Opening a minted link
  while an *empty* draft is open discards the draft (it is the row removing a draft's last
  part leaves behind, with nothing in it to finish); while a draft *with passages* is open
  it refuses, with the same sentence the Edit button shows beside itself; while another
  minted link is mid-edit it closes that one, whose edits were live anyway.
- **The creator's alone.** No moderator arm, unlike delete: the tray is per creator, and a
  passage added by anyone else would put *their* reading into the creator's link.
  docs/PERMISSIONS.md has the rows. Adding still wears the target's read gate.
- **Never to zero passages.** Removing a minted link's last part is refused ("delete the
  link instead"): a shared URL that resolves to nothing is what delete is for, and the
  landing route would otherwise render its "no passages" page for a link that used to
  have one. Count-then-delete, so it runs in a transaction holding the link row. A draft's
  last part still comes out, leaving the empty row as before.
- **A soft delete closes the edit** (`reopened_at` cleared with `deleted_at` set): the
  index ignores deleted rows, so a restore of a still-reopened link could otherwise collide
  with whatever the creator opened since.
- **`edited_at`** is stamped on every add, remove and reorder of a minted link, never of
  a draft. The landing page's meta line reads ", edited <date>" and `/links` sorts on it
  (hidden by default — most links are never edited).

**The Edit affordance** (`src/components/anchored-link/EditLinkButton.tsx`, one component
mounted in the banner, under the landing page's meta line, and in a `/links` row) decides
its state from the open-link store, never from the server (`editAffordance`,
`src/lib/anchored-link-editing.ts`, unit-tested): the moment the tray's Copy link or
Discard finishes, every Edit button on the page re-derives itself from the same store the
tray re-rendered from. Four states — nothing until the store has answered (a button that
rendered off `null` before the fetch returned would flash enabled and then grey out);
"Edit link" when nothing is open, an empty draft is, or another minted link is mid-edit;
"Open in your tray" when this link is the open one (Done lives in the tray); and
*disabled with the reason as visible text* when a draft with passages is open — text
rather than a tooltip, because a disabled button takes no hover or focus and a title never
shows on a phone. The reason is the exported string the server refuses with, so the two
cannot drift. Whether the affordance renders at all is the server's `canEdit` on the
follow view and the landing loader (creator and minted), decided beside the per-target
filter so the banner and landing page render what they are handed.

**Paint while editing** — when the open link is the followed one, the same anchor id
reaches a surface twice, as a followed part and an open one. The doc side keeps both:
one segment carries both classes (the dashed rule wins the underline, the honest reading)
and *both* data attributes, so the banner's jump, which queries the followed-link one,
keeps working. The PDF side draws once, dashed — two outlines on one set of quads would
read as solid whichever was on top — which is safe because its jump is target-based and
needs no region.

**Logging out mid-draft** changes nothing: the draft (or reopened link) is a server row,
and the next page that mounts the tray shows it again. Nothing on the dashboard says it
exists; the disabled Edit button's hint is the one place a forgotten draft announces itself
away from a reading page.

## Naming a link

Since 2026-09-09 a link may carry an optional, creator-given **name** — one nullable
column, `anchored_link.name` — shown wherever the link resolves for the viewer, in place of
"Linked passages": the excerpt page's heading and tab title, the banner's title on a
`?sel=` page, and `/links`' Name column. An unnamed link reads exactly as before, and
nothing requires a name at any stage.

- **One pure module, `src/lib/anchored-link-name.ts`** (the `doc-title.ts` of this
  feature): `normalizeLinkName` — trim, collapse internal whitespace, cap at 80 (the
  tag-name limit), and **null for nothing, never an empty string** — and
  `anchoredLinkTitle`, the `?? "Linked passages"` every surface renders through. The
  column's CHECK (`anchored_link_name_not_blank_check`) refuses a blank, so that fallback
  is the whole story and no reader carries a second "or blank" test. Unit-tested, since the
  rejection surface is the point.
- **One write path, `renameAnchoredLink(linkId, name)`**, shared by both surfaces. Who may
  is `canUserRenameAnchoredLink` (`src/lib/anchored-link-authz.ts`): **the creator at any
  stage, a moderator (ADMIN/EDITOR) once the link is minted, nobody on a deleted row.**
  That is the delete rule's shape, not editing's — a name is presentation, not a passage,
  and the "creator's alone" reasoning for editing (a passage added by someone else would
  put *their* reading into the creator's link) does not reach a retitle. A draft's name is
  its creator's alone by inheritance: nobody else can list or follow one. An unchanged
  name writes nothing; a changed name on a *minted* link stamps `edited_at`, whose meaning
  widens to "parts or name last changed" — recipients see the name in the banner and on
  the landing page, so a rename is a change they can notice.
- **The tray's field**, in both modes: a draft can be named before Copy link, and the mint
  carries the name across; a reopened link is renamed in place. The `UsersTable` NameCell
  shape — committed on blur or Enter, never per keystroke — then the store re-reads. The
  field is mounted under a key of the store's current name, so a save ends with it
  remounting on what the server stored rather than reconciling two copies. It appears with
  the tray, which renders nothing at zero parts, so a name cannot be typed before the first
  passage; and an empty draft with a name still gives way to Edit (a name alone is not
  something to finish).
- **`/links`' Name cell**, first after Select, sortable (unnamed rows last in both
  directions, the Created by rule) and searchable *unbounded* by the readability clause
  that bounds the quotes. The cell is the same NameCell shape where `canRename` holds,
  wired to the row's status border like `/users`' name and calling `router.refresh()` after
  its save as every cell in the kit does; every other row shows the name as text — a
  disabled field would read as a control withheld, where for most rows there is simply no
  name. Clearing it leaves the link unnamed.
- **The name follows the per-target rule structurally.** It rides `AnchoredLinkView`, which
  is null when no group survives the filter, so the landing route's "nothing readable"
  page and its 404 cannot show it — a creator can name a link after the very targets a
  viewer may not read, and a page that names nothing about the link names that neither.
- **Same-page freshness without a refresh.** `useLinkName(linkId, serverName)` on the
  open-link store prefers the store's copy while that link is the open one; the banner's
  title and the excerpt page's heading (`AnchoredLinkHeading`, a client island for this one
  reason) both read through it, so a rename in the tray shows on the page at once — the
  "did something and saw nothing" failure that got draft parts painted. The tab title
  waits for the next navigation.

## Navigation is a mount boundary

The banner's group links are the **first client-side doc→doc navigation in the app**
(body hyperlinks are plain `<a>`s), and following one initially painted nothing until a
hard refresh. Two stacked defects, both fixed, both load-bearing:

1. `/doc/[slug]` didn't key `DocView` by doc identity, so the nav *reused* the reading
   editor and pushed the new doc's anchors against the old doc's text — every anchor
   detached, permanently (detachment is deliberately re-evaluated only on the next anchor
   push). Now `key={doc.id}`, and `/pdf/[slug]` keys `PdfSurfaceClient` by `file.id` for
   the same class (stale viewer, stale `ready`, a once-only link jump that never re-fires).
2. `use-live-doc-content.ts` owned its Y.Doc in a `useMemo`, and a transition render
   replay (the byline's async `TagChips` suspending is enough) legally drops the memo
   cache: a second Y.Doc, a second provider, and a handshake update event on the
   still-empty second doc that `setContent`'d an empty body over the editor — same
   permanent detachment, and it would have taken **annotation** highlights with it on any
   such nav. Now a `useState`-owned Y.Doc plus a pre-sync guard in `applyUpdate`
   (`onSynced` does the one catch-up push, which also covers reconnects). Invisible to
   hard loads by construction, which is why `e2e/anchored-links.spec.ts`'s third test
   asserts paint only after *clicks*.

## Verification

- `npm run test:unit` (the `deriveDocRangeSelector` cases arrived with the cherry-pick);
  `npx tsc --noEmit`; `npx eslint .`; STYLE.md's color-literal grep.
- `e2e/anchored-links.spec.ts`, seven tests: cross-surface create + follow (UI-driven:
  popover → tray across a doc→PDF nav → Copy link → the minted `/link/` URL renders the
  excerpt page for a viewer who may read both groups → "Open in context" into the doc →
  the banner into the PDF → "View as excerpts" back out); the per-target filter (a
  PRIVATE-doc+shared-PDF link read by a viewer who may see only the PDF — the landing
  route redirects them straight to the PDF, its banner and outline render, nothing on the
  banner or on the `?noredirect=1` page acknowledges the doc group, and the doc's own URL
  still forbids); the banner-nav regression above; the sign-in round trip of `?sel=` on a
  reading route and of `?noredirect=` on the landing route; the landing route's arms (one
  group redirects, `?noredirect=1` declines, a doc pair renders with the side-by-side
  offer, an unknown id 404s); and the empty page for a link whose only target is a
  PRIVATE doc the viewer may not read. All but the first two run on
  **fixture-minted links**: `e2e/db-worker.ts`'s `createTestAnchoredLink` writes rows the
  way the real writer does — quotes derived server-side from the seeded body (offsets that
  hold no text fail at creation, not as a later integrity finding), stamps from the target
  doc's own log tail — and mints them, so nothing collides with the one-draft partial
  index. `deleteTestUser` sweeps `anchored_link` rows (RESTRICT FK, the doc-link shape).
- `e2e/links.spec.ts`, five tests, all on fixture-minted links (`createTestAnchoredLink`
  gained `minted: false` for the draft case, throwaway creators only): the header order
  (Files, Links, Users for an admin; Files, Links and no Users for an AUTHOR); the table's
  two scoping rules at once — a mixed PRIVATE+SHARED link lists for an AUTHOR with the
  shared passage alone while a private-only link is no row, and `?q=` on a token found
  only in the private quote returns two rows for the doc's author and none for the AUTHOR;
  the soft delete (an EDITOR deletes the admin's link, following it 404s, it shows under
  show-deleted, the creator restores it and the landing page renders again); a throwaway
  AUTHOR's draft listing as *draft* with the control off and invisible to the admin; and the
  querystring surviving the sign-in redirect. `e2e/admin-table.spec.ts`'s two every-table
  loops include `/links`.
- `e2e/anchored-link-editing.spec.ts`, five tests, every creator a throwaway (the one-open
  slot): the round trip — Edit from the excerpt page, "Open in context", a part added
  through the popover onto the reopened link, reorder, remove, Done, then the admin follows
  the same URL into the doc and the banner lists the new set with no Edit anywhere and the
  excerpt page reads "edited"; the blocked state — a fixture draft with passages disables
  Edit with the hint, Discard in the same page's tray enables it with no reload, the last
  part of a shared link refuses, Copy link copies without minting, and a delete/restore
  from `/links` closes the edit; `/links`' Edit — an empty fixture draft gives way, the
  row reads *editing* and the admin's row has no Edit; the PDF surface — a link minted
  through the UI from a PDF part, Edit from the banner inside the `ssr:false` island, the
  followed region drawn once and dashed while open (the dedupe: `.annoRectLink` stays at
  one), a second PDF part added, and Done returning it to solid; and the give-way arm — a
  fixture-`reopened` link A yields to Edit on link B (ready, not blocked), after which A's
  page offers Edit afresh and `/links` reads *editing* on B alone.
- Integrity, by the one-walk-per-invariant rule: `check-annotation-anchors.ts`'s
  part-anchor walk is now parameterised over both tables (`tag_anchor`,
  `anchored_link_anchor`) and replays DOC_RANGE parts at their stamps;
  `check-pdf-anchors.ts` gains the PDF_TEXT pass (the first selector blob it checks beyond
  annotations); `check-tag-constraints.ts` probes the DDL as above.
  `scripts/integrity/README.md` records the arrangement.
- Naming (2026-09-09): `src/lib/anchored-link-name.test.ts` pins `normalizeLinkName`'s
  rejection surface. The editing spec's round trip names the link from the tray on the
  excerpt page and checks the heading there, the banner in context, and the recipient's
  heading and tab title; `anchored-links.spec.ts` names the draft before Copy link and
  asserts the "nothing readable" page shows no name while the creator's banner does;
  `links.spec.ts`'s Name test covers the moderator's field (normalised on the way in, held
  across a reload), the AUTHOR's plain text, `?q=` on the name, and the creator clearing
  it. `check-tag-constraints.ts` probes the not-blank CHECK both ways.

## Deviations from the plan

Everything unmentioned went in as written. Where the build differs:

- **The doc-side paint grew an underline and an overlap rule.** The plan named only a
  `color-mix` wash off `--link`; two overlapping inline decorations fight over one
  background, so the annotation's author tint wins it explicitly (a (0,3,0) rule, the
  `.noAnnotations` order-independence convention) and the link keeps its underline. The
  part-anchors branch's compose-don't-fight precedent, applied.
- **`annotation-click-extension.ts` needed no code, only a comment.** The plan said to
  mirror the branch's hunk; link ranges live in a map the click union never consults, so
  exclusion is structural — the comment records it as chosen so a future merge doesn't
  sweep them in.
- **The first e2e test asserts the outline region, not "viewer scrolled".** The PDF part
  sits on page 1, where the on-load jump is a no-op scroll; the region's existence and the
  banner are the observable claims.
- **Removing a draft's last part keeps the empty draft row** (the tray renders nothing at
  zero parts) rather than retracting the act the way `untagPart` does — one row per user,
  bounded by the partial index, and the next add reuses it.
- **The navigation section above is entirely unplanned** — both bugs were found by
  following the feature's own banner, one of them pre-existing with reach beyond links.
- **The fixture-minting e2e machinery is beyond plan** (the plan's fixtures created rows
  only through the UI), as is the tray's clipboard-failure fallback.
- **Draft parts are painted after all** (added 2026-08-31, after the rest shipped). The
  plan's "tray only, as text" is reversed — "Painting a draft" above — which is what
  turned `loadMyDraftLink` into a positional read and gave the tray's fetch a home in a
  shared store. It borrows `.pending-annotation`'s dashed underline outright rather than
  taking a pattern of its own: dashed means in-progress here, whatever is in progress.
- **`/links` (2026-09-08) is the deferred management table**, and its one design choice
  the plan never took: rows are scoped by *readability of some target* rather than listing
  every minted link — the landing route's empty page proves a link's existence to someone
  who already holds its id, which is not the same as listing that id for everyone who can
  open an admin table. Drafts cannot be deleted from it; only the tray's Discard touches
  a draft.
- **The landing route (2026-09-07) reverses decision 1's "no `/sel/[id]` route".** The
  minted href was part 0's page, chosen once at mint time — but readability is per viewer,
  so a recipient who could not read part 0's target met that page's Forbidden and never
  learned the link held a part they could read (the second e2e test covered a viewer
  *handed the PDF href*, not one handed the doc's). `/link/[id]` routes at follow time
  instead: it redirects when that is honest for this viewer and renders the stored quotes
  otherwise. Neither reading route changed — `?sel=` on them is exactly as built, and the
  landing page's links carry it the way the banner does. The prior art that settled the
  shape, for the record: Hypothes.is (in-context direct links, a standalone page as the
  fallback), Chrome's text fragments (several ranges, scroll to the first, highlight all —
  the several-parts-one-target behaviour the reading routes keep), Xanadu (an excerpt
  page is a xanadoc of the link's spans, and a transclusion must stay visibly connected to
  its source — hence "Open in context" on every group), Intermedia and Microcosm (a
  multi-destination link opened a chooser rather than landing on the first), and
  Engelbart's Augment viewspecs (a link may carry its own arrival mode — `?noredirect=1`
  is the one such flag here).

- **A minted link is editable (2026-09-08)**, reversing both the plan's "no editing after
  mint" and the sketch's "a mistake is answered by making a fresh link". "Editing a minted
  link" above has the shape; one column (`reopened_at`, plus `edited_at` for the record)
  is the whole schema cost, and the one-draft index became the one-open index.
- **A link can be named (2026-09-09)** — "Naming a link" above. The deferred list called
  this a *label* and put it in the editing tray alone; it went in as a *name*, in the tray
  and as an in-place cell on `/links` with the delete rule's moderator arm, one nullable
  column plus a not-blank CHECK.

## Explicitly deferred

Post targets (`POST_RANGE` has no selector kind), annotation-body targets (arc ready,
writer refuses), multi-page PDF selections (capture is start-page-only today), part roles
(`docs/research/multi-anchoring.md`: these parts are homogeneous), drift persistence. (The
`/links` table, minted-link deletion and editing after mint, all deferred here until
2026-09-08, and link names, deferred until 2026-09-09, are built — "The management table",
"Editing a minted link" and "Naming a link" above.)

Deferred by the landing route specifically:

- **Painting link parts on `/side-by-side`.** The excerpt page offers that layout for a
  doc pair, but `SideBySideDocBody` mounts only the doc-link extension (§14p: a sibling
  of `DocReadingBody`, not a mode of it), so following the offer shows both docs and no
  passages. Trigger: the first person who follows it and asks where the passages went —
  then a `?sel=` read on that route and an anchors prop down `SideBySideView` →
  `DocColumn` → `SideBySideDocBody` onto the same `AnnotationHighlight` plugin.
- **Rich excerpts.** The page shows `quoted_text`. A paragraph-preserving doc excerpt
  means slicing the prose snapshot through `resolveAnchorInDoc` (display only — the "never
  position off `Doc.proseJson`" rule is about *positioning*) or replaying the ydoc to the
  part's stamp per request; a PDF image excerpt means server-side pdfjs rendering of the
  quads' region, cached by `sha256`. Plain text first, on purpose.
- **A `part=` parameter**, so an excerpt's own link could land on *that* part rather than
  its group's first; today "Open in context" is per group.
- **A landing mode stored on the link** (Augment's viewspec): `?noredirect=1` is a
  per-visit flag, not a per-link one. If a minter ever wants "always the excerpt page",
  that is one nullable column, not a new route.

## Appendix — prior art for the open-link store (2026-09-10)

Written after the question "did we just add a DB call to every doc load?", and then
"isn't that pattern a bit unusual?". The first answer is yes, client-side after hydration,
and it is **more statements than it looks** — measured against the dev database with
`log: ["query"]`, not read off the source:

| viewer | statements per page load |
|---|---|
| no open link | 1 (`findFirst` on the partial index's own predicate, returns null) |
| open link, no parts | 2 — the `select` of the `anchors` to-many is its **own** round trip |
| open link with parts | 4 — the two above plus a `doc` and a `storedFile` label `findMany` |

The second row is the surprise and it is Prisma's default `relationLoadStrategy: "query"`:
an `include`/`select` of a relation is a second statement joined in the client, not a JOIN.
`auth()` is free either way (`strategy: "jwt"`, no session table read). "Packaging the
round trips" below is what to do about it. The rest of this appendix answers the second
question.

**The mechanism is mainstream and has a name. The motivation is not the one that name is
famous for.** That gap is the thing worth writing down, because the next person will
assume the usual rationale and then be puzzled that every route here is dynamic.

### The mechanism: a hole punched for the per-viewer fragment

Deferring the personalized part of a page and filling it separately is
[Edge Side Includes](https://www.litespeedtech.com/products/features/edge-side-includes),
known in the PHP/Magento world as
[hole punching](https://www.litespeedtech.com/products/cache-plugins/magento-acceleration/hole-punching)
or donut caching, and renamed
[server islands](https://docs.astro.build/en/guides/server-islands/) by Astro in 4.12.
Astro's canonical examples are *a user's avatar and their shopping cart* — the two things
that otherwise force a whole page to be uncacheable.

The cart analogy is closer than a metaphor: the tray is per-user, at most one open at a
time, built up across pages, and its contents have nothing to do with whichever page is
showing it. Nobody thinks that shape is strange in a checkout flow.

### The store shape is the standard one

A module-scope vanilla store read through `useSyncExternalStore` is what Zustand, Jotai
and Redux Toolkit all do internally, and "share state across separate React root trees
without a common context" is the documented reason to reach for it — which is exactly the
reason `open-link-store.ts` gives (the PDF surface inside the `ssr:false` island, the tray
as the page's own sibling). It is also the tearing-safe choice under concurrent rendering;
a hand-rolled subscribe-and-`forceUpdate` would not be.

### The fetch policy is SWR / TanStack Query, re-derived

| `open-link-store.ts` | library equivalent |
|---|---|
| fetch on first subscriber | SWR `revalidateOnMount` |
| many consumers, one request | SWR key deduping / TanStack observers |
| `notifyAnchoredLinkChanged()` | `mutate(key)` / `invalidateQueries` |
| three-valued `undefined` | SWR's `data === undefined` before the first response |
| `clearOpenLink()` on mint/discard/Done | optimistic `mutate(key, data, false)` |

**The convergence worth keeping:** "coalesced, but never *dropped*" is TanStack Query's
[`cancelRefetch: true`](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation),
its `invalidateQueries` default since v4, and it is there for the hazard this file's own
comment names — a request already in flight may have been *sent* before the mutation that
prompted the invalidation committed, so reusing its answer serves pre-mutation data. Same
hazard, different remedy: they cancel and restart, we queue one more read. Arriving
independently at a library's non-obvious default is the best evidence available that the
reasoning was right.

Server-side, `anchored_link_one_open_per_user` is likewise the textbook
[partial unique index](https://medium.com/little-programming-joys/unique-partial-indexes-with-postgresql-86e137905c12)
for "one active cart / one active subscription per user" — the standard answer to a
uniqueness rule that application code loses under concurrency, which is exactly why
`getOrCreateOpenLink` can treat P2002 as "re-find the winner" rather than an error.

### Where the precedent stops: we have no cache to protect

ESI, donut caching and server islands all exist to keep the *other* 95% of a page
cacheable. `/doc/[slug]` is `gated()` and per-request dynamic — as the actions file says
in defending its no-`revalidatePath` rule, there is nothing cached to invalidate. **So the
famous justification for deferring the fragment does not apply here.** What justifies it
is delivery: there is no push channel (deliberately), and the mutators are elsewhere — a
part added on another doc, an Edit from `/links`, a second tab. Arriving at a page is
precisely the moment the client cannot know what happened while it wasn't looking.

Two consequences:

- **Don't reach for PPR / Cache Components here.** It is the current mainstream answer for
  the caching case, and Next's own guidance now prefers it to a post-hydration fetch — but
  it would buy nothing on a route that was never static, and it still cannot deliver an
  update *after* the render, which is the actual requirement.
- **Don't let a reader infer that these routes could be cached.** They can't, and the
  store is not evidence that they could be.

### What is genuinely unusual: hand-rolling it

Most Next.js apps reach for SWR or TanStack Query at this point; this is ~100 lines
instead, consistent with `test:unit`'s no-new-dependency stance and with a surface this
small. The cost is owning invalidation semantics ourselves. `cancelRefetch`'s hazard is
handled; these neighbours are **unimplemented rather than decided against**, each with its
own trigger:

- **No retry.** The `.catch(() => {})` is quiet by design — the next notify re-reads — but
  a load that fails with no notify afterwards leaves the tray blank until a navigation.
  Trigger: anyone reporting a tray that "lost" its parts and got them back by reloading.
- **No cross-tab sync.** The notify channel is module scope, so two tabs of the same
  viewer don't tell each other; each finds out on its own next page load. Trigger: a part
  added in one tab that a second tab keeps painting stale. `BroadcastChannel` is the fix.
- **No revalidate-on-focus.** Nothing re-reads when a backgrounded tab comes forward.

Reach for a library at the *second* such store, not to retrofit this one.

### Packaging the round trips

Measured 2026-09-10 on the dev database, a throwaway client with
`log: [{ emit: "event", level: "query" }]` counting statements — the shapes, not the
timings, which are meaningless over a loopback socket. What each option actually does:

| approach | statements | what it is for |
|---|---|---|
| `findFirst` + `select` of a to-many | **2** | today's default |
| same, `relationLoadStrategy: "join"` | **1** | one LATERAL JOIN, `__prisma_data__` aggregated in Postgres |
| `Promise.all([a, b])` | 2 | *concurrency*, not batching — two connections from the pool |
| `prisma.$transaction([a, b])` | **3** | atomicity — it *adds* a `COMMIT` round trip |
| one `$queryRaw` with subselects | **1** | arbitrary unrelated payloads in one statement |

Three things follow.

- **`$transaction([…])` is not a batching primitive**, whatever the array form suggests.
  It buys a consistent snapshot across the queries and costs a round trip for the commit.
  Reach for it when two reads must agree, never to make two reads cheaper.
- **`relationLoadStrategy: "join"` would collapse `loadMyOpenLink` to a single statement —
  and is deliberately not taken (2026-09-10).** See "The join strategy, deferred" below.
- **A single `$queryRaw` is the only thing that can package *unrelated* payloads** — a doc
  and an open link have no relation for Prisma to join through, so subselects returning
  `row_to_json` are the mechanism. It is also the option to reach for last here: it hands
  back `unknown`, so the result needs parsing on the way out (this file's rule about never
  casting a blob applies to a query result too), and it goes around `prisma.ts`'s
  soft-delete `$extends` — the extension exists precisely so a new query site *can't*
  forget the filter, and raw SQL is a query site that always forgets.

**But note what it cannot reach.** The doc query and the open-link query are not in the
same request to begin with: the page render is one HTTP request and the store's read is a
later server action. Packaging them together means first moving the read into the page
render — the seed discussed above — which trades an HTTP round trip for a DB one and
brings back the two-delivery-path cost. So the batching worth doing is *within*
`loadMyOpenLink`, which needs no architectural change at all.

**And note the ceiling.** Everything above is one statement per round trip: the
`@prisma/adapter-pg` driver rides node-postgres, which has no libpq-style pipeline mode,
and `$queryRaw` uses the extended protocol, which refuses multiple statements per message.
There is no way to hand Postgres a pile of independent queries in one message from here —
only ways to write fewer, larger ones. Over a loopback socket none of this is measurable;
it is worth caring about on the day the database stops being on the same box (DEPLOY.md).

### The join strategy, deferred

**Decided 2026-09-10: `loadMyOpenLink` stays at four statements, because the one-statement
version costs a preview feature.** Recorded here with the measurement and the recipe so
the decision can be re-taken cheaply, not re-derived.

What it buys, measured rather than assumed: `relationLoadStrategy: "join"` on the existing
`findFirst` emits one LATERAL JOIN with the anchors aggregated into `__prisma_data__` by
Postgres — 1 statement instead of 2, same parts back. Fold the part labels in as relations
on `anchors` (`doc: { select: { title: true } }`, `file: { select: { title: true } }`)
instead of the separate `findMany` + `Map`, and the whole read is **1 statement instead of
4**, with no hand-written SQL and no loss of typing. That is a better shape than anything
`$queryRaw` could give, and it is why this is the option worth revisiting first.

What it costs: `relationJoins` is **still a preview feature in Prisma 7.9** — verified in
the CLI build, where `isPreviewFeatureOn("relationJoins")` is the condition that adds
`relationLoadStrategy` to the generated query-arg types at all. So although the strategy is
opt-in *per query*, enabling it is a **generator-wide** `previewFeatures` edit: a preview
flag riding in `schema.prisma`, and every model's arg types changing, for the benefit of
one query whose round trips are unmeasurable over a loopback socket. Not a trade worth
making today.

Revisit when any of these lands, in rough order of likelihood:

- **`relationJoins` goes GA** — then the flag disappears and this is a two-line change.
- **The database stops being on the same box** (DEPLOY.md): three saved round trips per
  page load stop being theoretical the moment they cross a network.
- **A second query site wants it** — one preview flag for one query is a bad trade; for a
  pattern it is an ordinary one.

The recipe, in order: `previewFeatures = ["views", "relationJoins"]`, then
`npm run check:schema` (the whole-file rewrite rule — read what `prisma format` touched
outside your block), then `npx prisma generate` with the dev server stopped (the EPERM
rule), then `relationLoadStrategy: "join"` on the `findFirst`. If the label relations go in
too, **confirm the fallback first**: today's `titles.get(…) ?? "(no longer available)"`
fires when the row is *absent*, and a nullable relation reaches the same outcome by a
different route — the case to check by hand is a part whose target has since been
soft-deleted, which is not the same case as a target that was hard-deleted.

This section's numbers came from a throwaway probe with the flag temporarily on; the flag
was reverted and `schema.prisma` is unchanged in git.

### Open question

Whether a client-side nav between two reading routes triggers an extra read. The store
refetches whenever its listener count goes 0 → 1, and the old route's tray plausibly
unmounts before the new one mounts — but that was reasoned from `subscribe()`, never
measured. Worth confirming before anyone optimizes against the per-load cost. The
module-scope cache means it would be invisible either way: the previous answer renders
immediately while the re-read is in flight.
