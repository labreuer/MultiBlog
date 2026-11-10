import { Fragment, cache } from "react";
import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { appUrl } from "@/lib/app-url";
import { referenceByKey, referencesById, referencesByKeys, type ReferenceRow } from "@/lib/reference-data";
import { titleOf, type CslItem } from "@/lib/references/csl";
import { entryParts, referenceEntry } from "@/lib/references/entry";
import { lookupKey, parseReferenceSegment, referenceListPath, referencePath } from "@/lib/references/keys";
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
//
// The same route lists several works, `/references/<key>,<key>,…`, which is
// where a citation of several links (docs/CITATIONS.md, "The page"): each
// work's section as this page shows one, the posts citing any of them once,
// and a warning naming the keys nothing answered to. `~<alias>` is a key
// holding a comma, and only ever redirects.
export const revalidate = 60;

/** The segment as the key it spells: Next hands a param over percent-encoded, so a `:` arrives as `%3A` and a comma as `%2C`. */
function segmentOfParam(param: string): string | null {
  try {
    return decodeURIComponent(param);
  } catch {
    return null;
  }
}

type Loaded =
  | { kind: "key"; reference: ReferenceRow; asked: string }
  | { kind: "alias"; reference: ReferenceRow }
  /** Each key as it was asked, and the work it names, by place: null for a key nothing answered to, or whose record can't be read. */
  | { kind: "list"; asked: string[]; found: (ReferenceRow | null)[] };

// One lookup for generateMetadata and the page: nothing else spares the second, since the page has no cache.
const load = cache(async (param: string): Promise<Loaded | null> => {
  // Shape first, as every page that takes a slug-like segment does: a segment that can't be one costs no query.
  const segment = segmentOfParam(param);
  const parsed = segment === null ? null : parseReferenceSegment(segment);
  if (!parsed) return null;
  if (parsed.kind !== "list") {
    const reference = await referenceByKey(parsed.key);
    if (!reference) return null;
    return parsed.kind === "key" ? { kind: "key", reference, asked: parsed.key } : { kind: "alias", reference };
  }
  const byKey = await referencesByKeys(parsed.keys);
  const rows = await referencesById([...new Set([...byKey.values()].map((hit) => hit.id))]);
  const found = parsed.keys.map((key) => {
    const hit = byKey.get(key);
    return (hit && rows.get(hit.id)) || null;
  });
  // A list naming no work is a 404, as one unknown key is.
  return found.some(Boolean) ? { kind: "list", asked: parsed.keys, found } : null;
});

/**
 * The list as it should be written: each found work's current key, once, in
 * the order first named, and each key nothing answered to where it was first
 * written, as it was written there, once.
 */
function listAsWritten(asked: readonly string[], found: readonly (ReferenceRow | null)[]): string[] {
  const written: string[] = [];
  const seen = new Set<string>();
  asked.forEach((key, index) => {
    const reference = found[index];
    const identity = reference ? `id:${reference.id}` : `key:${lookupKey(key)}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    written.push(reference ? reference.key : key);
  });
  return written;
}

function shownTitle(reference: ReferenceRow): string {
  return titleOf(reference.item) || reference.key;
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const loaded = await load((await params).key);
  if (!loaded) return { title: "Reference" };
  if (loaded.kind !== "list") return { title: shownTitle(loaded.reference) };
  const works = loaded.found.filter((reference) => reference !== null);
  // Every order of the same keys is its own address, each repeating the single pages: as /search, not indexed.
  return { title: `${shownTitle(works[0])}${works.length > 1 ? ` and ${works.length - 1} more` : ""}`, robots: { index: false } };
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

/** What a work's page shows under its title: the entry, whether it was removed, and its details with the downloads. */
function WorkDetails({ reference }: { reference: ReferenceRow }) {
  const { item } = reference;
  const doi = item.DOI ? normalizeDoi(item.DOI) : null;
  return (
    <>
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
    </>
  );
}

/** The published posts citing any of these works, in the order every listing uses. Found by identity in the trigger-kept `citation` table, as search finds them (`cites=`). */
async function CitedInPosts({ referenceIds }: { referenceIds: string[] }) {
  const posts = await prisma.post.findMany({
    where: { ...publishedPostWhere(), citations: { some: { referenceId: { in: referenceIds } } } },
    orderBy: postListOrderBy,
    include: postListingInclude,
  });
  if (posts.length === 0) return null;
  return (
    <section className={styles.citedIn}>
      <h2>Cited in posts</h2>
      <PostListing posts={posts} emptyMessage="" />
    </section>
  );
}

/**
 * The keys of a list nothing answered to, in the page's address as it was
 * asked. Not percent-encoded, since every character a library key may hold
 * stands in a path as it is, and text rather than a link. Red alone would
 * tell a screen reader nothing, so each also says "(not found)" to one.
 */
function MissingKeys({ asked, found }: { asked: string[]; found: (ReferenceRow | null)[] }) {
  return (
    <div className={styles.missing}>
      <p className={styles.address}>
        {appUrl("/references/")}
        {asked.map((key, index) => (
          <Fragment key={index}>
            {index > 0 && ","}
            {found[index] ? (
              key
            ) : (
              <span className={styles.notFound}>
                {key}
                <span className={styles.visuallyHidden}> (not found)</span>
              </span>
            )}
          </Fragment>
        ))}
      </p>
      <p>Keys in red were not found in the database.</p>
    </div>
  );
}

function ListPage({ asked, found }: { asked: string[]; found: (ReferenceRow | null)[] }) {
  // Each work by its place in the address, which is where its page is in `#p=`.
  const works = asked.flatMap((_, position) => (found[position] ? [{ reference: found[position], position }] : []));
  return (
    <main className={styles.container}>
      <p className={styles.kicker}>References · {works.map(({ reference }) => reference.key).join(", ")}</p>
      <h1>{works.length === 1 ? "1 work" : `${works.length} works`}</h1>
      {found.some((reference) => reference === null) && <MissingKeys asked={asked} found={found} />}
      {works.map(({ reference, position }) => (
        <section key={reference.id} className={styles.work} aria-labelledby={`work-${position}`}>
          <h2 id={`work-${position}`}>{reference.item.title ? <TitleRuns runs={reference.item.title.runs} /> : reference.key}</h2>
          <WorkDetails reference={reference} />
          <CitedBy referenceId={reference.id} referenceKey={reference.key} headingLevel={3} position={position} />
        </section>
      ))}
      <CitedInPosts referenceIds={works.map(({ reference }) => reference.id)} />
    </main>
  );
}

export default async function ReferencePage({ params }: { params: Promise<{ key: string }> }) {
  const loaded = await load((await params).key);
  if (!loaded) notFound();
  // `~<alias>` never renders: the work's own page is its address.
  if (loaded.kind === "alias") permanentRedirect(referencePath(loaded.reference.key));
  if (loaded.kind === "list") {
    const written = listAsWritten(loaded.asked, loaded.found);
    if (written.length === 1) permanentRedirect(referencePath(written[0]));
    if (written.some((key, index) => key !== loaded.asked[index]) || written.length !== loaded.asked.length) permanentRedirect(referenceListPath(written));
    return <ListPage asked={loaded.asked} found={loaded.found} />;
  }
  const { reference } = loaded;
  if (reference.key !== loaded.asked) permanentRedirect(referencePath(reference.key));

  const { item } = reference;
  return (
    <main className={styles.container}>
      <p className={styles.kicker}>Reference · {reference.key}</p>
      <h1>{item.title ? <TitleRuns runs={item.title.runs} /> : reference.key}</h1>
      <WorkDetails reference={reference} />
      <CitedInPosts referenceIds={[reference.id]} />
      <CitedBy referenceId={reference.id} referenceKey={reference.key} />
    </main>
  );
}
