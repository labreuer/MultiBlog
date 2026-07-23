"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { canManagePosts, isAdmin } from "@/lib/role-checks";
import { SITE_TITLE } from "@/lib/site-config";

export default function SiteHeader() {
  const { data: session } = useSession();

  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "1rem",
        borderBottom: "1px solid #ddd",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Link href="/" style={{ fontWeight: "bold", textDecoration: "none", color: "inherit" }}>
          {SITE_TITLE}
        </Link>
        {session?.user && canManagePosts(session.user.role) && (
          <>
            <span aria-hidden="true" style={{ color: "#ccc" }}>
              |
            </span>
            <Link href="/posts">Manage Posts</Link>
            <span aria-hidden="true" style={{ color: "#ccc" }}>
              |
            </span>
            <Link href="/comments">Manage Comments</Link>
          </>
        )}
        {session?.user && isAdmin(session.user.role) && (
          <>
            <span aria-hidden="true" style={{ color: "#ccc" }}>
              |
            </span>
            <Link href="/users">Manage Users</Link>
            <span aria-hidden="true" style={{ color: "#ccc" }}>
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
