"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

/**
 * Re-reads the signed-in user from the database and re-issues the session
 * cookie, once per mount.
 *
 * The session is a JWT baked at sign-in and never re-read afterwards
 * (src/app/sign-in/NOTES.md), so a role change doesn't reach an existing
 * session. This is the client half of the fix: the `jwt` callback in
 * `src/lib/auth.ts` refreshes the token from the DB when `trigger === "update"`,
 * and this component is what triggers it. Mounted on /dashboard — the page a
 * promoted user is told to visit, and the one showing their role.
 *
 * Two non-obvious things about `useSession().update`, both in next-auth/react:
 *
 * - It is a **no-op while the provider is still loading** (`if (loading) return`),
 *   which is exactly the state a full page load starts in — hence gating on
 *   `status`, not just on mount.
 * - **It must be called with an argument.** `update()` with none issues a GET
 *   to /api/auth/session, and only a POST sets `trigger: "update"` on the `jwt`
 *   callback (@auth/core's session action keys it off the method). Any defined
 *   value makes it a POST; `{}` is the smallest one, and the callback ignores
 *   the payload — everything it writes comes from the DB, not the client.
 */
/**
 * The update, and one more if the first answered null while the session still
 * reads as live — the effect's last comment says what that second one is for.
 */
const UPDATE_ATTEMPTS = 2;

export default function SessionRefresh() {
  const { status, update } = useSession();
  const router = useRouter();
  const refreshed = useRef(false);

  useEffect(() => {
    if (status !== "authenticated" || refreshed.current) {
      return;
    }
    refreshed.current = true;
    // `update` writes the new cookie and the provider's own cache (so the
    // header re-renders); `router.refresh()` is what re-renders the server
    // components that read `auth()`. If the user is gone the callback returns
    // null and the cookie is cleared — navigate to /sign-in explicitly rather
    // than refreshing into the page's own server-side redirect: under
    // production timing the refresh could race the cookie clearing and
    // re-render a still-authenticated page, leaving a dead session parked on
    // /dashboard (caught by e2e/session-refresh.spec.ts against the prod
    // target). This effect only runs from status === "authenticated", so it
    // can't misfire for a visitor who was never signed in — but a null
    // resolution is not proof of the opposite either, which is what the
    // second request below is for.
    void (async () => {
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt += 1) {
        if ((await update({})) !== null) {
          router.refresh();
          return;
        }
        // **`null` is not the same as "gone".** `update` resolves null both
        // when the session really died and when its request merely failed —
        // next-auth catches the fetch error, logs `ClientFetchError: Load
        // failed`, and returns null either way. And the commonest cause of
        // that failure is ordinary: a navigation started while this POST is in
        // flight aborts it, and this effect runs a few hundred milliseconds
        // after /dashboard mounts, so following any link that soon does it.
        // The page would then throw a perfectly good session at /sign-in; a
        // dropped request on a flaky connection does the same.
        //
        // So ask again, directly, and act only on an answer. If this request
        // fails too — because the navigation that aborted the first is still
        // under way, which is the whole point — say nothing and let the page
        // the reader asked for arrive.
        try {
          const response = await fetch("/api/auth/session");
          if (!response.ok) return;
          // The route answers a bare `null` when there is no session.
          if ((await response.json()) === null) {
            router.push("/sign-in");
            return;
          }
        } catch {
          return;
        }
        // **And a live answer after a null one is not proof of "alive".** Every
        // session GET re-issues the cookie it was sent (sign-in/NOTES.md), and
        // the provider always has one in flight beside the first POST: its
        // `getSession` announces each fetch on a new BroadcastChannel, its own
        // listener in this page hears that and fetches again, and that second
        // GET starts as the first answers — the moment `status` turns
        // "authenticated" and this effect runs. When it answers after the POST
        // that cleared the cookie, the dead session's cookie is back and the
        // GET above reads it. So send the update again: that GET has landed by
        // now — the one above carried its cookie — and nothing is left to undo
        // the second clearing. A POST that merely failed is retried by the same
        // step, which is right for it too.
      }
    })();
  }, [status, update, router]);

  return null;
}
