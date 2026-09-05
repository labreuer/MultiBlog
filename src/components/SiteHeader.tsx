"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { canManagePosts, canManageDocs, canManageFiles, isAdmin } from "@/lib/role-checks";
import { SITE_TITLE } from "@/lib/site-config";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import { fixedPlacementStyle, onViewportChange } from "@/lib/popover-placement";
import { signInPath } from "@/lib/sign-in-redirect";
import styles from "./SiteHeader.module.css";

// The dropdown panels are position: fixed (SiteHeader.module.css), so their
// coordinates have to be set by hand. Measured off .navGroup rather than the
// caret's <summary> so the panel's left edge lines up with the group's own
// link — the alignment the panel's containing block used to give for free,
// back when it was absolutely positioned.
//
// Written even while the menu is still closed (each summary's onClick
// below), not only from onToggle: <details> renders its panel the instant
// the click's default action flips `open`, but the toggle event arrives in a
// queued *task*, and the browser may paint a frame in between — and a fixed
// panel with no top/left yet paints that frame at its static position inside
// the nav row. Only the first open of a page load can show it (the inline
// coordinates persist across closes, and a reopened panel's stale ones are
// almost always still right), and mostly when the main thread is busy enough
// for a paint to win the race — which is why it surfaced as a first-click
// flash right after a hard reload. The click handler runs before the default
// action, so the first open's first paint already has real coordinates. The
// rect is the navGroup's, which the hidden panel doesn't affect, so
// measuring while closed is sound.
//
// Module scope, not component closures: both read nothing but the DOM at
// call time (same pattern as DocReadingBody's jumpToAnnotationEntry), which
// also keeps them out of the scroll/resize effect's dependency story.
function setPanelCoords(details: HTMLDetailsElement | null) {
  const group = details?.parentElement;
  const panel = details?.querySelector<HTMLElement>(`.${styles.dropdownPanel}`);
  if (!group || !panel) return;
  const rect = group.getBoundingClientRect();
  // Through the shared helper because the panel is `position: fixed` and the
  // rect is visual-viewport-relative — the two spaces come apart on iOS with
  // a keyboard up (docs/mobile/coordinates.html). **Defensive, not an
  // observed bug**: the tap that opens this panel is the tap that dismisses
  // the keyboard, so the shift measures 0 in every case reachable today.
  const placed = fixedPlacementStyle({ top: rect.bottom + 4, left: rect.left });
  panel.style.top = `${placed.top}px`;
  panel.style.left = `${placed.left}px`;
}

// The open-only variant for the paths where a closed menu has nothing to
// keep in place: toggle (which also fires on close), scroll and resize.
function placePanel(details: HTMLDetailsElement | null) {
  if (!details?.open) return;
  setPanelCoords(details);
}

export default function SiteHeader() {
  const { data: session } = useSession();
  // Sends "Log in" back to whatever page the reader is on, so the header agrees
  // with the gates (which supply their own callbackUrl via signInPath). Pathname
  // only: `useSearchParams` would opt every page mounting this header out of
  // static rendering unless wrapped in Suspense, which is precisely the cost
  // this header exists to avoid (src/app/sign-in/NOTES.md, CACHING.md).
  // `usePathname` carries no such bailout. `signInPath` drops /sign-in itself
  // and the other account pages, so the link never loops back to where it is.
  const pathname = usePathname();
  const postsMenuRef = useRef<HTMLDetailsElement>(null);
  const docsMenuRef = useRef<HTMLDetailsElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  useCloseOnOutsideClick(postsMenuRef, docsMenuRef);

  // Picking an entry closes the menu, which nothing else here would do: a
  // <details> toggles only from its own <summary>, useCloseOnOutsideClick
  // deliberately ignores clicks *inside* the panel, and this component is
  // mounted in the root layout — so a <Link> navigates client-side without
  // ever unmounting it, and the menu would ride along to the page just
  // chosen. Setting .open on the node rather than holding it in state for the
  // same reason that hook does: nothing renders off it.
  function closeMenu(details: HTMLDetailsElement | null) {
    if (details) details.open = false;
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
    // window scroll/resize plus the visualViewport events a keyboard fires
    // instead; the scroller above is separate and keeps its own listener.
    const stop = onViewportChange(placeOpen);
    return () => {
      scroller?.removeEventListener("scroll", placeOpen);
      stop();
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
            <summary
              className={styles.dropdownSummary}
              aria-label="Post tools"
              onClick={() => setPanelCoords(postsMenuRef.current)}
            >
              ▾
            </summary>
            <div className={styles.dropdownPanel}>
              <Link
                href="/comments"
                className={styles.dropdownItem}
                onClick={() => closeMenu(postsMenuRef.current)}
              >
                Comments
              </Link>
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
            <summary
              className={styles.dropdownSummary}
              aria-label="Doc tools"
              onClick={() => setPanelCoords(docsMenuRef.current)}
            >
              ▾
            </summary>
            <div className={styles.dropdownPanel}>
              <Link
                href="/annotations"
                className={styles.dropdownItem}
                onClick={() => closeMenu(docsMenuRef.current)}
              >
                Annotations
              </Link>
              {/* PLAN.md §20d — beside Annotations rather than as a top-level
                  entry. Both are cross-cutting views *over* content rather
                  than content itself, and both are gated on canManageDocs, so
                  the group is already the right shape. A tag spans posts
                  and files too, which argues for top level — but a nav entry
                  earns top level by how often it is the destination, and a
                  vocabulary table is somewhere you go to curate, not to read.
                  AUTHORIZED users, who may apply tags but not open this
                  table, reach terms through the chips instead. */}
              <Link
                href="/tags"
                className={styles.dropdownItem}
                onClick={() => closeMenu(docsMenuRef.current)}
              >
                Tags
              </Link>
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
                <Link href={signInPath(pathname)}>Log in</Link> /{" "}
                <Link href="/sign-up">Sign up</Link>
              </>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
