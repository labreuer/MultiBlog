"use client";

import Link from "next/link";
import { useDocPresence } from "@/components/annotation/doc-presence-context";
import { signInPath } from "@/lib/sign-in-redirect";

// What a collab surface shows once a token refresh came back 401
// (DocPresenceProvider's `signedOut`): the page has stopped updating, and
// signing in again is the one thing the reader can do about it. A 403 gets no
// notice here — a reader who lost access can't act on being told, so each
// surface handles that one on its own terms.

/**
 * "sign in again", returning to exactly this page.
 *
 * Only ever rendered after a refused reconnect, which never happens during the
 * server render, so reading `window.location` here can't mismatch on
 * hydration — and unlike `usePathname` it keeps the query string, which on
 * /doc/[slug] can be a scrubbed `?at=` view.
 */
export function SignInAgainLink() {
  return <Link href={signInPath(window.location.pathname + window.location.search)}>sign in again</Link>;
}

export function SignedOutNotice() {
  const { signedOut } = useDocPresence();
  if (!signedOut) return null;
  return (
    <p role="status" style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: "0.5rem 0" }}>
      You&apos;ve been signed out, so this page has stopped updating — <SignInAgainLink />.
    </p>
  );
}
