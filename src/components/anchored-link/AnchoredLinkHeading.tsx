"use client";

import { anchoredLinkTitle } from "@/lib/anchored-link-name";
import { useLinkName } from "./open-link-store";

// docs/ANCHORED_LINKS.md, "Naming a link" — the excerpt page's heading, a
// client island for one reason: the tray on the same page can rename the
// link, and the heading follows from the store the tray re-read rather than
// waiting for a navigation (the banner's title does the same). Rendered on
// the server with the server's name — the store has no server snapshot —
// so nothing flashes on hydration.
export default function AnchoredLinkHeading({
  linkId,
  name,
  className,
}: {
  linkId: string;
  name: string | null;
  className?: string;
}) {
  return <h1 className={className}>{anchoredLinkTitle(useLinkName(linkId, name))}</h1>;
}
