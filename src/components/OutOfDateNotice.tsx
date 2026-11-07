"use client";

import { useDocPresence } from "@/components/annotation/doc-presence-context";

// What a collab surface shows once the server refused its socket's schema
// version (DocPresenceProvider's `outOfDate`, docs/YDOC.md "A tab whose
// schema is out of date is refused"): this tab runs a bundle from before a
// deploy, the page has stopped updating, and loading it again is the one
// thing the reader can do about it.

/** "reload", styled as the sentence's link. A button, since it goes nowhere: it loads this page again. */
export function ReloadButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      style={{
        font: "inherit",
        color: "var(--link)",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        textDecoration: "underline",
      }}
    >
      reload
    </button>
  );
}

export function OutOfDateNotice() {
  const { outOfDate } = useDocPresence();
  if (!outOfDate) return null;
  return (
    <p role="status" style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: "0.5rem 0" }}>
      This page is out of date, so it has stopped updating — <ReloadButton /> it to continue.
    </p>
  );
}
