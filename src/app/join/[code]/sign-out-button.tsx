"use client";

import { signOut } from "next-auth/react";
import styles from "@/styles/account.module.css";

export default function SignOutButton({ redirectTo }: { redirectTo: string }) {
  return (
    <button type="button" className={styles.button} onClick={() => signOut({ redirectTo })}>
      Sign out
    </button>
  );
}
