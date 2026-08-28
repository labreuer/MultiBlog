"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { signInAction } from "@/app/actions/sign-in";
import styles from "@/styles/account.module.css";

export default function SignInForm({ initialError }: { initialError: string | null }) {
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

    const result = await signIn("credentials", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
      redirect: false,
    });

    if (!result || result.error) {
      setError("Invalid email or password.");
      setPending(false);
      return;
    }

    // Leave `pending` set: the button stays disabled through the navigation.
    router.push("/dashboard");
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Sign in</h1>
        {/* No `method`/`encType` here on purpose: React derives both from the
            function `action` and warns if they're also passed by hand. */}
        <form action={signInAction} onSubmit={handleSubmit} className={styles.form}>
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
