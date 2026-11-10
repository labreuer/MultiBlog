import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { referenceByKey } from "@/lib/reference-data";
import { titleOf, type CslItem } from "@/lib/references/csl";
import { entryParts, referenceEntry } from "@/lib/references/entry";
import { isKeyShaped, referencePath } from "@/lib/references/keys";
import { downloadHref, EXPORT_FORMAT_ORDER, EXPORT_FORMATS } from "@/lib/references/export-formats";
import { normalizeDoi } from "@/lib/references/identifiers";
import { prisma } from "@/lib/prisma";
import { publishedPostWhere } from "@/lib/post-status";
import { postListOrderBy } from "@/lib/post-pages";
import PostListing, { postListingInclude } from "@/components/PostListing";
import TitleRuns from "@/components/bibliography/TitleRuns";
import CitedBy from "./CitedBy";
import styles from "./page.module.css";

// docs/CITATIONS.md, "Pages" — a reference's own page. **Public**: a
// published post's citations link here, and it shows what a bibliography
// prints and the published posts citing the work. So it reads no session;
// what only some viewers may see (the docs and notes that cite the work, its
// PDF) is CitedBy, a client island that asks the server on open, as
// `TagChips` keeps the post page static. That keeps it a page a cache could
// hold. It has none: with no generateStaticParams it is rendered on every
// request, and `revalidate` below does nothing (CACHING.md, 2026-11-10).
//
// A key the reference used to have, or its key in another case, redirects to
// the one it has now, the way an author's old handle does.
export const revalidate = 60;

/** The segment as the key it spells: Next hands a param over percent-encoded, so a `:` arrives as `%3A`. */
function keyOfParam(param: string): string | null {
  try {
    return decodeURIComponent(param);
  } catch {
    return null;
  }
}

async function load(param: string) {
  // Shape first, as every page that takes a slug-like segment does: a key
  // that can't be one costs no query.
  const key = keyOfParam(param);
  if (key === null || !isKeyShaped(key)) return null;
  const reference = await referenceByKey(key);
  return reference ? { reference, key } : null;
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const loaded = await load((await params).key);
  return { title: loaded ? titleOf(loaded.reference.item) || loaded.reference.key : "Reference" };
}

/** The entry as a bibliography sets it: a whole work's title in italics, a part's in quotation marks, its markup kept. */
function Entry({ item }: { item: CslItem }) {
  return (
    <p className={styles.entry}>
      {entryParts(referenceEntry(item)).map((part, index) =>
        part.title ? <cite key={index} className={styles.title}>
            <TitleRuns runs={part.runs ?? [{ text: part.text }]} />
          </cite> : <span key={index}>{part.text}</span>,
      )}
    </p>
  );
}

export default async function ReferencePage({ params }: { params: Promise<{ key: string }> }) {
  const loaded = await load((await params).key);
  if (!loaded) notFound();
  const { reference } = loaded;
  if (reference.key !== loaded.key) permanentRedirect(referencePath(reference.key));

  const { item } = reference;
  const doi = item.DOI ? normalizeDoi(item.DOI) : null;
  // Found by identity in the trigger-kept `citation` table, as search finds them (`cites=`).
  const posts = await prisma.post.findMany({
    where: { ...publishedPostWhere(), citations: { some: { referenceId: reference.id } } },
    orderBy: postListOrderBy,
    include: postListingInclude,
  });
  return (
    <main className={styles.container}>
      <p className={styles.kicker}>Reference · {reference.key}</p>
      <h1>{item.title ? <TitleRuns runs={item.title.runs} /> : reference.key}</h1>
      <Entry item={item} />
      {reference.deleted && <p className={styles.deleted}>This reference has been removed from the library.</p>}
      <table className={styles.details}>
        <tbody>
          {reference.short && (
            <tr>
              <th scope="row">Cited as</th>
              <td>{reference.short}</td>
            </tr>
          )}
          {doi && (
            <tr>
              <th scope="row">DOI</th>
              <td>
                <a href={`https://doi.org/${doi}`}>{doi}</a>
              </td>
            </tr>
          )}
          {item.ISBN && (
            <tr>
              <th scope="row">ISBN</th>
              <td>{item.ISBN}</td>
            </tr>
          )}
          <tr>
            <th scope="row">Download</th>
            <td>
              {/* Plain links, so the page stays static, and nofollow, so a crawler fetches none. */}
              {EXPORT_FORMAT_ORDER.map((format, index) => (
                <span key={format}>
                  {index > 0 && " · "}
                  <a href={downloadHref(format, `key=${encodeURIComponent(reference.key)}`)} rel="nofollow">
                    {EXPORT_FORMATS[format].label}
                  </a>
                </span>
              ))}
            </td>
          </tr>
          {item.URL && /^https?:\/\//.test(item.URL) && (
            <tr>
              <th scope="row">URL</th>
              <td>
                <a href={item.URL} rel="nofollow noopener">
                  {item.URL}
                </a>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {posts.length > 0 && (
        <section className={styles.citedIn}>
          <h2>Cited in posts</h2>
          <PostListing posts={posts} emptyMessage="" />
        </section>
      )}
      <CitedBy referenceId={reference.id} referenceKey={reference.key} />
    </main>
  );
}
