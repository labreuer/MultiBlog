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
    // target). `update` resolves with the refreshed session, so null is
    // exactly "this session just died"; this effect only runs from
    // status === "authenticated", so it can't misfire for a visitor who was
    // never signed in.
    void update({}).then((session) => {
      if (session === null) {
        router.push("/sign-in");
        return;
      }
      router.refresh();
    });
  }, [status, update, router]);

  return null;
}
