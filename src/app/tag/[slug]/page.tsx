import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { tagBySlug } from "@/lib/tag-data";
import { browseTag, PAGE_CAP, type TagHit } from "@/lib/tag-browse";
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
  const tag = await tagBySlug(slug);
  if (!tag) return {};
  return { title: `#${tag.name}`, description: tag.description ?? undefined };
}

export default async function TagPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tag = await tagBySlug(slug);
  // A soft-deleted term reads as absent through the `$extends` filter, so this
  // 404s for one — which is what a retracted term should do.
  if (!tag) {
    notFound();
  }

  // No sign-in redirect: the posts section is readable by anyone, so a
  // signed-out visitor gets a real page rather than a login wall. The doc and
  // file sections simply come back empty for them, which is the same answer
  // their own permission predicates would give.
  const session = await auth();
  const viewerId = session?.user?.id ?? null;
  const viewerRole = session?.user?.role ?? null;
  const { docs, posts, files, capped } = await browseTag(tag.id, viewerId, viewerRole);

  const total = docs.length + posts.length + files.length;

  return (
    <main className={styles.container}>
      <h1 className={styles.title}>{tag.name}</h1>
      {tag.description && <p className={styles.description}>{tag.description}</p>}

      {total === 0 && (
        <p className={styles.empty}>
          Nothing you can see carries this tag yet.{" "}
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
// read off tag_metrics (§20d) — the view counts everything live, which is
// a different question and the wrong one to answer here.
function Section({ title, hits }: { title: string; hits: TagHit[] }) {
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
