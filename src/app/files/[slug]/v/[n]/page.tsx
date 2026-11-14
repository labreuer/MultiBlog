import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { parseVersionNumber } from "@/lib/file-version";
import { FileDownloadLanding } from "../../landing";

// docs/PDF.md §13, "Addresses" — one version's download page,
// `/files/<slug>/v/<n>`. The body is landing.tsx's, shared with the file's
// bare address; the static title is for its reason too.
export const metadata: Metadata = { title: "Download" };

export default async function FileVersionDownloadPage({ params }: { params: Promise<{ slug: string; n: string }> }) {
  const { slug, n } = await params;
  // Shape first, so a malformed number costs no query.
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) notFound();
  return <FileDownloadLanding slug={slug} versionNumber={versionNumber} />;
}
