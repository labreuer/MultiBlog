"use client";

import { useEffect, useRef } from "react";

/**
 * Starts the download the surrounding page is announcing.
 *
 * **`window.location`, never `router.push`.** The href answers with bytes and a
 * `Content-Disposition: attachment`, not an RSC payload — pushing it through the
 * client router is the exact bug this page exists to fix (the router had nowhere
 * to navigate, so the SPA sat on /sign-in looking like the sign-in had failed,
 * while the file downloaded invisibly behind it).
 *
 * Assigning `location` to an attachment URL deliberately does *not* navigate:
 * the browser starts the download and leaves this page on screen, which is what
 * keeps the file's details visible while the bytes arrive.
 *
 * The ref guard is for React's development double-invoke of effects, which
 * would otherwise ask for the file twice.
 */
export default function AutoDownload({ href }: { href: string }) {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.location.href = href;
  }, [href]);

  return null;
}
