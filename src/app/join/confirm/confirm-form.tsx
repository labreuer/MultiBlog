"use client";

import { useActionState } from "react";
import Link from "next/link";
import { confirmJoinCard, type ConfirmState } from "@/app/actions/join";
import { signInPath } from "@/lib/sign-in-redirect";
import styles from "@/styles/account.module.css";

// docs/EMAIL.md §10, step 6. The password is asked again because whoever
// typed the email at the scan knows it, and someone who only received the
// mail doesn't: a bare Confirm button would let them make an account in
// their own name with a password the typist chose.

const initialState: ConfirmState = {};

export default function ConfirmForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, pending] = useActionState(confirmJoinCard, initialState);
  const result = state.result;

  if (result?.ok) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1>Your account is ready</h1>
          <p>
            <Link href={signInPath("/welcome")}>Sign in</Link> with {result.email} and the password you chose.
          </p>
        </div>
      </main>
    );
  }

  if (result && (result.kind === "no-claim" || result.kind === "claim-ended")) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1>This link can&apos;t be used</h1>
          <p>
            {result.kind === "claim-ended"
              ? "That was the fifth wrong password, so this link no longer works."
              : "It may be older than seven days, or the card was scanned again since, or it has been used."}{" "}
            Scan the card again to get a new link.
          </p>
        </div>
      </main>
    );
  }

  let error: string | null = null;
  if (result?.kind === "wrong-password") {
    error = `That isn't the password chosen when the card was scanned. ${result.left} ${result.left === 1 ? "try" : "tries"} left.`;
  } else if (result?.kind === "refused") {
    error = result.error;
  }

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Confirm your email</h1>
        <p style={{ marginBottom: "1rem" }}>{email}</p>
        <form action={formAction} className={styles.form}>
          <input type="hidden" name="token" value={token} />
          <label className={styles.field}>
            The password you chose when you scanned the card
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          {error && <p className={styles.error}>{error}</p>}
          <button type="submit" disabled={pending} className={styles.button}>
            {pending ? "Confirming..." : "Confirm"}
          </button>
        </form>
      </div>
    </main>
  );
}
