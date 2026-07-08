"use client";

import { useActionState } from "react";
import Link from "next/link";
import { resetPassword, type ResetPasswordState } from "@/app/actions/reset-password";

const initialState: ResetPasswordState = {};

export default function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(resetPassword, initialState);

  if (!token) {
    return (
      <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Reset password</h1>
        <p>
          This reset link is missing a token. Request a new one from the{" "}
          <Link href="/forgot-password">forgot password</Link> page.
        </p>
      </main>
    );
  }

  if (state.success) {
    return (
      <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Password updated</h1>
        <p>
          Your password has been reset. <Link href="/sign-in">Sign in</Link>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Reset password</h1>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="hidden" name="token" value={token} />
        <label>
          New password
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Resetting..." : "Reset password"}
        </button>
      </form>
    </main>
  );
}
