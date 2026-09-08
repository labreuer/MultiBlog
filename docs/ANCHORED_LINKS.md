# Anchored links — a URL for a set of passages across docs and PDFs

**Status: built** (2026-08-31). This file began as the implementation plan and is
rewritten as-built per the house convention — "Deviations from the plan" below records
where the build differs from what was designed; the plan text itself lives in this file's
git history (first commit of the `anchored-links` branch). UI sketch, drawn in
`globals.css`'s own tokens: [docs/Anchored_Links.html](Anchored_Links.html).

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
  delivered as initial server props) and the one being *assembled* (the viewer's own
  draft, fetched client-side). They share the highlight and differ in the underline —
  solid vs. dashed; "Painting a draft" below. The draft started tray-only, as text; the
  reason it isn't is that adding a part to a passage you are looking at and seeing
  nothing happen to it reads as a failure.

Origins: `b5fa049` was cherry-picked clean from the `part-anchors` branch (the
one-writer-per-anchor-field refactor: `deriveDocRangeSelector`, `captureAnchorInYdoc`
returning the selector, `capturePdfTextAnchor`); `docs/MULTI_ANCHORING.md` came over
verbatim. The highlight-extension and anno-layer generalizations were **re-expressed from
that branch's commits as templates** (`kind: "link"` where it says `"tag"`), not picked —
its `annotation_anchor` migration/backfill was deliberately not depended on, and
`resolveCaptureStamp` is duplicated into the actions file until that branch lands.

## Schema

Two models after the tag block in `prisma/schema.prisma`, migration
`20260831200826_add_anchored_links`:

- **`anchored_link`** — id (cuid, the URL id), `created_by_id`, `created_at`,
  `minted_at` (null = the creator's open draft), soft-delete pair. Like
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
- **`anchored_link_one_draft_per_user`** — a partial unique index on `(created_by_id)
  WHERE minted_at IS NULL AND deleted_at IS NULL`. This is what makes `loadMyDraftLink` a
  definite article and the get-or-create race a catchable P2002; minting frees the slot,
  which is the whole lifecycle. `scripts/integrity/check-tag-constraints.ts` probes all
  three, in both directions for the index (a second open draft must be refused; a second
  link for a user whose first is *minted* must go in — the WHERE clause is the feature).

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
behave as if `?sel=` were absent. The returned view is BigInt-free by design (stamps
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

The passages already in the viewer's draft are drawn on whichever surface they belong
to, so "Add to link" visibly does something to the passage it was invoked on. **Same
highlight as a followed link's, dashed underline instead of solid** (doc:
`anchored-link-draft-highlight` over the base class, `border-bottom-style: dashed`; PDF:
`annoRectDraftLink`, `outline-style: dashed`). Both facts are deliberate: it *is* a link
part, so it gets the link wash rather than a colour of its own, and what marks it as
in-progress is the **same dashed underline `.pending-annotation` already uses** for a
composing annotation — one vocabulary for "not committed yet" across the surface, not a
second dash pattern to be learned separately. The two stay distinguishable by colour (the
composing author's own vs. `--link`) and by wash, which is what they already differ in.

- **Only its creator ever sees it.** `loadMyDraftLink` is session-scoped, so there is no
  other viewer's draft to leak and nothing here re-checks anything (`TagChips`' stance).
- **Delivery is client-side, and had to be.** Adding a part revalidates nothing on
  purpose (above), so a server prop would paint one navigation late.
  `src/components/anchored-link/draft-link-store.ts` is **one** module-scope copy of the
  draft shared by every consumer: it subscribes to the tray-events channel on the first
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
- `loadMyDraftLink` therefore returns each part's target, offsets and selector, not just
  its label and quote — still BigInt-free (no `ydocUpdateId`), the same rule
  `anchoredLinkForViewer` follows for the same reason.

## Server actions — `src/app/actions/anchored-links.ts`

`loadMyDraftLink` / `addAnchoredLinkPart` / `removeAnchoredLinkPart` / `discardDraftLink`
/ `mintAnchoredLink`. The load-bearing rules:

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
- `partOrder` = current count at add time; remove is draft-owner-only hard delete with no
  renumbering; discard hard-deletes the draft (cascade). `mintAnchoredLink` requires ≥1
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

The excerpt page (`data-testid="anchored-link-landing"`): "Linked passages", who shared
it and when, then one `<section data-testid="anchored-link-group">` per readable group in
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
rather than the redirect it declined; `check:sign-in` covers the gate like any other.

**Doc follow** (`src/app/doc/[slug]/page.tsx`): reads `searchParams.sel` after the gate,
outside the `gated` memo (it keys on arguments and `generateMetadata` already ran it).
This doc's DOC_RANGE parts merge into the **same `annotationAnchors` array** the
annotations ride — no DocView/DocReadingBody prop changes for paint. All surviving groups
feed `AnchoredLinkBanner` above `DocView`.

**The banner** (`src/components/anchored-link/AnchoredLinkBanner.tsx`, client, shared by
both surfaces, `data-testid="anchored-link-banner"`): this surface's part quotes as jump
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
`data-testid="anchored-link-tray"`): a fixed bottom-right island both pages mount as a
**self-fetching sibling** (doc: end of `<main>`; pdf: sibling of `PdfSurfaceClient`,
outside the `ssr:false` boundary). Reads the shared draft store — which fetches on the
first consumer's mount and on every notify — rather than owning the fetch itself, so the
list and the surface's highlights can never disagree about what is in the draft; renders
nothing without a draft or with an empty one. Part list (label +
~60-char snippet, per-part ✕), **Copy link** (mint → clipboard → "Link copied" note with
the recipients-see-only-what-they-may-read sentence → tray clears; a clipboard-permission
failure still mints and shows the URL as text), **Discard**. Fixed positioning keeps it
out of both pages' layout math.

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
- Integrity, by the one-walk-per-invariant rule: `check-annotation-anchors.ts`'s
  part-anchor walk is now parameterised over both tables (`tag_anchor`,
  `anchored_link_anchor`) and replays DOC_RANGE parts at their stamps;
  `check-pdf-anchors.ts` gains the PDF_TEXT pass (the first selector blob it checks beyond
  annotations); `check-tag-constraints.ts` probes the DDL as above.
  `scripts/integrity/README.md` records the arrangement.

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

## Explicitly deferred

Post targets (`POST_RANGE` has no selector kind), annotation-body targets (arc ready,
writer refuses), multi-page PDF selections (capture is start-page-only today), part roles
(MULTI_ANCHORING: these parts are homogeneous), drift persistence, a `/links` management
table and minted-link deletion UI, editing a link after mint, link labels.

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
