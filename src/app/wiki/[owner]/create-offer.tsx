"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { decodeSegment, parseOwnerSegment, parsePageSegment } from "@/lib/wiki-address";

/**
 * The client half of the wiki's 404 (docs/WIKI.md "Requests and responses"):
 * Next gives a not-found.tsx no props, so the address that missed is read
 * from the path. When it is a well-formed page or namespace address in a
 * namespace the viewer may create in, this offers /wiki/new with what the
 * address names filled in. It reveals nothing: whoever may create in a
 * namespace can read all of it, so for them the 404 always means nothing is
 * there.
 */
export default function CreateOffer({ personSlug, commons }: { personSlug: string | null; commons: boolean }) {
  const pathname = usePathname() ?? "";
  const segments = pathname.split("/").slice(2).map(decodeSegment);
  // /wiki/<owner>, /wiki/<owner>/<page>, or that page's /edit.
  if (segments.length === 0 || segments.length > 3 || segments.some((s) => s === null)) return null;
  if (segments.length === 3 && segments[2] !== "edit") return null;
  const owner = parseOwnerSegment(segments[0]!);
  const page = segments.length > 1 ? parsePageSegment(segments[1]!) : null;
  if (!owner || (segments.length > 1 && !page)) return null;
  const where =
    owner.kind === "person" && owner.slug === personSlug ? "person" : owner.kind === "commons" && commons ? "commons" : null;
  if (!where) return null;
  const query = new URLSearchParams({ where });
  if (page) {
    query.set("name", page.name);
    if (page.variant) query.set("variant", page.variant);
  }
  return (
    <p>
      <Link href={`/wiki/new?${query}`}>{page ? "Create this page" : "Create a page here"}</Link>
    </p>
  );
}
