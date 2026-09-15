import type { Metadata } from "next";
import PostArchivePage, { archiveMetadata } from "./post-archive";

// PLAN.md §21h — `/yyyy`. The whole route lives in ./post-archive.tsx; see
// there for why this file gates before querying and why `revalidate` is here.
export const revalidate = 60;

type Params = Promise<{ year: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return archiveMetadata(await params);
}

export default async function YearArchivePage({ params }: { params: Params }) {
  return PostArchivePage(await params);
}
