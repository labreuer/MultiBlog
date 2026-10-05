import type { SearchKind } from "@/lib/search/params";

/** What the page calls each kind: a section heading, a filter label, an "All N …" link. */
export const KIND_LABELS: Record<SearchKind, { plural: string; lower: string }> = {
  docs: { plural: "Docs", lower: "docs" },
  posts: { plural: "Posts", lower: "posts" },
  pdfs: { plural: "PDFs", lower: "PDFs" },
  annotations: { plural: "Annotations", lower: "annotations" },
  comments: { plural: "Comments", lower: "comments" },
};

/** "docs, posts and PDFs" — a list of kinds in running text. */
export function kindList(kinds: SearchKind[], conjunction: "and" | "or" = "and"): string {
  const words = kinds.map((kind) => KIND_LABELS[kind].lower);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}
