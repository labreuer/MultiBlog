import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { search } from "@/lib/search";
import { parseSearchParams, searchQueryString, urlSearchParamsFrom, type SearchKind } from "@/lib/search/params";
import SearchForm from "./SearchForm";
import SearchResults from "./SearchResults";
import { kindList } from "./labels";
import styles from "./page.module.css";

// docs/FULLTEXT.md — one search over everything this viewer may read: docs,
// posts, PDFs, annotations and comments, a section per kind.
//
// **Dynamic, never cached, and different for every viewer.** An ADMIN and a
// signed-out reader see different results for the same URL, so a shared
// cache entry would be a leak rather than a staleness bug; `force-dynamic`
// says so out loud, as /tag does (CACHING.md). And no results page is worth
// a search engine's index, so every one is `noindex`.
//
// No sign-in redirect: a signed-out reader searches posts and comments, which
// is what they can read.
export const dynamic = "force-dynamic";

// Why an author filter leaves a kind out (src/lib/search/authors.ts).
const WITHOUT_AUTHOR_REASONS: Partial<Record<SearchKind, string>> = {
  pdfs: "a PDF has owners rather than authors",
  comments: "a comment keeps the name it was posted under",
};

type SearchParamsProp = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParamsProp }): Promise<Metadata> {
  const { q } = parseSearchParams(urlSearchParamsFrom(await searchParams));
  return { title: q ? `Search: ${q}` : "Search", robots: { index: false } };
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParamsProp }) {
  const requested = parseSearchParams(urlSearchParamsFrom(await searchParams));
  const session = await auth();
  const actor = session?.user ? { userId: session.user.id, role: session.user.role } : null;
  const result = await search(actor, requested);

  return (
    <main className={styles.container}>
      <h1 className={styles.heading}>Search</h1>
      <SearchForm
        key={searchQueryString(result.params)}
        params={result.params}
        readableKinds={result.readableKinds}
        authorOptions={result.authorOptions}
      />

      {result.withoutAuthors.length > 0 && (
        <p className={styles.notice}>
          Filtering by author leaves out {kindList(result.withoutAuthors)}:{" "}
          {result.withoutAuthors
            .map((kind) => WITHOUT_AUTHOR_REASONS[kind])
            .filter(Boolean)
            .join(", and ")}
          .
        </p>
      )}

      {result.status === "idle" ? (
        <p className={styles.notice}>
          Search the {kindList(result.readableKinds)} you can read.
          {!actor && <> Signed in, you may be able to search more.</>}
        </p>
      ) : result.status === "stop-words" ? (
        <p className={styles.notice}>
          “{result.params.q}” is made only of words too common to search for. Try a more particular word.
        </p>
      ) : result.kinds.length === 0 ? (
        <p className={styles.notice}>None of the kinds selected is one you can search.</p>
      ) : (
        <SearchResults result={result} />
      )}
    </main>
  );
}
