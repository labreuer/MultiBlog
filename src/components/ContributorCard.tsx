import Link from "next/link";
import type { JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer";
import { blurbExtensions } from "@/lib/tiptap-schema";
import { extractText } from "@/lib/diff";
import { orcidUrl } from "@/lib/contributor-links";
import Avatar from "./Avatar";
import styles from "./ContributorCard.module.css";

/** Rendered size in the sidebar — a quarter of the stored 160px, so it stays crisp at 2×. */
const CARD_AVATAR_SIZE = 40;

export type ContributorCardProps = {
  name: string;
  slug: string;
  /**
   * Already-resolved avatar `src` (resolveAvatarSrc, PLAN.md §17n) — a
   * self-hosted /api/avatar/… path, a remote adapter URL, or null for the
   * initials fallback. Resolved by the caller rather than here because this
   * component is also rendered from the dashboard panel against unsaved
   * form state, where there is no row to resolve from.
   */
  avatarSrc: string | null;
  color: string;
  adminInitials: string;
  orcid: string | null;
  website: string | null;
  blurb: JSONContent | null;
};

// Renders a single contributor entry — used by the landing page's
// contributor list (src/lib/contributors.ts's rows) and by the dashboard
// panel's live preview (form state, not yet saved). One component for both
// so the preview can't render something merely *resembling* the real thing
// (PLAN.md §17e — the same argument AuthorByline already makes).
export default function ContributorCard({ name, slug, avatarSrc, color, adminInitials, orcid, website, blurb }: ContributorCardProps) {
  const hasBlurb = blurb && extractText(blurb).trim().length > 0;

  return (
    // data-contributor-slug is a test hook, same convention as CommentNode's
    // data-comment-id: the sidebar renders N of these and every one of them
    // can carry an "ORCID iD"/"Website" link, so a spec has to scope to one
    // card before asserting on its links.
    <div className={styles.card} data-contributor-slug={slug}>
      <div className={styles.header}>
        <Avatar src={avatarSrc} color={color} initials={adminInitials} size={CARD_AVATAR_SIZE} />
        <div>
          <div>
            <Link href={`/authors/${slug}`} className={styles.name}>
              {name}
            </Link>
          </div>
          {(orcid || website) && (
            <div className={styles.meta}>
              {orcid && (
                <a href={orcidUrl(orcid)} target="_blank" rel="noopener noreferrer">
                  ORCID iD
                </a>
              )}
              {website && (
                <a href={website} target="_blank" rel="noopener noreferrer">
                  Website
                </a>
              )}
            </div>
          )}
        </div>
      </div>
      {hasBlurb && <div className={styles.blurb}>{renderToReactElement({ content: blurb, extensions: blurbExtensions })}</div>}
    </div>
  );
}
