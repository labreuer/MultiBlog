"use client";

// The collab (Hocuspocus) WebSocket URL, resolved against whatever host the
// page was actually loaded from — so the same dev build works whether it's
// opened via localhost or a LAN IP (e.g. testing from a phone on the same
// network) with no restart and no manual switching of NEXT_PUBLIC_COLLAB_URL.
//
// NEXT_PUBLIC_COLLAB_URL still wins when set, which is what a real
// deployment needs (a different host/subdomain, or wss://) — leave it unset
// in .env for local dev so this fallback actually applies; setting it there
// pins every client back to one fixed host, defeating the point.
//
// Client-side only (needs window); every call site is already inside a
// useEffect/client component, same as the process.env.NEXT_PUBLIC_COLLAB_URL
// reads this replaces. Mirrors those reads' own hardcoded ":1234" fallback —
// COLLAB_PORT is a bare (non-NEXT_PUBLIC_) env var, so it isn't readable
// client-side at all.
export function getCollabUrl(): string {
  return process.env.NEXT_PUBLIC_COLLAB_URL ?? `ws://${window.location.hostname}:1234`;
}
