import type { Metadata } from "next";
import PostArchivePage, { archiveMetadata } from "../../post-archive";

// PLAN.md §21h — `/yyyy/mm/dd`. See ../../post-archive.tsx.
export const revalidate = 60;

type Params = Promise<{ year: string; month: string; day: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return archiveMetadata(await params);
}

export default async function DayArchivePage({ params }: { params: Params }) {
  return PostArchivePage(await params);
}
