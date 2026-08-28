"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signUp, type SignUpState } from "@/app/actions/sign-up";
import styles from "@/styles/account.module.css";

const initialState: SignUpState = {};

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUp, initialState);

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Create account</h1>
        <form action={formAction} className={styles.form}>
          <label className={styles.field}>
            Name
            <input name="name" type="text" autoComplete="name" />
          </label>
          <label className={styles.field}>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label className={styles.field}>
            Password
            <input name="password" type="password" required minLength={8} autoComplete="new-password" />
          </label>
          {state.error && <p className={styles.error}>{state.error}</p>}
          <button type="submit" disabled={pending} className={styles.button}>
            {pending ? "Creating..." : "Sign up"}
          </button>
        </form>
      </div>
      <div className={styles.links}>
        <p>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
