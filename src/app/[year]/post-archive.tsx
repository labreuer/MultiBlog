import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { publishedPostWhere } from "@/lib/post-status";
import { parsePostDatePrefix, type PostDateRange } from "@/lib/post-path";
import PostListing, { postListingInclude } from "@/components/PostListing";
import styles from "./post-archive.module.css";

// PLAN.md §21h — `/yyyy`, `/yyyy/mm` and `/yyyy/mm/dd` list the posts
// published in that UTC range, newest first. The three page.tsx files under
// src/app/[year]/ are one-line wrappers over this; each carries its own
// `revalidate = 60` because Next reads segment config from the page file,
// not from anything it imports.
//
// Every entry point runs parsePostDatePrefix before its first query: the
// `/[year]` segment matches any one-segment path nothing static claims
// (`/tag`, `/doc`, `/favicon.ico`), and its children any two- or three-
// segment one, so a malformed prefix must 404 without costing a query
// (§21a's rule, one level up). A *well-formed* date with nothing published
// in it is a real page — 200 and an empty list, never a 404.
//
// No auth()/cookies()/headers() anywhere below, same as the landing page and
// the post page, so `revalidate = 60` stays a real shared cache (§17, CACHING.md).

export type ArchiveSegments = { year: string; month?: string; day?: string };

function rangeOrNotFound({ year, month, day }: ArchiveSegments): PostDateRange {
  const range = parsePostDatePrefix(year, month, day);
  if (!range) notFound();
  return range;
}

export function archiveMetadata(segments: ArchiveSegments): Metadata {
  const range = parsePostDatePrefix(segments.year, segments.month, segments.day);
  return range ? { title: `Posts from ${range.label}` } : {};
}

export default async function PostArchivePage(segments: ArchiveSegments) {
  const range = rangeOrNotFound(segments);
  const posts = await prisma.post.findMany({
    where: { ...publishedPostWhere(), publishedAt: { gte: range.start, lt: range.end } },
    orderBy: { publishedAt: "desc" },
    include: postListingInclude,
  });

  // Every level above this one, each linking to its own archive; the current
  // level is the heading, not a crumb.
  const crumbs: { label: string; href: string }[] = [{ label: "All posts", href: "/" }];
  const { year, month, day } = segments;
  if (month !== undefined) crumbs.push({ label: year, href: `/${year}` });
  if (day !== undefined) crumbs.push({ label: month!, href: `/${year}/${month}` });

  return (
    <div className={styles.container}>
      <main className={styles.main}>
        <nav aria-label="Breadcrumb" className={styles.breadcrumb}>
          <ol>
            {crumbs.map((crumb) => (
              <li key={crumb.href}>
                <Link href={crumb.href}>{crumb.label}</Link>
              </li>
            ))}
          </ol>
        </nav>
        <h1 className={styles.title}>{range.label}</h1>
        <PostListing posts={posts} emptyMessage={`No posts published in ${range.label}.`} />
      </main>
    </div>
  );
}
