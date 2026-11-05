import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next";
import { referenceByKey } from "@/lib/reference-data";
import { REFERENCE_KEY_RE, type CslItem } from "@/lib/references/csl";
import { referenceEntry } from "@/lib/references/entry";
import { normalizeDoi } from "@/lib/references/identifiers";
import styles from "./page.module.css";

// docs/CITATIONS.md, "Pages" — a reference's own page. **Public**: a
// published post's citations link here, and it shows only what a
// bibliography prints. So it reads no session and is cached like an author
// page; anything only some viewers may see (the docs and notes that cite the
// work, its PDF) belongs in a client island that asks the server on open, as
// `TagChips` keeps the post page static.
//
// A key the reference used to have redirects to the one it has now, the way
// an author's old handle does.
export const revalidate = 60;

async function load(key: string) {
  // Shape first, as every page that takes a slug-like segment does: a key
  // that can't be one costs no query.
  if (!REFERENCE_KEY_RE.test(key)) return null;
  return referenceByKey(key);
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const reference = await load((await params).key);
  return { title: reference ? (reference.item.title ?? reference.key) : "Reference" };
}

/** The entry as a bibliography sets it: a whole work's title in italics, a part's in quotation marks. */
function Entry({ item }: { item: CslItem }) {
  const entry = referenceEntry(item);
  const stop = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);
  return (
    <p className={styles.entry}>
      {entry.authors && `${entry.authors} (${entry.year}). `}
      {entry.titleIsContainer ? <cite>{stop(entry.title)}</cite> : `“${stop(entry.title)}”`}
      {!entry.authors && ` (${entry.year}).`}
      {entry.source && ` ${stop(entry.source)}`}
    </p>
  );
}

export default async function ReferencePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const reference = await load(key);
  if (!reference) notFound();
  if (reference.key !== key) permanentRedirect(`/references/${reference.key}`);

  const { item } = reference;
  const doi = item.DOI ? normalizeDoi(item.DOI) : null;
  return (
    <main className={styles.container}>
      <p className={styles.kicker}>Reference · {reference.key}</p>
      <h1>{item.title}</h1>
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
    </main>
  );
}
