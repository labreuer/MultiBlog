# MultiBlog — Site icons

Favicon and manifest icons: why they're built the way they are, and how to change
them. Originally PLAN.md §17o; moved here once it stopped being a landing-page
design note (§17, "The landing page") and became its own standing reference —
everything below still assumes the rest of PLAN.md §17's context (§17a's ISR
constraints, §17b's env-configured-and-gitignored precedent for the banner, §17n's
avatar pattern) without repeating it. CACHING.md's 2026-08-05 entry covers the
caching side of this design in more depth than the Verification section below.

## Site icons: build-time content hashing, no admin upload, nothing in git

The favicon/manifest icons are deployment content by the same argument PLAN.md
§17b already made for the banner — but they can't use §17b's shape. Two things
about icons specifically rule it out:

**A favicon URL that doesn't change is exactly the failure mode.** Browsers
keep favicons in a separate store from the HTTP cache — Chrome's `Favicons`
SQLite table, keyed by page URL, with its own freshness heuristic — and
"Empty cache and hard reload" doesn't touch it. Verified by trying it: nothing
short of a new URL reliably evicts a stale favicon. So whatever this design
built had to change the *URL* when the art changes, not just the bytes behind
a stable one — which a gitignored `public/favicon.ico` (the §17b shape,
applied naively) would not do.

**The admin-upload design this considered and rejected.** A `SiteIcon`
Prisma table, a `/site-settings` upload panel, and a content-hash route
handler — the avatar pattern (PLAN.md §17n) applied to site identity — would
have solved the freshness problem the same way avatars do. It was rejected
once "changing the icon takes effect on next deploy" became an acceptable
answer: that one relaxation lets the *build* compute the hash instead of a
database row, which is enough machinery cheaper to reach the same guarantee.
The avatar pattern remains the right one for content that must update
without a deploy (§17n's whole point); it was overkill once that constraint
was gone.

### The mechanism: Next already content-hashes file-convention icons

Verified against `next@16.2.11`'s
`next-metadata-image-loader.js`: a file-convention icon
(`src/app/icon.png`, `src/app/apple-icon.png`, and Next's numbered-suffix
convention for a second same-type file, `src/app/icon1.png`) gets a
`?<contenthash>` query appended to its emitted `<link>` href, computed from
the file's own bytes at build time:

```js
const contentHash = loaderUtils.interpolateName(this, '[contenthash]', { context, content })
const hashQuery = contentHash ? '?' + contentHash : ''
```

So changing the art and rebuilding changes the URL every `<link>` on the site
points at — no runtime hashing, no database row, no route handler. This is
the entire mechanism; everything else here is either producing those three
files or handling the two things Next's convention doesn't cover.

**Why these files are gitignored despite living where Next's build reads
them.** `git pull` cannot revert what it never tracked — the same argument
`SITE_BANNER`'s file made in PLAN.md §17b, now applied to files the *build*
consumes instead of files the *runtime* serves. A fresh clone with none of
them present builds and runs fine; Next simply emits no icon `<link>` tags,
the same graceful-when-unset shape as `SITE_BANNER`. `.gitignore` lists
`src/app/icon.png`, `src/app/icon1.png`, `src/app/apple-icon.png`,
`public/favicon.ico`, `public/icons/`, and `site-icons/` (the source art) —
the last two are `public/` paths precisely because the next two subsections
explain why they can't be file-convention icons themselves.

### `public/favicon.ico`, not `src/app/favicon.ico`

This is the one place a same-looking choice would have silently reopened the
freshness problem this design exists to solve. `resolve-metadata.js`
`unshift`s an `app/favicon.ico` to the *front* of the resolved icon list —
verified in the same version — which would make it a leading candidate
browsers may pick over the hashed `icon.png`. That candidate has no hash and
sits at a permanently stable URL, which is precisely the shape that lands in
Chrome's `Favicons` store and can't be evicted by a hard reload.

Putting the file in `public/favicon.ico` instead means Next emits **no
`<link>` for it at all** — every page's own tags point only at the hashed
files. The bare, unhashed URL still exists and still risks going stale in a
browser's favicon store, but nothing that reads our HTML ever uses it; it
answers only a direct probe of `/favicon.ico` (a feed reader, a bare 404, a
bookmark-bar fallback with no page context to read a `<link>` from).

`git rm --cached src/app/favicon.ico` removed the Next scaffold default that
was tracked there before this design — leaving it would have kept emitting
exactly the unhashed leading `<link>` this subsection avoids.

### `manifest.ts` hashes its own icons; `public/` files get none for free

Only `src/app/`'s file-convention icons go through the loader above.
`public/icons/icon-{192,512}.png` and `maskable-{192,512}.png` — the PWA
"any"/"maskable" renditions a favicon generator would hand you as
`site.webmanifest` entries — are plain static files, hashed by nothing.
`src/app/manifest.ts` (replacing that JSON file, and reading `SITE_TITLE` so
the name isn't a second hardcoded copy of it) computes its own hash per icon
at request time — `createHash("sha256")` over the file bytes, truncated and
appended as `?v=<hash>` — the same shape PLAN.md §17n's `avatarHash` uses,
minus the database: there is no row to store it in, so it's recomputed on
read instead of on write. A missing file resolves to `null` and is dropped
from the `icons` array rather than thrown, so a from-scratch clone gets a
valid manifest with zero icons instead of a 500.

### `scripts/build-icons.ts`: one master in, every rendition out

Takes `site-icons/master.png` (defaulting; overridable by a path argument) —
a square-ish, transparent-background PNG — and derives all seven served
files. Keeping this as a checked-in script rather than hand-exporting the
renditions once is what makes the quality decisions inside it reviewable
numbers instead of an opaque export, and what makes the script reusable
across whatever master art a deployment actually has, rather than tuned to
one:

- **Transparency is kept wherever the consuming platform actually honors
  it, and composited to a solid color only where it doesn't.** Two outputs
  are forced opaque regardless of format support — `apple-icon.png` (iOS
  fills transparent pixels with black rather than the device's real
  background) and the maskable manifest icons (the spec requires a maskable
  icon to fill its full bleed, since the OS's own squircle/circle crop would
  otherwise show a hole through a transparent margin). Every other output
  stays transparent. The color used for the two forced-opaque outputs is
  `--alpha-to-color` (`white` | `black` | a `#rrggbb` hex value; defaults to
  white) — a CLI flag rather than a hardcoded constant, because there's no
  background color this script can pick that's correct for every possible
  master image. `manifest.ts`'s `theme_color`/`background_color` aren't
  derived from this flag automatically; a non-default `--alpha-to-color`
  needs that file's `ICON_PLATE_COLOR` updated by hand to stay consistent.
  Its `THEME_COLOR` is a separate constant and does *not* follow — that one
  is browser/OS chrome color for light-preferring users, an unrelated job
  that merely started out sharing a value with the plate.
- **Whether a given master reads clearly once transparent is a property of
  that artwork, not of this script.** A master with a very dark interior
  fill can end up close to invisible against a dark browser tab strip once
  its background is real transparency rather than a plate — verified with a
  rendered comparison during this feature's development, using the specific
  art on hand at the time. There's no general fix for that in the script
  itself; the options are different source art, or accepting the tradeoff,
  or (if this recurs) reintroducing a plate as another explicit option
  alongside `--alpha-to-color` rather than a silent default.
- **A brightness/saturation lift is applied before compositing**,
  independent of the transparent/opaque decision above — a source image
  with a very dark interior fill halftones into mud at 16–32px regardless of
  what's behind it. `icon1.png` (16px) gets a heavier lift and a tighter
  inset than the 32px derivation, since fine detail mostly disappears at
  that size regardless of treatment; this is a downscale optimized to keep
  the gross silhouette legible, not a redrawn simplified mark. If a given
  master's 16px result still reads as a blob, the fix is a hand-drawn
  replacement dropped directly into that file's path — nothing downstream
  depends on it being script-generated.
- **`apple-icon.png` has its alpha channel stripped entirely** (`flatten()`
  followed by `removeAlpha()` — `flatten()` alone still leaves a
  constant-255 alpha channel in the output, verified) rather than merely
  composited opaque: iOS's own convention expects no alpha channel at all,
  and a composited-opaque-but-still-RGBA PNG is a different thing than one
  with none.
- **The maskable renditions keep the glyph inside roughly the inner 80% safe
  zone** a squircle/circle crop respects, rather than the edge-to-edge
  framing the transparent icons use — artwork that runs to the very edge of
  its own bounding box would otherwise get cropped through by a maskable
  icon with no margin.
- **`.ico` frames are built square** (16/32/48) via a ~40-line hand-rolled
  PNG-in-ICO writer rather than a new dependency — the same PNG-compressed,
  true-alpha ICO shape a real-world favicon.ico inspected during this
  feature's design turned out to use. Worth noting only because a generator's
  *unfixed* `.ico` output inspected during the same design process shipped
  non-square frames (15×16, 29×32, 44×48) from letterboxing one size and not
  the other; building it here means that can't happen silently again.

### Verification

CACHING.md's 2026-08-05 entry covers the caching side of this in more
depth — why favicons don't behave like the other caches that file otherwise
documents (a separate browser-side store keyed by URL, not touched by
clearing the HTTP cache), and the same two verified findings below in that
entry's own words.

`Cache-Control` on the hashed routes turned out to already be conservative —
`public, max-age=0` for both the file-convention icons and `public/`'s static
serving, `must-revalidate` added by Next specifically for the metadata-image
route. That means correctness here doesn't actually depend on the hash (a
browser revalidates every navigation regardless); the hash's only job is
avoiding a redundant fetch once a hash is already cached, which is still worth
having but is not the load-bearing part. Confirmed by inspecting response
headers under `web-prod`, not assumed.

`e2e/icons.spec.ts` asserts the shape rather than pixel content — every
`<link rel="icon"|"apple-touch-icon"|"manifest">` href carries a hash query
and resolves, no such href ever points at bare `/favicon.ico`, the manifest's
own icon URLs each carry `manifest.ts`'s `?v=` hash and resolve, and
`/favicon.ico` itself never 500s. Every assertion is written to also pass
against a from-scratch checkout with `build-icons.ts` never run, since the
whole point of gitignoring the outputs is that such a checkout is a normal
state, not a broken one.

### Deploying and changing the icon

`site-icons/master.png` is `scp`'d to the box once (DEPLOY.md §5, alongside
the first-admin seed step), then `npx tsx scripts/build-icons.ts` before the
first `npm run build`. Changing the icon later is: replace the master, rerun
the script, redeploy — the same "swap the file, rebuild" shape PLAN.md §17b
already established for the banner, minus that shape's "no restart needed
either" property, because a rebuild is unavoidable here (the hash is
computed at build time, not read at request time the way `SITE_BANNER`'s
path is).

**The failure mode this trades in return.** If a tracked `src/app/icon.png`
were ever added upstream, `git pull` would refuse with "untracked working
tree file would be overwritten" — unlikely (nothing about this feature
implies a repo-tracked icon ever should exist), but worth knowing before it's
a confusing first encounter. Also: "clone + build" alone no longer produces a
branded site — `site-icons/master.png` living only on the box and in backups
means DEPLOY.md §9's `pg_dump` cron no longer covers everything a full
recovery needs; the master belongs in whatever `scp`/backup step restores the
box's other untracked deployment content (`.env`, `public/banner.*`).
