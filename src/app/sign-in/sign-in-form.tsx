"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSession, signIn } from "next-auth/react";
import { signInAction } from "@/app/actions/sign-in";
import { DEFAULT_SIGN_IN_DESTINATION, withArrivalFragment } from "@/lib/sign-in-redirect";
import styles from "@/styles/account.module.css";

/** The sign-in, and one more if the browser's session is then someone else's. */
const SIGN_IN_ATTEMPTS = 2;

export default function SignInForm({
  initialError,
  callbackUrl,
}: {
  initialError: string | null;
  /** Already through `safeCallbackUrl` in page.tsx; null means "no stated destination". */
  callbackUrl: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState(false);

  // Sign in via `next-auth/react`'s client `signIn`, not the server action the
  // form's `action` points at. The root layout's SessionProvider owns the session
  // in client state, and a server action's redirect is a client-side navigation —
  // the layout never remounts, so the provider keeps the `null` it fetched while
  // signed out and SiteHeader stays logged-out until a full page load. The client
  // `signIn` awaits an internal session refetch before resolving, so by the time
  // we navigate the header is already correct.
  //
  // `preventDefault()` below is what stops the server action from *also* running:
  // React's form-action plugin pushes its listener onto the dispatch queue after
  // the `onSubmit` listeners and re-reads `defaultPrevented` when its turn comes,
  // passing a null action when it's set. So `action` is reached only when there's
  // no React to prevent anything — which is exactly the case it's there for.
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Read the form before any await — `currentTarget` is nulled after one.
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);

    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    // **A sign-in that succeeded is not yet a browser signed in as that
    // person.** Every session GET re-issues the cookie it was sent
    // (NOTES.md, "Every session GET re-issues the cookie"), so one that left
    // before the sign-in and answers after it puts the previous cookie back:
    // the account this browser was already signed in as, or none. So ask whose
    // session the browser holds, and sign in once more if it is not the one
    // just entered — by then that GET has landed and nothing is left to undo
    // the second sign-in. A mismatch that survives the second attempt goes on
    // to the destination regardless, whose own gate answers for whoever
    // arrives: the check can only ever cost a round trip, never a sign-in.
    for (let attempt = 0; attempt < SIGN_IN_ATTEMPTS; attempt += 1) {
      const result = await signIn("credentials", { email, password, redirect: false });
      if (!result || result.error) {
        setError("Invalid email or password.");
        setPending(false);
        return;
      }
      // `broadcast: false`, or the provider hears the fetch and makes another.
      const session = await getSession({ broadcast: false });
      if (session?.user?.email?.toLowerCase() === email.trim().toLowerCase()) {
        break;
      }
    }

    // Leave `pending` set: the button stays disabled through the navigation.
    // `callbackUrl` is already through safeCallbackUrl in page.tsx — it has to
    // be, since `redirect: false` above means Auth.js's own same-origin
    // `redirect` callback never runs on this path. The fragment the reader
    // arrived with rides along (withArrivalFragment says why); the no-JS path
    // below can't see it, and can't run the PDF viewer that reads one either.
    router.push(withArrivalFragment(callbackUrl ?? DEFAULT_SIGN_IN_DESTINATION, window.location.hash));
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Sign in</h1>
        {/* No `method`/`encType` here on purpose: React derives both from the
            function `action` and warns if they're also passed by hand. */}
        <form action={signInAction} onSubmit={handleSubmit} className={styles.form}>
          {/* Only the no-JS path reads this — `handleSubmit` uses the prop. It
              carries the destination across the POST so `signInAction` can hand
              it to `redirectTo`, and re-attach it if the sign-in fails. */}
          {callbackUrl && <input type="hidden" name="callbackUrl" value={callbackUrl} />}
          <label className={styles.field}>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label className={styles.field}>
            Password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          {error && <p className={styles.error}>{error}</p>}
          <button type="submit" disabled={pending} className={styles.button}>
            {pending ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
      <div className={styles.links}>
        <p>
          No account? <Link href="/sign-up">Sign up</Link>
        </p>
        <p>
          <Link href="/forgot-password">Forgot password?</Link>
        </p>
      </div>
    </main>
  );
}
