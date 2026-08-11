"use client";

import { useRef } from "react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { canManagePosts, canManageDocs, isAdmin } from "@/lib/role-checks";
import { SITE_TITLE } from "@/lib/site-config";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import styles from "./SiteHeader.module.css";

export default function SiteHeader() {
  const { data: session } = useSession();
  const postsMenuRef = useRef<HTMLDetailsElement>(null);
  const docsMenuRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(postsMenuRef, docsMenuRef);

  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "1rem",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Link href="/" style={{ fontWeight: "bold", textDecoration: "none", color: "inherit" }}>
          {SITE_TITLE}
        </Link>
        {session?.user && canManagePosts(session.user.role) && (
          <>
            <span aria-hidden="true" style={{ color: "var(--border-strong)" }}>
              |
            </span>
            <span className={styles.navGroup}>
              <Link href="/posts">Posts</Link>
              <details ref={postsMenuRef} className={styles.dropdownWrapper}>
                <summary className={styles.dropdownSummary} aria-label="Post tools">
                  ▾
                </summary>
                <div className={styles.dropdownPanel}>
                  <Link href="/comments">Comments</Link>
                </div>
              </details>
            </span>
          </>
        )}
        {session?.user && canManageDocs(session.user.role) && (
          <>
            <span aria-hidden="true" style={{ color: "var(--border-strong)" }}>
              |
            </span>
            <span className={styles.navGroup}>
              <Link href="/docs">Docs</Link>
              <details ref={docsMenuRef} className={styles.dropdownWrapper}>
                <summary className={styles.dropdownSummary} aria-label="Doc tools">
                  ▾
                </summary>
                <div className={styles.dropdownPanel}>
                  <Link href="/annotations">Annotations</Link>
                </div>
              </details>
            </span>
          </>
        )}
        {session?.user && isAdmin(session.user.role) && (
          <>
            <span aria-hidden="true" style={{ color: "var(--border-strong)" }}>
              |
            </span>
            <Link href="/users">Manage Users</Link>
            <span aria-hidden="true" style={{ color: "var(--border-strong)" }}>
              |
            </span>
            <Link href="/site-settings">Site Settings</Link>
          </>
        )}
      </div>
      <nav style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <form action="/search">
          <input type="search" name="q" placeholder="Search…" style={{ padding: "0.3rem 0.5rem" }} />
        </form>
        {session?.user ? (
          <>
            <Link href="/dashboard">{session.user.name ?? session.user.email}</Link>{" "}
            /{" "}
            <button
              type="button"
              onClick={() => signOut({ redirectTo: "/" })}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: "inherit",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <>
            <Link href="/sign-in">Log in</Link> / <Link href="/sign-up">Sign up</Link>
          </>
        )}
      </nav>
    </header>
  );
}
