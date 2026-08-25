"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { canManagePosts, canManageDocs, canManageFiles, isAdmin } from "@/lib/role-checks";
import { SITE_TITLE } from "@/lib/site-config";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import styles from "./SiteHeader.module.css";

export default function SiteHeader() {
  const { data: session } = useSession();
  const postsMenuRef = useRef<HTMLDetailsElement>(null);
  const docsMenuRef = useRef<HTMLDetailsElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideClick(postsMenuRef, docsMenuRef);

  // The dropdown panels are position: fixed (SiteHeader.module.css), so their
  // coordinates have to be set by hand. Measured off .navGroup rather than the
  // caret's <summary> so the panel's left edge lines up with the group's own
  // link — the alignment the panel's containing block used to give for free,
  // back when it was absolutely positioned.
  function placePanel(details: HTMLDetailsElement | null) {
    if (!details?.open) return;
    const group = details.parentElement;
    const panel = details.querySelector<HTMLElement>(`.${styles.dropdownPanel}`);
    if (!group || !panel) return;
    const rect = group.getBoundingClientRect();
    panel.style.top = `${rect.bottom + 4}px`;
    panel.style.left = `${rect.left}px`;
  }

  // A fixed panel doesn't travel with the row it belongs to, so re-place it
  // whenever anything moves that row. Closing the menu instead was the first
  // attempt and is subtly wrong: scrolling an element into view *before*
  // clicking it queues a scroll event that lands after the click, so a menu
  // could shut the instant it opened. placePanel no-ops unless the menu is
  // open, so this costs a pair of early returns per scroll event otherwise.
  useEffect(() => {
    const scroller = scrollerRef.current;
    function placeOpen() {
      placePanel(postsMenuRef.current);
      placePanel(docsMenuRef.current);
    }
    scroller?.addEventListener("scroll", placeOpen, { passive: true });
    window.addEventListener("scroll", placeOpen, { passive: true });
    window.addEventListener("resize", placeOpen);
    return () => {
      scroller?.removeEventListener("scroll", placeOpen);
      window.removeEventListener("scroll", placeOpen);
      window.removeEventListener("resize", placeOpen);
    };
  }, []);

  // Built as a list and joined with separators rather than each block carrying
  // its own leading "|", so the bars stay correct whatever combination of
  // permissions is present — including the one the brand already renders.
  const leftNav: { key: string; node: ReactNode }[] = [];
  if (session?.user && canManagePosts(session.user.role)) {
    leftNav.push({
      key: "posts",
      node: (
        <span className={styles.navGroup}>
          <Link href="/posts">Posts</Link>
          <details
            ref={postsMenuRef}
            className={styles.dropdownWrapper}
            onToggle={() => placePanel(postsMenuRef.current)}
          >
            <summary className={styles.dropdownSummary} aria-label="Post tools">
              ▾
            </summary>
            <div className={styles.dropdownPanel}>
              <Link href="/comments">Comments</Link>
            </div>
          </details>
        </span>
      ),
    });
  }
  if (session?.user && canManageDocs(session.user.role)) {
    leftNav.push({
      key: "docs",
      node: (
        <span className={styles.navGroup}>
          <Link href="/docs">Docs</Link>
          <details
            ref={docsMenuRef}
            className={styles.dropdownWrapper}
            onToggle={() => placePanel(docsMenuRef.current)}
          >
            <summary className={styles.dropdownSummary} aria-label="Doc tools">
              ▾
            </summary>
            <div className={styles.dropdownPanel}>
              <Link href="/annotations">Annotations</Link>
              {/* PLAN.md §20d — beside Annotations rather than as a top-level
                  entry. Both are cross-cutting views *over* content rather
                  than content itself, and both are gated on canManageDocs, so
                  the group is already the right shape. A tag spans posts
                  and files too, which argues for top level — but a nav entry
                  earns top level by how often it is the destination, and a
                  vocabulary table is somewhere you go to curate, not to read.
                  AUTHORIZED users, who may apply tags but not open this
                  table, reach terms through the chips instead. */}
              <Link href="/tags">Tags</Link>
            </div>
          </details>
        </span>
      ),
    });
  }
  if (session?.user && isAdmin(session.user.role)) {
    leftNav.push({ key: "users", node: <Link href="/users">Users</Link> });
  }
  // PLAN.md §19 — asked for as "to the right of Users", and placed here so it
  // is, *for an ADMIN*. Users is ADMIN-only while Files is AUTHOR-and-up, so
  // for an EDITOR or AUTHOR there is no Users entry for it to sit right of and
  // it simply follows Docs. The literal position can't hold for every role;
  // the order can.
  if (session?.user && canManageFiles(session.user.role)) {
    leftNav.push({ key: "files", node: <Link href="/files">Files</Link> });
  }
  if (session?.user && isAdmin(session.user.role)) {
    leftNav.push({ key: "site-settings", node: <Link href="/site-settings">Site Settings</Link> });
  }

  return (
    <header className={styles.header}>
      {/* Outside .scroller, so it stays put while the rest of the row moves. */}
      <div className={styles.brand}>
        <Link href="/" className={styles.brandLink}>
          {SITE_TITLE}
        </Link>
        {leftNav.length > 0 && (
          <span aria-hidden="true" className={styles.separator}>
            |
          </span>
        )}
      </div>

      <div ref={scrollerRef} className={styles.scroller}>
        <div className={styles.scrollRow}>
          <div className={styles.navLeft}>
            {leftNav.map((item, i) => (
              <Fragment key={item.key}>
                {i > 0 && (
                  <span aria-hidden="true" className={styles.separator}>
                    |
                  </span>
                )}
                {item.node}
              </Fragment>
            ))}
          </div>

          <nav className={styles.navRight}>
            <form action="/search">
              <input type="search" name="q" placeholder="Search…" style={{ padding: "0.3rem 0.5rem" }} />
            </form>
            {session?.user ? (
              <>
                <Link href="/dashboard">{session.user.name ?? session.user.email}</Link> /{" "}
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
        </div>
      </div>
    </header>
  );
}
