import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { titleWhenOk } from "@/lib/route-access";
import { parseVersionNumber } from "@/lib/file-version";
import { PdfReading, loadFileVersionForRead, readingTitle } from "../../reading";

// docs/PDF.md §13, "Addresses" — one version of a file at its own address,
// `/pdf/<slug>/v/<n>`, whatever its state: a candidate, the latest or an
// earlier one. It never redirects to the bare address, so a link to version 2
// still shows version 2 after version 3 is promoted. Its title names its
// version, the latest's included: a tab left open here across a promotion
// writes its notes on the version it shows, and its title has said which.
//
// The body is reading.tsx's, shared with the bare address.

export async function generateMetadata({ params }: { params: Promise<{ slug: string; n: string }> }): Promise<Metadata> {
  const { slug, n } = await params;
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) return {};
  return titleWhenOk(await loadFileVersionForRead(slug, versionNumber), ({ file, shown }) => readingTitle(file, shown));
}

export default async function PdfVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; n: string }>;
  searchParams: Promise<{ sel?: string }>;
}) {
  const { slug, n } = await params;
  const { sel } = await searchParams;
  // Shape first: `/v/01` and `/v/x` name no version, and cost no query.
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) notFound();
  return <PdfReading slug={slug} versionNumber={versionNumber} sel={sel} />;
}
