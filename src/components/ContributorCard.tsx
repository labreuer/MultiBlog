import Link from "next/link";
import type { JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer";
import { blurbExtensions } from "@/lib/tiptap-schema";
import { extractText } from "@/lib/diff";
import { orcidUrl } from "@/lib/contributor-links";
import styles from "./ContributorCard.module.css";

export type ContributorCardProps = {
  name: string;
  slug: string;
  image: string | null;
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
export default function ContributorCard({ name, slug, image, color, adminInitials, orcid, website, blurb }: ContributorCardProps) {
  const hasBlurb = blurb && extractText(blurb).trim().length > 0;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary remote avatar URLs, not a fixed asset set (same precedent as UsersTable.tsx's image column).
          <img src={image} alt="" className={styles.avatar} />
        ) : (
          <div className={styles.avatarFallback} style={{ backgroundColor: color }} aria-hidden="true">
            {adminInitials}
          </div>
        )}
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
