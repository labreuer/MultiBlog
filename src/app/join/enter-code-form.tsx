"use client";

import { useActionState } from "react";
import { enterJoinCode, type EnterCodeState } from "@/app/actions/join";
import styles from "@/styles/account.module.css";

const initialState: EnterCodeState = {};

export default function EnterCodeForm() {
  const [state, formAction, pending] = useActionState(enterJoinCode, initialState);
  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Use a card</h1>
        <form action={formAction} className={styles.form}>
          <label className={styles.field}>
            The code printed on your card
            <input
              name="code"
              type="text"
              required
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX"
            />
          </label>
          {state.error && <p className={styles.error}>{state.error}</p>}
          <button type="submit" disabled={pending} className={styles.button}>
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}
