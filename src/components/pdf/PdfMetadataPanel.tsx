import type { ReactNode } from "react";
import styles from "./PdfPanes.module.css";

// PLAN.md §20d — the Metadata tab of /pdf/[slug]'s side panel.
//
// It exists because of where the keyword strip *can't* go. Every other object
// page scrolls, so a strip under the byline costs one line of a page that is
// already long. /pdf/[slug] is a full-viewport app shell whose whole point is
// that the viewer fills the height — so a strip above it took that room from
// the document permanently, on every file, tagged or not.
//
// `children` is server-rendered: the page passes `<KeywordChips>` in as a prop
// rather than this module importing it, which is what lets a Server Component
// reach inside an `ssr: false` island at all (PdfSurfaceClient's header).
//
// Keywords are all it holds today. The tab is named for the category rather
// than for its one occupant because the file's own facts — size, page count,
// uploader, visibility — belong here too when they're wanted, and a tab reading
// "Keywords" would have to be renamed to take them.

export default function PdfMetadataPanel({ children }: { children: ReactNode }) {
  return <div className={styles.pane}>{children}</div>;
}
