"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset, type ForgotPasswordState } from "@/app/actions/forgot-password";

const initialState: ForgotPasswordState = {};

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initialState);

  return (
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Forgot password</h1>
      {state.message ? (
        <p>{state.message}</p>
      ) : (
        <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
          <button type="submit" disabled={pending}>
            {pending ? "Sending..." : "Send reset link"}
          </button>
        </form>
      )}
      <p>
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </main>
  );
}
