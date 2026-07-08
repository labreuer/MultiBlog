"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUp, type SignUpState } from "@/app/actions/sign-up";

const initialState: SignUpState = {};

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUp, initialState);

  return (
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Create account</h1>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Name
          <input name="name" type="text" autoComplete="name" />
        </label>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Sign up"}
        </button>
      </form>
      <p>
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </main>
  );
}
