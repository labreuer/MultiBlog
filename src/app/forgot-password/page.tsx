"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset, type ForgotPasswordState } from "@/app/actions/forgot-password";
import styles from "@/styles/account.module.css";

const initialState: ForgotPasswordState = {};

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initialState);

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Forgot password</h1>
        {state.message ? (
          <p>{state.message}</p>
        ) : (
          <form action={formAction} className={styles.form}>
            <label className={styles.field}>
              Email
              <input name="email" type="email" required autoComplete="email" />
            </label>
            {state.error && <p className={styles.error}>{state.error}</p>}
            <button type="submit" disabled={pending} className={styles.button}>
              {pending ? "Sending..." : "Send reset link"}
            </button>
          </form>
        )}
      </div>
      <div className={styles.links}>
        <p>
          <Link href="/sign-in">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
