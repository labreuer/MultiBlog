import type { Metadata } from "next";

// docs/EMAIL.md §10. A card's page holds its code in the URL, so none of
// these is indexed.
export const metadata: Metadata = { title: "Join", robots: { index: false, follow: false } };

export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
