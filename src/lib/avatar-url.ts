// The browser-safe half of the avatar feature (PLAN.md §17n): the URL shape,
// the stored size, and the precedence rule. Deliberately its own module
// rather than living in avatar.ts:
// ContributorCard builds these URLs and is imported by ContributorPanel,
// which is `"use client"` — so ContributorCard is compiled into the client
// bundle too, and anything it imports must be browser-safe. avatar.ts pulls
// in `sharp` and `node:crypto` and is server-only.
//
// The hash in the path is what makes the served bytes immutable: replacing
// an avatar changes its content hash and therefore its URL, so the route
// handler can answer `Cache-Control: immutable` without ever risking a
// stale image.
export function avatarUrl(userId: string, hash: string): string {
  return `/api/avatar/${userId}/${hash}`;
}

/**
 * Square edge length stored and served, in px. 4× the 40px card slot, so one
 * stored size also covers the dashboard preview and 2× displays without a
 * second variant — which is what lets the render path skip `next/image`
 * entirely (see ContributorCard's eslint-disable rationale).
 *
 * Lives here rather than in avatar.ts so the client bundle can read it for
 * the `width`/`height` attributes without pulling in sharp.
 */
export const AVATAR_SIZE = 160;

/**
 * Edge length the client-side cropper exports at (PLAN.md §17n) — 2× the
 * stored size, deliberately. The canvas does the *crop*; sharp does the final
 * reduction to AVATAR_SIZE with a proper resampling kernel, which is better
 * than asking `drawImage` to do the whole downscale from a phone photo.
 */
export const AVATAR_EXPORT_SIZE = AVATAR_SIZE * 2;

// There is deliberately no upload-size constant, here or anywhere. The cropper
// uploads a fixed AVATAR_EXPORT_SIZE square of tens of KB whatever the source
// was, so there is nothing for the browser to check; Next's 1MB Server Action
// bodySizeLimit backstops a hand-crafted POST; and what actually bounds
// ingestion cost is the pixel ceiling in avatar.ts, not a byte count.

/**
 * Resolves what a contributor's avatar `src` should be, in precedence order:
 * the self-hosted upload, then the Auth.js adapter's remote `User.image`
 * (populated by an OAuth provider's profile, PLAN.md §17n), then null — at
 * which point the caller renders the colored initials circle instead.
 *
 * The remote fallback is the one path that still makes a visitor's browser
 * talk to a third party. Nothing populates it today (only Credentials is
 * configured, src/lib/auth.ts), so it is dormant rather than a live privacy
 * cost — but it is why "self-hosted avatars" is not the same claim as "no
 * third-party image requests are possible".
 */
export function resolveAvatarSrc(opts: {
  userId: string;
  avatarHash: string | null | undefined;
  image: string | null | undefined;
}): string | null {
  if (opts.avatarHash) {
    return avatarUrl(opts.userId, opts.avatarHash);
  }
  return opts.image ?? null;
}
