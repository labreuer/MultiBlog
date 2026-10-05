// docs/FULLTEXT.md §7 — what a search returns: one section per kind, each
// hit carrying exactly what the page shows for it and nothing else.
//
// Types only, so the page's components can import them without Prisma. A hit
// holds no permission data and no ids beyond its own: everything here has
// already passed its kind's read rule, and a field is on a hit only because
// the page shows it.

import type { Role } from "@/generated/prisma/enums";
import type { PostStatus } from "@/lib/post-status";
import type { HeadlineFragment } from "./headline";
import type { SearchKind, SearchParams } from "./params";

/**
 * Who is searching. An explicit argument rather than a session read, so the
 * same operation serves the page, the quote picker and the API's search
 * endpoints (§8). Null is a signed-out reader.
 */
export type SearchActor = { userId: string; role: Role } | null;

/**
 * Whose read rules apply. `viewer` is the actor's own; `public` is what
 * everyone may read, for the quote picker, where a quotation may carry only
 * that (PLAN.md §23e) whoever is quoting.
 */
export type SearchScope = "viewer" | "public";

/** A byline as AuthorByline takes it, in byline order. */
export type SearchByline = { userId: string; slug: string; name: string | null }[];

export type DocHit = {
  id: string;
  href: string;
  title: HeadlineFragment[];
  byline: SearchByline;
  updatedAt: Date;
  snippet: HeadlineFragment[];
};

export type PostHit = {
  id: string;
  href: string;
  title: HeadlineFragment[];
  byline: SearchByline;
  status: PostStatus;
  /** The go-live date: past for a published post, future for a scheduled one, null for a draft. */
  publishedAt: Date | null;
  snippet: HeadlineFragment[];
};

export type PdfPageHit = {
  /** 1-based, as the viewer's page box and `#page=` count. */
  page: number;
  href: string;
  snippet: HeadlineFragment[];
};

export type PdfHit = {
  id: string;
  href: string;
  title: HeadlineFragment[];
  updatedAt: Date;
  /** The best pages, best first; at most PDF_PAGES_SHOWN. */
  pages: PdfPageHit[];
  /** How many more pages matched than are shown. */
  morePages: number;
};

export type AnnotationHit = {
  id: string;
  href: string;
  container: { kind: "doc" | "pdf"; title: string };
  /** The name the annotation's card shows. */
  writer: string;
  postedAt: Date;
  /** The edit readers are told about (PLAN.md §22b), or null. */
  editedAt: Date | null;
  snippet: HeadlineFragment[];
  /** The passage it quotes, or [] for one anchored to nothing. */
  quote: HeadlineFragment[];
};

export type CommentHit = {
  id: string;
  href: string;
  commenter: string;
  postTitle: string;
  createdAt: Date;
  editedAt: Date | null;
  snippet: HeadlineFragment[];
};

export type SearchSection =
  | { kind: "docs"; total: number; hits: DocHit[] }
  | { kind: "posts"; total: number; hits: PostHit[] }
  | { kind: "pdfs"; total: number; hits: PdfHit[] }
  | { kind: "annotations"; total: number; hits: AnnotationHit[] }
  | { kind: "comments"; total: number; hits: CommentHit[] };

/** One entry in the author picker: a name the viewer can already see on a byline, never an email (§6). */
export type SearchAuthorOption = { slug: string; name: string };

export type SearchResult = {
  /** The parameters as applied: authors not on the picker are gone. */
  params: SearchParams;
  /** Every kind this viewer may search, in page order. */
  readableKinds: SearchKind[];
  /** The kinds searched, in page order — the selected readable ones. */
  kinds: SearchKind[];
  /** Kinds an author filter left out, because they have no author to filter by. */
  withoutAuthors: SearchKind[];
  authorOptions: SearchAuthorOption[];
  /**
   * `idle`: no text and no filter, so nothing was searched. `stop-words`: the
   * text parsed to nothing (§4). `ok`: the sections are the answer.
   */
  status: "idle" | "stop-words" | "ok";
  /** One per searched kind, in page order — including empty ones. */
  sections: SearchSection[];
  /**
   * Whether nothing matched the query as typed, and these sections are what
   * typo correction found instead (§5). The page says so, and offers the
   * search exactly as typed; it names no corrected word — the highlights in
   * the snippets show what matched.
   */
  corrected: boolean;
  /** Whether a single kind was asked for, so its section is paginated rather than cut at the overview's length. */
  paginated: boolean;
  pageSize: number;
};
