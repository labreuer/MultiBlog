import Link from "next/link";
import AuthorByline from "@/components/AuthorByline";
import LocalTime from "@/components/LocalTime";
import PostDate from "@/components/PostDate";
import Highlighted from "@/components/search/Highlighted";
import { searchQueryString, type SearchKind } from "@/lib/search/params";
import type { HeadlineFragment } from "@/lib/search/headline";
import type {
  AnnotationHit,
  CommentHit,
  DocHit,
  PdfHit,
  PostHit,
  SearchResult,
  SearchSection,
} from "@/lib/search/types";
import { KIND_LABELS, kindList } from "./labels";
import styles from "./page.module.css";

// docs/FULLTEXT.md §7 — one section per kind, in a fixed order, each with
// its count; on the overview its first few hits and an "All N" link, and
// with one kind selected a paginated list.
//
// Every count is this viewer's own filtered total, and every hit is one the
// search operation already admitted under its kind's read rule: nothing here
// decides what may be shown.

export default function SearchResults({ result }: { result: SearchResult }) {
  const shown = result.sections.filter((section) => section.total > 0);
  const empty = result.sections.filter((section) => section.total === 0).map((section) => section.kind);

  if (shown.length === 0) {
    return (
      <p className={styles.notice}>
        {result.params.q ? <>Nothing you can read matches “{result.params.q}”.</> : <>Nothing you can read matches these filters.</>}
      </p>
    );
  }
  return (
    <>
      {shown.map((section) => (
        <Section key={section.kind} section={section} result={result} />
      ))}
      {empty.length > 0 && !result.paginated && <p className={styles.emptyKinds}>No matches in {kindList(empty, "or")}.</p>}
    </>
  );
}

function Section({ section, result }: { section: SearchSection; result: SearchResult }) {
  const label = KIND_LABELS[section.kind];
  return (
    <section className={styles.section} aria-labelledby={`search-${section.kind}`}>
      <h2 className={styles.sectionTitle} id={`search-${section.kind}`}>
        {label.plural} <span className={styles.count}>({section.total})</span>
      </h2>
      <ol className={styles.hits} start={result.paginated ? (result.params.page - 1) * result.pageSize + 1 : 1}>
        <Hits section={section} />
      </ol>
      {result.paginated ? (
        <Pagination section={section} result={result} />
      ) : (
        section.total > section.hits.length && (
          <p className={styles.all}>
            <Link href={`/search${searchQueryString(result.params, { kinds: [section.kind], page: 1 })}`}>
              All {section.total} {label.lower} →
            </Link>
          </p>
        )
      )}
    </section>
  );
}

function Hits({ section }: { section: SearchSection }) {
  switch (section.kind) {
    case "docs":
      return section.hits.map((hit) => <DocItem key={hit.id} hit={hit} />);
    case "posts":
      return section.hits.map((hit) => <PostItem key={hit.id} hit={hit} />);
    case "pdfs":
      return section.hits.map((hit) => <PdfItem key={hit.id} hit={hit} />);
    case "annotations":
      return section.hits.map((hit) => <AnnotationItem key={hit.id} hit={hit} />);
    case "comments":
      return section.hits.map((hit) => <CommentItem key={hit.id} hit={hit} />);
  }
}

function Title({ href, fragments, fallback }: { href: string; fragments: HeadlineFragment[]; fallback: string }) {
  return (
    <Link href={href} className={styles.hitTitle}>
      {fragments.length > 0 ? <Highlighted fragments={fragments} /> : fallback}
    </Link>
  );
}

function Snippet({ fragments }: { fragments: HeadlineFragment[] }) {
  if (fragments.length === 0) return null;
  return (
    <p className={styles.snippet}>
      <Highlighted fragments={fragments} />
    </p>
  );
}

function Edited({ editedAt }: { editedAt: Date | null }) {
  if (!editedAt) return null;
  return (
    <>
      {" "}
      · edited <LocalTime value={editedAt} precision="date" />
    </>
  );
}

function DocItem({ hit }: { hit: DocHit }) {
  return (
    <li className={styles.hit}>
      <Title href={hit.href} fragments={hit.title} fallback="Untitled" />
      <p className={styles.meta}>
        <AuthorByline authors={hit.byline} showPrefix={false} />
        <LocalTime value={hit.updatedAt} precision="date" />
      </p>
      <Snippet fragments={hit.snippet} />
    </li>
  );
}

// An unpublished post is here because this viewer may edit it, and it links
// into the editor; the marker says so, as /tag's does, so a per-viewer list
// admits to being one.
function PostItem({ hit }: { hit: PostHit }) {
  return (
    <li className={styles.hit}>
      <Title href={hit.href} fragments={hit.title} fallback="Untitled" />
      {hit.status !== "published" && <span className={styles.marker}>{hit.status}</span>}
      <p className={styles.meta}>
        <AuthorByline authors={hit.byline} />
        {hit.status === "published" && hit.publishedAt ? (
          <PostDate publishedAt={hit.publishedAt} />
        ) : hit.status === "scheduled" && hit.publishedAt ? (
          <>
            goes live <LocalTime value={hit.publishedAt} precision="date" />
          </>
        ) : (
          "not published"
        )}
      </p>
      <Snippet fragments={hit.snippet} />
    </li>
  );
}

function PdfItem({ hit }: { hit: PdfHit }) {
  return (
    <li className={styles.hit}>
      <Title href={hit.href} fragments={hit.title} fallback="Untitled" />
      <p className={styles.meta}>
        PDF · <LocalTime value={hit.updatedAt} precision="date" />
      </p>
      {hit.pages.length > 0 && (
        <ul className={styles.pages}>
          {hit.pages.map((page) => (
            <li key={page.page}>
              <Link href={page.href} className={styles.pageLink}>
                p. {page.page}
              </Link>{" "}
              <Highlighted fragments={page.snippet} className={styles.pageSnippet} />
            </li>
          ))}
        </ul>
      )}
      {hit.morePages > 0 && (
        <p className={styles.more}>
          and {hit.morePages} more {hit.morePages === 1 ? "page" : "pages"}
        </p>
      )}
    </li>
  );
}

function AnnotationItem({ hit }: { hit: AnnotationHit }) {
  return (
    <li className={styles.hit}>
      <Link href={hit.href} className={styles.hitTitle}>
        {hit.writer} on {hit.container.title}
      </Link>
      <p className={styles.meta}>
        {hit.container.kind === "pdf" ? "PDF annotation" : "Annotation"} ·{" "}
        <LocalTime value={hit.postedAt} precision="date" />
        <Edited editedAt={hit.editedAt} />
      </p>
      {hit.quote.length > 0 && (
        <blockquote className={styles.quote}>
          <Highlighted fragments={hit.quote} />
        </blockquote>
      )}
      <Snippet fragments={hit.snippet} />
    </li>
  );
}

function CommentItem({ hit }: { hit: CommentHit }) {
  return (
    <li className={styles.hit}>
      <Link href={hit.href} className={styles.hitTitle}>
        {hit.commenter} on {hit.postTitle}
      </Link>
      <p className={styles.meta}>
        Comment · <LocalTime value={hit.createdAt} precision="date" />
        <Edited editedAt={hit.editedAt} />
      </p>
      <Snippet fragments={hit.snippet} />
    </li>
  );
}

function Pagination({ section, result }: { section: SearchSection; result: SearchResult }) {
  const pages = Math.max(1, Math.ceil(section.total / result.pageSize));
  const page = Math.min(result.params.page, pages);
  if (pages <= 1) return null;
  const href = (to: number) => `/search${searchQueryString(result.params, { page: to })}`;
  return (
    <nav className={styles.pagination} aria-label={`${KIND_LABELS[section.kind as SearchKind].plural} pages`}>
      {page > 1 ? <Link href={href(page - 1)}>← Previous</Link> : <span />}
      <span className={styles.pageCount}>
        Page {page} of {pages}
      </span>
      {page < pages ? <Link href={href(page + 1)}>Next →</Link> : <span />}
    </nav>
  );
}
