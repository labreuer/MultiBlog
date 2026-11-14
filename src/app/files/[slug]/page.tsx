import type { Metadata } from "next";
import { FileDownloadLanding } from "./landing";

// PLAN.md §19 — where a download of a file's latest version lands someone who
// had to sign in first. The body is landing.tsx's, shared with a version's own
// address.
//
// No `generateMetadata` reading the file: a title derived from gated data is
// how a PRIVATE file's name reaches the tab of a viewer the body answers with
// "Forbidden" (src/lib/route-access.ts's header). A static title costs nothing
// here, since this page is a waypoint rather than something to bookmark.
export const metadata: Metadata = { title: "Download" };

export default async function FileDownloadPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <FileDownloadLanding slug={slug} versionNumber={null} />;
}
