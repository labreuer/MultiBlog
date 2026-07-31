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
is identical whether or not the address exists). No email provider is configured —
`sendMail()` is a logging stub, so the reset link is written to the server log rather than
sent. DEPLOY.md §4 covers what that means in production.

## The session is a JWT, baked once at sign-in

`session: { strategy: "jwt" }`. The `jwt` callback reads `user` only when it's present —
i.e. exactly once, at sign-in — and copies `id`, `role`, and `color` into the token. Nothing
re-reads the database on later requests.

**Consequence: a role change doesn't reach an existing session.** Promoting someone (to
`AUTHORIZED`, or anything else) does nothing until they sign out and back in. A curiosity
when roles rarely changed; once promotion *is* the mechanism for granting doc access it
becomes the first support question, with nothing broken to find. Interim fix: say so in the
permission-denied message.

The same staleness has a testing-side face — deleting a `User` row mid-session doesn't sign
that browser out or revoke its role, so "the row is gone" is not proof a test session ended.
CLAUDE.md's *Driving the browser pane* section covers that angle.

**Deferred: re-reading `role` from the DB in the `jwt` callback**, rather than documenting
the sign-out-and-back-in workaround. Waits for the granular-permissions work that supersedes
this whole role scheme.

## Why the form uses client `signIn`, not a server action

`page.tsx` calls `signIn` from `next-auth/react` with `redirect: false` and then
`router.push("/dashboard")`. It previously used a `"use server"` action wrapping the
server-side `signIn` with `useActionState` — which is the Auth.js v5 / Next.js docs pattern,
and which broke in production on 2026-07-31.

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
