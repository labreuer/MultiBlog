// The one place the self-hosted avatar URL shape is written down (PLAN.md
// §17n). Deliberately its own module rather than living in avatar.ts:
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
