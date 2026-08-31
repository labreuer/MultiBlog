# Sign-in — notes

Authentication mechanics that don't belong to any one PLAN.md section: how a session is
established, what it carries, and why the sign-in form is wired the way it is. Moved here
from PLAN.md §10 item 1, §12e and §12m on 2026-07-31 — those sections are about roles and
docs, and kept collecting auth detail that had nowhere else to live.

Scope note: this file is **authentication** (establishing a session). It is deliberately not
about **authorization** — `canManagePosts`/`canManageDocs`/`isAdmin`/`canViewDocs`
(`src/lib/role-checks.ts`) are per-surface gates and stay documented with their surfaces
(§3b, §3c, §12e). It is also not about the **collab JWT** (`src/lib/collab-token.ts`,
`signCollabToken`), which is a separate short-lived credential for the Hocuspocus connection
— see §12g and CLAUDE.md.

## What's built

Auth.js (NextAuth) v5 with a credentials provider, `src/lib/auth.ts`. Email + bcrypt
`password_hash` on `user`; no OAuth provider is wired, despite §2's stack table listing
GitHub/Google as optional. Roles come from `User.role`.

Forgot-password flow: single-use hashed tokens, 1h expiry, enumeration-safe (the response
is identical whether or not the address exists, including while a 60s resend cooldown is
active), rate-limited per address. `sendMail()` sends through Resend when configured
(`RESEND_API_KEY`/`MAIL_FROM`) and otherwise logs the link instead — see
[docs/EMAIL.md](../../../docs/EMAIL.md) for the seam's contract, and DEPLOY.md §4 for what
configuring it means in production. `User.emailVerified` is written by `acceptInvite`
(admin-issued email invites, same doc) and by nothing in this file's own flows; it gates
nothing anywhere today.

## The session is a JWT, baked once at sign-in

`session: { strategy: "jwt" }`. The `jwt` callback reads `user` only when it's present —
i.e. exactly once, at sign-in — and copies `id`, `role`, and `color` into the token. Nothing
re-reads the database on ordinary later requests.

**Consequence: a role change doesn't reach an existing session by itself.** Promoting someone
(to `AUTHORIZED`, or anything else) does nothing on its own until they sign out and back in.
A curiosity when roles rarely changed; once promotion *is* the mechanism for granting doc
access it becomes the first support question, with nothing broken to find.

The same staleness has a testing-side face — deleting a `User` row mid-session doesn't sign
that browser out or revoke its role, so "the row is gone" is not proof a test session ended.
docs/BROWSER_PANE.md covers that angle.

## /dashboard refreshes the session from the database

The one place that *does* re-read the DB. `<SessionRefresh />`
(`src/components/SessionRefresh.tsx`) is mounted on `/dashboard` and, once per mount, calls
`useSession().update({})`; the `jwt` callback answers `trigger === "update"` by re-reading
`name`/`email`/`role`/`color` from the user's row and re-signing the token. So "go to your
dashboard" is the whole fix for a promotion that hasn't landed yet — no sign-out, and the
refreshed cookie is then good everywhere, not just on that page.

`/dashboard` rather than everywhere: it's the page a promoted user is pointed at, it already
displays the role, and it's a full DB round trip that has no business running on every
navigation. This is deliberately *not* the granular-permissions work that supersedes the
whole role scheme — it makes the current scheme's staleness fixable by the user rather than
only by signing out.

Three things about it that are easy to get wrong:

- **`update()` with no argument does nothing useful.** `next-auth/react` issues a GET to
  `/api/auth/session` when `data` is `undefined` and a POST otherwise, and `@auth/core`'s
  session action sets `trigger: "update"` only for the POST. `update({})` is the smallest
  call that reaches the callback. The payload itself is ignored — everything written to the
  token comes from the DB, never from the client.
- **`update` is a no-op while the provider is loading** (`if (loading) return`, same file),
  which is exactly the state a full page load starts in. `SessionRefresh` waits for
  `status === "authenticated"` rather than firing on mount.
- **It can't be done from the server component.** Re-issuing the session means setting a
  cookie, and `unstable_update` (like `signIn`/`signOut`) writes through `cookies().set` —
  legal only in a server action or route handler, not during a render. The client `update`
  is also what fixes `SessionProvider`'s cached copy, which `SiteHeader` reads.

The cost is that the first render of `/dashboard` still shows the pre-refresh values; the
`router.refresh()` that follows the update corrects them a beat later. Reading the user row
directly in `page.tsx` would remove that flicker, at the price of a second source of truth
on the page — not worth it while the refresh is this cheap.

If the row is gone (deleted, or soft-deleted — `prisma` filters those out, so both look the
same here) the callback returns `null`, which makes `@auth/core` clear the session cookie
instead of re-signing it. The user is signed out at the same moment they'd otherwise have
been shown a dashboard for an account that can no longer sign in.

Regression coverage: `e2e/session-refresh.spec.ts` drives a promotion and a deletion, and
checks in both cases that the change is still invisible elsewhere until `/dashboard` is
visited.

## Why the form uses client `signIn` — and still keeps a server action

`sign-in-form.tsx` calls `signIn` from `next-auth/react` with `redirect: false` and then
`router.push()`s to the validated `callbackUrl` (or /dashboard — see *Coming back to where
you were* above). It previously used a `"use server"` action wrapping the
server-side `signIn` with `useActionState` — which is the Auth.js v5 / Next.js docs pattern,
and which broke in production on 2026-07-31.

The form nonetheless still carries `action={signInAction}`, for a reason unrelated to
sessions — see *The `action` is load-bearing even though it never runs* below. Read both
sections before touching either half.

The failure: `SiteHeader` is a client component reading `useSession()`, and `SessionProvider`
lives in the **root layout**, above every navigation boundary. A server action's redirect is
a client-side navigation, so the layout never remounts and the provider keeps whatever
session it last fetched. Signing in left the top bar showing "Log in / Sign up" while page
content rendered as authenticated, and it stayed that way across further client-side
navigation — only a full document load fixed it.

Two things in `next-auth/react` make that permanent rather than eventually-consistent:

- `SessionProvider`'s `session` prop is only a `useState` **initializer**. There is no effect
  syncing a later prop change into state, so re-rendering the layout with a fresh session
  changes nothing.
- The refetch path bails out early once it has cached a `null` session
  (`__NEXTAUTH._session === null || …  → return`). Having concluded you're signed out, it
  stops re-checking — a window-focus event won't rescue it either.

Only the *client* `signIn`/`signOut` call the force-refetch path
(`_getSession({ event: "storage" })`), and `signIn` awaits it before resolving. So by the
time `router.push` runs, the header is already correct. `SiteHeader`'s sign-*out* button
always used the client `signOut` (which does a hard `window.location.href` navigation), so
this also makes the two directions symmetric — the server action was the odd one out, and it
was the half that broke.

Regression coverage: `e2e/auth.setup.ts` asserts the header shows "Sign out" right after the
redirect, with no reload. It's the setup project, so it gates the whole suite.

## The `action` is load-bearing even though it never runs

`<form action={signInAction} onSubmit={handleSubmit}>`. With JavaScript on, `handleSubmit`
calls `preventDefault()` and `signInAction` (`src/app/actions/sign-in.ts`) never executes —
so the section above still describes what actually happens for essentially every user. The
`action` is there for the browser that can't run any of it.

**A form with only an `onSubmit` handler submits as GET.** That is the browser default, and
with JavaScript disabled there is nothing to prevent it — so from 2026-07-31 (the commit
above, which removed the server action and with it the form's `method`) until this was
fixed, a no-JS sign-in navigated to `/sign-in?email=…&password=…`. A password in the query
string is in the URL bar, in browser history, in the `Referer` header sent to every
third-party resource the next page loads, and in the access log of every proxy in front of
the app. The sibling forms (`/sign-up`, `/forgot-password`, `/reset-password`) never had the
bug purely because they kept their server actions.

The mechanics worth not re-deriving, both checked against `react-dom` 19.2.8's source rather
than docs:

- **`preventDefault()` genuinely suppresses the action**, and not by luck of ordering.
  React's form-action plugin (`extractEvents$1`) is called *last*, after the `onSubmit`
  listeners are already on the dispatch queue, and the listener it pushes re-reads
  `nativeEvent.defaultPrevented` when its turn comes — passing `null` in the action slot of
  `startHostTransition` when it's set. So there is no double sign-in, and no race.
- **Never also pass `method`/`encType` by hand.** React derives both from
  `action.$$FORM_ACTION` (which Next attaches to a server action reference, and which is
  what makes progressive enhancement work at all) and dev-warns if they're passed too. The
  server-rendered markup is `<form action="" method="POST" enctype="multipart/form-data">`
  plus a hidden action-id field.

`page.tsx` is a server component that reads `?error=1` and seeds the form's initial error,
with the client half split out into `sign-in-form.tsx` — the same shape `/reset-password`
already uses. That split is required rather than stylistic: a failed no-JS sign-in is a
fresh document load, and `useSearchParams()` would never resolve for a browser that can't
run React, so the client component can't be the thing that reads the flag. `signInAction`
redirects with a bare flag and not the submitted email, which would be a smaller version of
the same leak. The cost is that `/sign-in` is now dynamically rendered; it's a form page
that nothing caches, so this is not the class of concern DEPLOY.md §8 and CACHING.md track.

Regression coverage: `e2e/sign-in-nojs.spec.ts` runs with `javaScriptEnabled: false` and
asserts the form's `method`, a working sign-in, and that neither the password nor the string
`password` reaches the URL. `e2e/auth.setup.ts` covers the JavaScript-on path and so is what
would catch the server action firing when it shouldn't.

## Coming back to where you were

Every gated surface sends anonymous visitors to `/sign-in`, and until 2026-08-31
that was the end of the trail: sign-in always finished on /dashboard, so a link to
a doc, a PDF or a filtered admin table lost the thing the reader had clicked.
The destination now travels as `?callbackUrl=`, the Auth.js convention.

`src/lib/sign-in-redirect.ts` owns both ends — `signInPath(returnTo)` for the
gates, `safeCallbackUrl`/`destinationAfterSignIn` for the sign-in page.

**Why each gate builds its own, rather than a middleware doing it once.** The
idiomatic v5 answer is `middleware.ts` with a matcher: NextAuth's own wrapper
then supplies `callbackUrl` for free, and no page changes at all.

Be accurate about what that would have cost, because the tempting wrong answer
is that these gates are too varied for a matcher. **They aren't. All 23 are
"is the viewer signed in", with nothing else in them.** That is not obvious from
reading the five routes that go through `gated()` (`/doc/[slug]`,
`/doc/[slug]/edit`, `/pdf/[slug]`, `/posts/[id]/edit`,
`/side-by-side/[left]/[right]`), which redirect on `access.status ===
"signed-out"` and look like they are consulting the database — but
`src/lib/route-access.ts` returns that status **before** it calls the route's
own `load`. The database only ever decides `forbidden`/`not-found`/`redirect`,
all of which happen after this gate. So `signed-out` is precisely
`!session?.user`, and a matcher could express every one of them.

What middleware genuinely cannot do is *replace* these checks — only precede
them. `gated()` hands the page `access.user`, and the other eighteen read
`session.user.role` on the very next line; the body needs the session object,
not the knowledge that one exists. So the page-level branch survives either way,
and the choice is only about where the *destination* is named:

- Middleware **and** the path literals below: both diffs for one behavior.
  Strictly worse.
- Middleware, with every gate left as a bare `redirect("/sign-in")`: the
  smallest diff. Its cost is that the matcher is a second statement of the route
  tree that nothing typechecks, and drift shows up as a route quietly losing its
  callbackUrl — a degradation rather than a breakage, so nothing surfaces it.
- What's here: the destination is named by the code that decided to redirect,
  and there is nothing to keep in sync. Its cost is 23 call sites.

The last was chosen on drift, not on capability, and it is a preference rather
than a constraint. (The edge-runtime problem — `auth()` pulling in Prisma and
bcryptjs — is real but secondary; Next 16's Node middleware runtime or the
Auth.js split config would answer it.)

So the param is built where the decision is made, from the `params` each page
already holds. The admin tables
additionally carry their querystring (`pathWithQuery`), because filters, sort
and page all live there and dropping it returns the reader to an unfiltered
page 1 of the table they were looking at.

**The `Referer` header is not a shortcut past any of this**, though it looks like
one that would touch a single file. Measured against this app on 2026-08-31, with
a browser observing the `/sign-in` document request:

| how the gate was reached | `Referer` on `/sign-in` |
|---|---|
| direct navigation to `/docs` (pasted, emailed, bookmarked) | *(none)* |
| clicked through from the landing page | `http://…/` — the landing page, not `/docs` |

Following a redirect does not reset the referrer; it inherits the one from the
navigation that caused it. So `Referer` names the page the reader *left*, never
the page they were *going to* — and for the case that motivated this work, a
link that requires login, it is absent entirely. It would also still need
`safeCallbackUrl`, since an inbound header is no more ours than a query param.

The five `redirect("/sign-in")` calls in `src/app/actions/` are deliberately
left bare: they guard *mutations*, and a POST can't be replayed by arriving at
a URL, so there is no destination worth naming.

**The same-origin check is ours, not Auth.js's.** This is the part to not
un-learn. Auth.js validates `redirectTo` in its `redirect` callback — but the
form calls `signIn(..., { redirect: false })` and navigates itself, for the
SessionProvider reason above, so that callback never runs on the path essentially
every user takes. A bare `router.push(callbackUrl)` would therefore make
`/sign-in?callbackUrl=https://evil.example` an open redirect wearing our own
login page. `safeCallbackUrl` rejects anything that doesn't parse to a
same-origin path and returns the *parsed* path, so a caller is never handed a
string the parser disagreed with — which is what disposes of `/\evil.example`,
where WHATWG URL normalises the backslash to a slash and yields a foreign origin
that a `startsWith("//")` test would have missed. It also refuses `/sign-in`
itself and the sibling account pages, so nothing can loop.

The no-JS path carries the destination as a hidden field, since its submit is a
POST; `signInAction` re-validates it (a request body is no more ours than a query
string) and re-attaches it to `?error=1` so a mistyped password doesn't quietly
drop the retry back to /dashboard. The field is rendered only when there *is* a
destination — a defaulted `/dashboard` would otherwise show up in the URL after
every failed sign-in.

`SiteHeader`'s "Log in" link uses the same helper against `usePathname()`, so the
header agrees with the gates. Pathname only: `useSearchParams` would opt every
page mounting the header out of static rendering unless wrapped in Suspense,
which is exactly the cost the next section explains the header exists to avoid.
`usePathname` carries no such bailout.

**The drift this leaves is guarded.** Choosing per-gate over a matcher trades a
path list that can go stale for 23 call sites that can be written wrong — a new
gated route can carry a plain `redirect("/sign-in")` and be correct in every
visible way: it compiles, it lints, it gates, its tests pass, and the only
symptom is that whoever followed the link lands on /dashboard instead of what
they clicked. `npm run check:sign-in`
(`scripts/check-sign-in-redirects.ts`) fails on the bare literal anywhere
outside `src/lib/sign-in-redirect.ts`, which is why that module also owns the
`?error=1` and `?registered=1` URLs — one owner is what lets the guard run with
no allowlist. A gate with genuinely no destination (a mutation guard) calls
`signInPath()` with no argument and says so.

Regression coverage: `e2e/sign-in-callback.spec.ts` (the round trip, the
querystring, and both refused offsite forms), three added cases in
`e2e/sign-in-nojs.spec.ts` (the hidden field, the failed retry, and its absence),
and `src/lib/sign-in-redirect.test.ts` for the input table.

## Why the header isn't server-rendered instead

The more idiomatic v5 fix is to drop `SessionProvider`/`useSession` entirely and read the
session with `auth()` in a server component — Auth.js says as much in its own doc comments
("when using Next.js App Router you should prefer the `auth()` export"). It has no stale-cache
failure mode because there's no client cache.

It's not free here. `auth()` reads cookies, so a root layout calling it forces dynamic
rendering for everything beneath it — which would take the published post pages out of static
generation. That's the class DEPLOY.md §8 has you verify specifically, and the one that 500'd
the first deploy with `DYNAMIC_SERVER_USAGE`; CACHING.md is the standing record. The
client-side provider is what keeps the root layout static, and the cost of that choice is
this file's previous section.

The price paid for it, beyond the above: with no `session` prop passed to `SessionProvider`,
every full page load does a client round-trip to `/api/auth/session`, so the header renders
signed-out for a moment before correcting.

Next 16 removed `experimental.ppr` and the `experimental_ppr` segment config; Partial
Prerendering is now the default App Router behavior under the `cacheComponents` flag. Adopting
that would let a session-reading header sit behind a Suspense boundary without costing static
rendering, at which point the idiomatic fix becomes cheap. A deliberate migration, not a
bolt-on.

## One fix that looks right and isn't

Keeping the server action and adding `revalidatePath("/", "layout")`. It invalidates
server rendering and the router cache, but `SessionProvider` is a client component at a stable
position in the tree, so React reconciles rather than remounts it and its state survives — and
per the initializer-only behavior above, a fresh `session` prop wouldn't help even if the
layout did re-render. Worth knowing so it isn't chased if this resurfaces.
