import { onAuthorColor } from "@/lib/author-colors";
import styles from "./Avatar.module.css";

export type AvatarProps = {
  /**
   * Already-resolved `src` (resolveAvatarSrc, PLAN.md §17n) — a self-hosted
   * /api/avatar/… path, a remote adapter URL, or null. Resolved by the
   * caller because the dashboard panel renders this against unsaved form
   * state, where there is no row to resolve from.
   */
  src: string | null;
  /** `User.color`, validated to #rrggbb on write, so it's safe inline. */
  color: string;
  /** `User.adminInitials` — the fallback's content. */
  initials: string;
  /** Rendered edge length in px. The stored image is always AVATAR_SIZE (160) square. */
  size: number;
};

// One avatar renderer for every surface that shows one (PLAN.md §17n): the
// contributor sidebar, the dashboard panel's live preview, and an author's
// page. Extracted at the third consumer rather than the second — the same
// "shared so the formatting can't drift" argument AuthorByline makes, and
// here it also keeps the *fallback* rule in one place, which is the part
// that would actually diverge.
export default function Avatar({ src, color, initials, size }: AvatarProps) {
  if (!src) {
    return (
      <div
        className={styles.fallback}
        style={{
          backgroundColor: color,
          color: onAuthorColor(color),
          width: size,
          height: size,
          fontSize: Math.round(size * 0.35),
        }}
        aria-hidden="true"
      >
        {initials}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberately not next/image. A self-hosted avatar is already stored at exactly one size behind a content-hashed immutable URL (src/lib/avatar.ts), so the optimizer would add a hop to re-derive what ingestion produced; the remote-URL fallback would separately need an images.remotePatterns entry per host.
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={styles.avatar}
      style={{ width: size, height: size }}
      // No loading="lazy": every current consumer renders above the fold,
      // where deferring a ~5KB image buys nothing and risks a pop-in. (It
      // also never fired at all in headless Chrome, which would have made
      // this untestable.)
      decoding="async"
    />
  );
}
