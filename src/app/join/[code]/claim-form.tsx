"use client";

import { useActionState } from "react";
import { claimJoinCard, type ClaimState } from "@/app/actions/join";
import styles from "@/styles/account.module.css";

// docs/EMAIL.md §10, steps 2 and 3. The name is required here, unlike on
// /sign-up: it goes on every byline the account is credited on, and its
// comments publish at once under it.

const initialState: ClaimState = {};

const CARD_MESSAGES = {
  claimed: "This card has been used. If its account is yours, sign in.",
  "sends-used": "This card has sent all the email it can. Ask the organizer for another card.",
  unusable: "This card can no longer be used. Ask the organizer for another card.",
} as const;

export default function ClaimForm({ code }: { code: string }) {
  const [state, formAction, pending] = useActionState(claimJoinCard, initialState);
  const result = state.result;

  if (result?.ok && result.delivered) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1>Check your email</h1>
          <p>
            We sent a link to <strong>{result.email}</strong>. Open it and enter the password you just chose, and your
            account is made.
          </p>
          <p style={{ marginTop: "1rem" }}>
            The account won&apos;t exist until you use the link, so signing in before then won&apos;t work. If the
            email above is wrong, scan the card again: that replaces this claim.
          </p>
        </div>
      </main>
    );
  }

  let error: string | null = null;
  if (result?.ok === false) error = "card" in result ? CARD_MESSAGES[result.card] : result.error;
  else if (result?.ok) error = `The email to ${result.email} couldn't be sent. Try again shortly.`;

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>Make your account</h1>
        <p style={{ marginBottom: "1rem" }}>
          We&apos;ll send a link to your email. Your account is made when you open it.
        </p>
        <form action={formAction} className={styles.form}>
          <input type="hidden" name="code" value={code} />
          <label className={styles.field}>
            Your name, as others will see it
            <input
              name="name"
              type="text"
              required
              maxLength={100}
              autoComplete="name"
              defaultValue={state.name}
              key={`name-${state.name ?? ""}`}
            />
          </label>
          <label className={styles.field}>
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              defaultValue={state.email}
              key={`email-${state.email ?? ""}`}
            />
          </label>
          <label className={styles.field}>
            Choose a password
            <input name="password" type="password" required minLength={8} autoComplete="new-password" />
          </label>
          {error && <p className={styles.error}>{error}</p>}
          <button type="submit" disabled={pending} className={styles.button}>
            {pending ? "Sending..." : "Send the link"}
          </button>
        </form>
      </div>
    </main>
  );
}
