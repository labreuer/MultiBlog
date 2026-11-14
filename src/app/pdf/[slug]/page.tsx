import type { Metadata } from "next";
import { titleWhenOk } from "@/lib/route-access";
import { PdfReading, loadFileVersionForRead, readingTitle } from "./reading";

// PLAN.md §19 — the PDF reading view at a file's bare address, which shows
// its latest version (docs/PDF.md §13, "Addresses"). The body is reading.tsx's,
// shared with a version's own address.

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return titleWhenOk(await loadFileVersionForRead(slug, null), ({ file, shown }) => readingTitle(file, shown));
}

export default async function PdfPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sel?: string }>;
}) {
  const { slug } = await params;
  const { sel } = await searchParams;
  return <PdfReading slug={slug} versionNumber={null} sel={sel} />;
}
