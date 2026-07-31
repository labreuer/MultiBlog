"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Sign in via `next-auth/react`'s client `signIn`, not a server action. The
  // root layout's SessionProvider owns the session in client state, and a
  // server action's redirect is a client-side navigation — the layout never
  // remounts, so the provider keeps the `null` it fetched while signed out and
  // SiteHeader stays logged-out until a full page load. The client `signIn`
  // awaits an internal session refetch before resolving, so by the time we
  // navigate the header is already correct.
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
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Signing in..." : "Sign in"}
        </button>
      </form>
      <p>
        No account? <Link href="/sign-up">Sign up</Link>
      </p>
      <p>
        <Link href="/forgot-password">Forgot password?</Link>
      </p>
    </main>
  );
}
