import { notFound, redirect } from "next/navigation";
import { parseVersionNumber } from "@/lib/file-version";
import { pathWithQuery } from "@/lib/sign-in-redirect";

// docs/PDF.md §13, "Addresses" — `/pdf/<slug>/v<n>` redirects to
// `/pdf/<slug>/v/<n>`, the form a person types. Any other second segment is
// no address of a file.
//
// Nothing is read here: the address it redirects to runs the gate, so this
// says nothing about whether the file or the version exists.

export default async function PdfVersionAliasPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; alias: string }>;
  searchParams: Promise<{ sel?: string }>;
}) {
  const { slug, alias } = await params;
  const { sel } = await searchParams;
  const versionNumber = alias.startsWith("v") ? parseVersionNumber(alias.slice(1)) : null;
  if (versionNumber === null) notFound();
  redirect(pathWithQuery(`/pdf/${slug}/v/${versionNumber}`, new URLSearchParams(sel ? { sel } : {})));
}
