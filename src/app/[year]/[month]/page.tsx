import type { Metadata } from "next";
import PostArchivePage, { archiveMetadata } from "../post-archive";

// PLAN.md §21h — `/yyyy/mm`. See ../post-archive.tsx.
export const revalidate = 60;

type Params = Promise<{ year: string; month: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return archiveMetadata(await params);
}

export default async function MonthArchivePage({ params }: { params: Params }) {
  return PostArchivePage(await params);
}
