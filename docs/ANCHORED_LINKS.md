# Anchored links — a URL for a set of passages across docs and PDFs

**Status: designed, not built** (2026-08-31). This is the implementation plan; when the
feature lands, rewrite this doc to describe what was built (and record deviations), per the
house convention. UI sketch (six annotated figures, drawn in `globals.css`'s own tokens):
[docs/Anchored_Links.html](Anchored_Links.html).

## Context

An **anchored link** is a hyperlink that refers to one or more text selections of a doc
and/or a PDF — e.g. "these two paragraphs of doc X plus this passage on page 2 of PDF Y" as
a single shareable URL. Decisions already made:

1. **DB-backed**: a link is a database object; the URL carries its id (not a stateless
   self-describing URL).
2. **Cross-surface**: one link may gather selections across several docs/PDFs. Creation
   happens from the reading views `/doc/[slug]` and `/pdf/[slug]` via a draft-link tray that
   persists across navigation; minted hrefs land on one of those two routes with a `?sel=`
   param.
3. **No inline doc marks** — docs use the offsets+version-stamp mechanism (PLAN.md §13o
   reading-view style), PDFs the quads blob. Nothing writes into any ydoc.
4. **Cherry-pick from `part-anchors`** (13 local commits, unmerged): take the small mark-free
   pieces; do NOT depend on its `annotation_anchor` migration/backfill landing.
5. **Per-target visibility** (see "Following a link" below): the banner shows on `?sel=`
   pages even when the viewer cannot read every referenced object — unreadable targets are
   simply omitted, silently.

Architecturally this is a **new consumer family on the §20a/§20b anchor envelope**
(`AnchoredLink` ≈ `TagAssignment` ≈ one act owning 1..n anchor rows ordered by
`part_order`) — exactly what `docs/MULTI_ANCHORING.md` (on the branch) prescribes for a link
between selections. It is also the **first writer of `selector`/`selector_kind`** on main.

Verified facts the design leans on:

- Both reading routes are `gated` — signed-out viewers redirect to `/sign-in` — so every
  viewer has a session (`user.id`, `user.role`); no anonymous-viewer path exists.
- Neither route reads `searchParams` today; both are inherently dynamic, so adding it is
  free (no §12f static-generation hazard).
- `/pdf/[slug]`'s slug-history redirect (`resolveFileParam` → `redirectTo`) drops the
  querystring; the page's redirect arm must re-append `?sel=`.
- `resolveDocParam` is id-first and docs have **no slug history** → mint doc hrefs by id.
- CLAUDE.md's `ssr:false` + `router.refresh()` trap: initial-props delivery is safe; only
  refresh-based delivery is not. This plan uses initial props + self-fetching islands only.

## Two shaping design decisions

- **Each "Add to link" posts its part to the server immediately**, captured and verified
  against its own `atVersion` stamp at that instant. No client-side part bank, so §20l's
  "multi-part capture leans on the freeze" constraint (which cannot hold across pages) never
  applies — each anchor row carries its own `ydocUpdateId`.
- **Draft parts appear only in the tray (as text), never painted on the surfaces.** Painting
  is exclusively the `?sel=` follow path, delivered as initial server props.

## Increment 0 — Cherry-picks from `part-anchors`

- `git cherry-pick b5fa049` ("Give each anchor field one writer…") — **verified clean**: its
  five files have zero drift on main since merge-base `4f92fe6`. Brings
  `deriveDocRangeSelector` (+4 unit tests), `captureAnchorInYdoc` returning
  `{from,to,quotedText,selector}`, new `capturePdfTextAnchor({fileId,rawTarget})`, and
  `postFileAnnotation` refactored onto it (non-breaking). Run `npm run test:unit` after.
- `git checkout part-anchors -- docs/MULTI_ANCHORING.md` + re-add its CLAUDE.md pointer line
  by hand (CLAUDE.md itself conflicts trivially).
- **Reimplement using branch files as templates** (not clean picks):
  - `annotation-highlight-extension.ts` generalization from `e6f1fed`, adapted with
    `kind: "annotation" | "link"` (NOT `e4e1da8`'s array-valued successor — our parts are
    separate rows each keyed by anchor id, singular ranges suffice).
  - `anno-layer.ts` `variant` from `d0a03f5`, adapted as `"link"`.
  - `resolveCaptureStamp(ydocId, atVersion)` (~15 lines from `6a06a2d`'s tags.ts) copied into
    the new actions file; unify if the branch lands.
- **Do not take**: `annotation_anchor` migrations/backfill, multi-part annotation commits,
  pending-extension pluralization, tag part UI.

## Increment 1 — Schema (`prisma/schema.prisma`)

Two models after the tag block; names avoid the existing `DocLink`/`DocLinkGroup` (which
stay untouched, §20i):

```prisma
model AnchoredLink {
  id          String    @id @default(cuid())
  createdById String    @map("created_by_id")
  createdAt   DateTime  @default(now()) @map("created_at")
  mintedAt    DateTime? @map("minted_at")   // null = the creator's open draft
  deletedByUserId String?   @map("deleted_by_user_id")
  deletedAt       DateTime? @map("deleted_at")
  // relations: createdBy, deletedBy, anchors; @@index([createdById])
  @@map("anchored_link")
}

model AnchoredLinkAnchor {
  id     String @id @default(cuid())
  linkId String @map("link_id")
  // target arc + selector columns + stamps + partOrder: VERBATIM from
  // TagAnchor (schema.prisma:1174-1241) under the new owner FK; relations
  // and the five indexes mirror TagAnchor one-for-one (link onDelete: Cascade).
  @@map("anchored_link_anchor")
}
```

Plus back-relations on `User` (×2), `Doc`, `Post`, `StoredFile`, `Annotation`,
`PostPublicationEvent`. Owner gets soft delete (the TagAssignment convention); anchor rows
are hard-delete only (§20b). URL id = the row cuid (no separate token column).

**Migration** (docs/DATABASE.md recipe): `npm run check-ports` → stop dev if up (say so) →
edit schema → `npx prisma format` (read the diff; outside-edit changes are drift, own
commit) → `npx prisma migrate dev --name add_anchored_links --create-only` → hand-append to
the SQL (the add_tags convention, before first apply):

```sql
ALTER TABLE "anchored_link_anchor"
  ADD CONSTRAINT "anchored_link_anchor_one_target_check"
  CHECK (num_nonnulls("doc_id", "post_id", "file_id", "target_annotation_id") = 1);

ALTER TABLE "anchored_link_anchor"
  ADD CONSTRAINT "anchored_link_anchor_selector_columns_check"
  CHECK (("selector_kind" IS NULL)
    = ("anchor_from" IS NULL AND "anchor_to" IS NULL AND "selector" IS NULL));

-- One open draft per user: makes loadMyDraftLink a definite article and the
-- get-or-create race a catchable P2002. (Prisma has no partial-index DSL.)
CREATE UNIQUE INDEX "anchored_link_one_draft_per_user"
  ON "anchored_link" ("created_by_id")
  WHERE "minted_at" IS NULL AND "deleted_at" IS NULL;
```

→ apply → `npx prisma generate` yourself + **restart web and say so** (new-model-in-running-
server gotcha: `prisma.anchoredLink` is `undefined` until restart; typecheck stays green).

## Increment 2 — Read path: `src/lib/anchored-link-data.ts` (new, server-only)

```ts
export type AnchoredLinkPart = { anchorId: string; partOrder: number; quotedText: string;
  from: number | null; to: number | null; selector: AnchorSelector | null };
export type AnchoredLinkTargetGroup = { target: AnchorTarget; label: string; href: string;
  parts: AnchoredLinkPart[] };
export type AnchoredLinkView = { id: string; groups: AnchoredLinkTargetGroup[] };
export async function anchoredLinkForViewer(linkId, viewer: {id; role}): Promise<AnchoredLinkView | null>
```

- Load link (`deletedAt: null`), anchors ordered `[partOrder, id]`. Draft visible to creator
  only. Every jsonb `selector` goes through `parseSelector` — never a cast.
- **Per-target visibility filter** ("Following a link" below has the rule and rationale):
  rebuild each distinct target via `targetFromColumns`; `doc` → `canUserReadDoc`, `file` →
  `canUserReadFile` (soft-delete-filtered lookups; PRIVATE docs keep their no-admin-bypass by
  inheritance). Groups whose target is unreadable, deleted, or of a kind the v1 writer never
  produces (`post`/`annotation`) are **silently omitted** — no placeholder, no count. If no
  group survives, return `null` and callers behave as if `?sel=` were absent.
- `href` per group: doc → `/doc/<docId>?sel=<id>` (**by id** — rename-proof), file →
  `/pdf/<slug>?sel=<id>`. Returned view is BigInt-free (stamps omitted) so it can cross into
  client props.

## Following a link — the visibility rule

**Per-target filtering, not a conjunctive gate.** The banner ("Linked passages") renders on
a `?sel=` page whenever the link resolves at all for this viewer; each target group shows
only if the viewer may read that target, and an unreadable group is omitted with **no
acknowledgment that it exists** — no "N hidden passages", no placeholder row.

This deviates from §20i's pre-declared conjunctive default ("visible only if every target
is"), deliberately. §14c's precedent (side-by-side forbids the whole page if either doc is
unreadable) protects a surface that *jointly renders* two documents; an anchored link's
groups are independent — each is a pointer wearing its own target's existing read predicate,
like `/tag/[slug]`'s three per-type queries. Silent omission leaks nothing: the viewer
cannot distinguish "this link references something I can't see" from "this link references
nothing else." The page's own passages are readable by construction (the route gate already
ran before the banner renders).

Consequences:

- A viewer who can read only the PDF target of a doc+PDF link still gets the PDF page's
  banner, highlights and jump — with no "Also referenced" row.
- The current page's group is always present when the link references it; a `?sel=` naming a
  link that doesn't reference the current page at all still shows the banner with whatever
  readable groups it has (all of them "Also referenced").
- Mint-time copy in the tray says what's true: "Recipients see only the passages they have
  permission to read."

## Increment 3 — Highlight machinery

- `src/lib/annotation-highlight-extension.ts`: `AnnotationAnchorInput` gains
  `kind?: "annotation" | "link"`; state gains `linkRanges: Map<string, AnchorRange>` (keyed
  by anchor row id); new `anchoredLinkAnchorInputs(parts)` + `getAnchoredLinkRanges(state)`.
  One `buildSegments` pass over both kinds (overlap = one segment carrying both classes);
  emits `data-anchored-link-ids` + class `anchored-link-highlight`; link sources excluded
  from the `--thread-color` vote. Link parts ride the existing per-transaction 3-tier
  re-resolve; no drift persistence (re-derive only, like doc-links).
  `decoration-segments.ts` unchanged.
- `src/lib/annotation-click-extension.ts`: mirror `e6f1fed`'s small hunk so link-only spans
  aren't clickable (the banner is the affordance).
- `src/styles/prose.module.css`: `.anchored-link-highlight` + `.pulse` variant using
  `var(--link)` via `color-mix` — tokens only (STYLE.md), distinguishable from the
  author-colored annotation wash.
- `src/components/pdf/anno-layer.ts`: `AnnoLayerEntry.variant?: "link"`; in `appendRects`
  class `annoRect annoRectLink`, **no `dataset.annoId`** (stays out of the click hit-test).
  `PdfAnnotations.module.css`: `.annoRectLink` as an outline in `var(--link)` (composes over
  annotation fills).

## Increment 4 — Server actions: `src/app/actions/anchored-links.ts` (new)

```ts
export type AnchoredLinkPartInput =
  | { kind: "doc-range"; from: number; to: number; quotedText: string }
  | { kind: "pdf-text"; target: unknown };
export async function loadMyDraftLink(): Promise<DraftLinkView | null>
export async function addAnchoredLinkPart(targetKind, targetId, part, atVersion?): Promise<{error?}>
export async function removeAnchoredLinkPart(anchorId): Promise<{error?}>
export async function discardDraftLink(): Promise<void>
export async function mintAnchoredLink(): Promise<{url: string} | {error: string}>
```

- **Create-permission**: signed-in + may read the target (the annotate precedent, not the
  tag one; no extra role floor). Kind parsed via `parseAnchorTargetKind`; `post`/
  `annotation` rejected as deferred.
- Get-or-create draft: find `mintedAt: null, deletedAt: null`; on create, catch P2002 from
  the partial index and re-find.
- Doc part: `ydocIdForDoc` → `resolveCaptureStamp` → `captureAnchorInYdoc` (with
  `docContentExtensions`) → row `{docId, DOC_RANGE, anchorFrom/To, server's quotedText,
  selector, ydocUpdateId}`. Capture failure → error, nothing stored (a link part IS the
  content; never degrade to whole-object — `tagObject`'s stance).
- PDF part: `capturePdfTextAnchor` → row `{fileId, PDF_TEXT, selector: target, quotedText,
  null offsets/stamp}` (the `KNOWN_RESIDUALS` shape check-tag-constraints names as
  intended).
- `partOrder` = current count; remove = draft-owner only, hard delete, no renumbering
  (`orderBy [partOrder, id]` absorbs gaps); discard = hard delete own draft (cascade).
- `mintAnchoredLink`: own draft, ≥1 part → set `mintedAt`; return `appUrl(<part-0 group
  href>)`.
- **No revalidation, deliberately** — both routes are per-request dynamic and the tray
  self-fetches; state this in the file header (contrast `untagObject`).

## Increment 5 — Doc surface follow (`?sel=`)

`src/app/doc/[slug]/page.tsx`: add `searchParams: Promise<{sel?: string}>`; after the gate,
`const link = sel ? await anchoredLinkForViewer(sel, user) : null` (outside the `gated`
memo). This-doc `DOC_RANGE` parts → `anchoredLinkAnchorInputs(...)` **merged into the
existing `annotationAnchors` array** passed to `DocView` (one list, one plugin state, one
resolve pass — no DocView/DocReadingBody prop changes for paint). All surviving groups → the
banner.

`src/components/anchored-link/AnchoredLinkBanner.tsx` (new, client, + module CSS): rendered
above `DocView` in `mainColumn`. Lists this surface's part quotes + links to the other
groups (hrefs carry `?sel=`); dismissible. Per-part click:
`querySelectorAll('[data-anchored-link-ids~="<anchorId>"]')` → scroll+pulse (the
`QuoteThreadHeader.jumpToQuote` pattern verbatim) — doubles as cycle-through-parts. On-load
scroll-to-first: retry the same query ~10×300ms until the read-only editor mounts, then
once. Parts that fail to resolve: listed in the banner, painted nowhere, silently (doc-link
behavior).

**No `/sel/[id]` route** (no RESERVED_SLUGS change): the landing surface is computed at mint
time; a redirect route stays a cheap later addition if minted hrefs ever go stale.

## Increment 6 — PDF surface follow

`src/app/pdf/[slug]/page.tsx`: read `sel`; **fix the redirect arm** to re-append
`?sel=<encodeURIComponent(sel)>` to `access.to` (the slug-history redirect currently drops
the querystring); fetch `anchoredLinkForViewer`; pass the view into `PdfSurfaceClient` →
`PdfAnnotationSurface` (initial-props through `ssr:false` is the safe delivery).

`src/components/pdf/PdfAnnotationSurface.tsx`: new `anchoredLink` prop; this file's
`PDF_TEXT` parts prepended into `entriesForPage` as `{id: anchorId, target, color: "",
variant: "link"}` (before annotation fills — wayfinding yields to discussion). On-load jump
on `ready`: extract the target-based core of `jumpTo` (~line 537, `quadsTopY` +
`jumpDestinationY` destArray) so a bare `PdfTarget` can drive it. Render the shared banner
as an absolutely-positioned overlay in the surface container, with an `onJumpToTarget` prop
replacing the DOM-query jump.

## Increment 7 — Creation UX

- `src/lib/anchored-link-tray-events.ts` (new, tiny): module-scope listener set —
  `onAnchoredLinkChanged(fn)` / `notifyAnchoredLinkChanged()` (the render-listener pattern
  already used in PdfAnnotationSurface).
- **Doc popover**: `AnnotationPopover.tsx` gains optional
  `onAddToLink?: () => Promise<string | null>` (error message or null); when present, an
  "Add to link" button joins the Annotate row, errors through the existing error slot.
  `DocReadingBody` supplies it on reading views only: post `selection.pending`
  {from,to,quotedText,atVersion} via `addAnchoredLinkPart("doc", docId, …)`, then
  `selection.clear()` + `notifyAnchoredLinkChanged()`.
- **PDF popover**: second button beside Annotate in `PdfAnnotationSurface`'s
  `selectionPopover` (the placement `1cf6e51` used for Tag):
  `addAnchoredLinkPart("file", fileId, {kind:"pdf-text", target: popover.target})`, then
  clear popover + selection, notify.
- `src/components/anchored-link/AnchoredLinkTray.tsx` (new, client,
  `data-testid="anchored-link-tray"`): fixed bottom-right island mounted by **both pages as
  a self-fetching sibling** (doc: end of `<main>`; pdf: sibling of `PdfSurfaceClient`).
  Fetches `loadMyDraftLink()` on mount + on every notify — the server row IS the cross-page
  persistence; renders nothing when no draft. Contents: part list (label + ~60-char snippet,
  per-part ✕ → `removeAnchoredLinkPart`), **Copy link** (`mintAnchoredLink()` →
  `navigator.clipboard.writeText` → "Copied" → tray clears; the copied state notes
  "Recipients see only the passages they have permission to read"), **Discard**. Tokens
  only; fixed positioning stays out of both pages' layout math (margin-notes grid, PDF
  viewport).

## Increment 8 — Verification

- `npm run test:unit` (the 4 `deriveDocRangeSelector` cases arrive with the cherry-pick);
  `npx tsc --noEmit`; `npx eslint .`; STYLE.md color-literal grep.
- New `e2e/anchored-links.spec.ts` (fixtures create/delete own rows):
  1. *Create cross-surface + follow*: shared doc + shared test PDF; add a doc part
     ("Add to link" from the selection popover; tray shows 1), navigate to the PDF, add a
     part (tray shows 2 — cross-page persistence proven), Copy link (grant clipboard-read),
     visit the URL: assert an `.anchored-link-highlight` span + banner listing the PDF
     group; click through to `/pdf/…?sel=`: assert `.annoRectLink` + viewer scrolled.
  2. *Per-target filter*: link spanning a PRIVATE doc + shared PDF; `secondUser()` visits
     the PDF URL with `?sel=` — banner and `.annoRectLink` **do** render for the PDF
     passages, but nothing names or counts the private doc's group; visiting the private
     doc's own URL still forbids the page itself (route gate, unchanged).
  - `e2e/db-worker.ts`: cleanup sweep deletes `anchored_link` rows for e2e users.
- Integrity (`scripts/integrity/`): `check-annotation-anchors.ts` gains an
  `anchored_link_anchor` DOC_RANGE replay pass (quote matches at stamp);
  `check-pdf-anchors.ts` gains a PDF_TEXT pass; `check-tag-constraints.ts` gains rolled-back
  probes for both new CHECKs + the partial unique index; README one-liners.
- **Per CLAUDE.md**: stop at typecheck/lint for UI increments, report UI testing deferred;
  ask before committing untested UI. Commit only when asked.

## Increment 9 — Docs

- Rewrite this file as-built; PLAN.md gains a new top-level **§21 "Anchored links"** (opens
  by citing §20a/§20b) or a pointer here, plus a §10 progress item.
- docs/PERMISSIONS.md: create = read-every-target-you-add (annotate precedent); follow =
  per-target read filter with silent omission (recorded as a deliberate deviation from
  §20i's conjunctive default, with the rationale above); draft creator-only.
- CLAUDE.md: extend the "One anchor row shape, per-consumer tables" bullet with
  `anchored_link_anchor` as the third table (one clause, pointer here).

## Suggested commit sequence

1. Cherry-pick `b5fa049` + MULTI_ANCHORING.md → 2. schema/migration/probes → 3. lib
(highlight kind, CSS, anno-layer, data file) → 4. actions → 5. doc follow (testable via
DB-seeded rows before any creation UI exists) → 6. PDF follow + redirect fix → 7. popovers +
tray → 8. e2e + integrity → 9. docs.

## Explicitly deferred

Post targets (`POST_RANGE` has no selector kind), annotation-body targets (arc ready, writer
refuses), multi-page PDF selections (capture is start-page-only today), part roles
(MULTI_ANCHORING: these parts are homogeneous), drift persistence, a `/links` management
table + minted-link deletion UI, editing a link after mint, link labels, a `/sel/[id]`
canonical route.

## Judgment calls flagged

- Feature and table names follow this doc: `anchored_link` / `anchored_link_anchor` (the
  double "anchor" is the envelope's naming convention showing; rename before Increment 1 if
  it grates).
- `mintedAt` timestamp over a status enum; DB-enforced one-open-draft-per-user.
- Parts post immediately (no client bank); draft parts tray-text only, never painted.
- Doc hrefs minted **by id** (docs have no slug history; rename-proof beats pretty).
- URL id = row cuid; param spelled `?sel=`; no short-token column; no `/sel/[id]` route.
- Create-permission = read-the-target, no extra floor.
- Follow-visibility = per-target filter with silent omission — a deliberate deviation from
  §20i's conjunctive default (rationale under "Following a link").
- `resolveCaptureStamp` duplicated locally until `part-anchors` lands; highlight kind named
  `"link"` now, `"tag"` joins mechanically if the branch merges.
