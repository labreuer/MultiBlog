"use client";

import { useActionState } from "react";
import Link from "next/link";
import { acceptInvite, type AcceptInviteState } from "@/app/actions/invite";

const initialState: AcceptInviteState = {};

export default function InviteForm({ token, email }: { token: string; email: string | null }) {
  const [state, formAction, pending] = useActionState(acceptInvite, initialState);

  if (!email) {
    return (
      <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Invite</h1>
        <p>
          This invite link is invalid, expired, or has already been used. Ask whoever invited you to send a new one.
        </p>
      </main>
    );
  }

  if (state.success) {
    return (
      <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Password set</h1>
        <p>
          Your account is ready. <Link href="/sign-in">Sign in</Link>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 360, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Claim your account</h1>
      <p>{email}</p>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="hidden" name="token" value={token} />
        <label>
          Choose a password
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Set password"}
        </button>
      </form>
    </main>
  );
}
