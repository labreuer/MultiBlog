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
// reads this replaces.

// The port half of the fallback, replacing what used to be a hardcoded
// ":1234". Bare COLLAB_PORT is what the *server* binds (server/collab.ts) and
// is not readable client-side at all, so the browser needs its own copy — and
// with one, a second slot can move its collab port without pinning
// NEXT_PUBLIC_COLLAB_URL and losing the host-following above.
//
// Written as a full literal member expression because Next substitutes
// NEXT_PUBLIC_* by textual match at build time: a destructured or computed
// read is not replaced and arrives undefined. `||` rather than `??` because
// an empty or commented-out value substitutes to "", which `??` would pass
// through and produce `ws://host:`.
const COLLAB_PORT = process.env.NEXT_PUBLIC_COLLAB_PORT || "1234";

export function getCollabUrl(): string {
  return process.env.NEXT_PUBLIC_COLLAB_URL ?? `ws://${window.location.hostname}:${COLLAB_PORT}`;
}
