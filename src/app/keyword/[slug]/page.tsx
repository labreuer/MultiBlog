import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { keywordBySlug } from "@/lib/keyword-data";
import { browseKeyword, PAGE_CAP, type KeywordHit } from "@/lib/keyword-browse";
import styles from "./page.module.css";

// PLAN.md §20d — everything tagged with one term, in **per-type sections**.
//
// **Dynamic, never ISR**, and not merely for freshness: this page is
// permission-shaped per viewer — an ADMIN and an AUTHORIZED reader see
// different docs under the same URL — so a shared cache entry would be a leak
// rather than a staleness bug. `dynamic = "force-dynamic"` says that out loud
// instead of leaving it to whether some call below happens to opt out. See
// CACHING.md.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const keyword = await keywordBySlug(slug);
  if (!keyword) return {};
  return { title: keyword.name, description: keyword.description ?? undefined };
}

export default async function KeywordPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const keyword = await keywordBySlug(slug);
  // A soft-deleted term reads as absent through the `$extends` filter, so this
  // 404s for one — which is what a retracted term should do.
  if (!keyword) {
    notFound();
  }

  // No sign-in redirect: the posts section is readable by anyone, so a
  // signed-out visitor gets a real page rather than a login wall. The doc and
  // file sections simply come back empty for them, which is the same answer
  // their own permission predicates would give.
  const session = await auth();
  const viewerId = session?.user?.id ?? null;
  const viewerRole = session?.user?.role ?? null;
  const { docs, posts, files, capped } = await browseKeyword(keyword.id, viewerId, viewerRole);

  const total = docs.length + posts.length + files.length;

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>{keyword.name}</h1>
      {keyword.description && <p className={styles.description}>{keyword.description}</p>}

      {total === 0 && (
        <p className={styles.empty}>
          Nothing you can see carries this keyword yet.{" "}
          {viewerId === null && <>You may be seeing less of it than a signed-in reader would.</>}
        </p>
      )}

      <Section title="Docs" hits={docs} />
      <Section title="Posts" hits={posts} />
      <Section title="Files" hits={files} />

      {capped && (
        <p className={styles.capped}>
          Showing the first {PAGE_CAP} in at least one section.
        </p>
      )}

      <p className={styles.back}>
        <Link href="/">← Back to all posts</Link>
      </p>
    </main>
  );
}

// Each section's count is this viewer's own filtered result, never a number
// read off keyword_metrics (§20d) — the view counts everything live, which is
// a different question and the wrong one to answer here.
function Section({ title, hits }: { title: string; hits: KeywordHit[] }) {
  if (hits.length === 0) return null;
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        {title} <span className={styles.count}>({hits.length})</span>
      </h2>
      <ul className={styles.list}>
        {hits.map((hit) => (
          <li key={hit.id}>
            <Link href={hit.href}>{hit.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
