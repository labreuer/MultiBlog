import { prismaIncludingDeleted } from "@/lib/prisma";

// Top-level route segments under src/app/ — a post slug matching one of
// these would be shadowed by the static route and never resolve to /[slug].
const RESERVED_SLUGS = new Set([
  "api",
  "authors",
  "dashboard",
  "forgot-password",
  "posts",
  "reset-password",
  "rss.xml",
  "search",
  "sign-in",
  "sign-up",
  "site-settings",
  "users",
]);

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "post";
}

export async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title);
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-post` : base;
  let suffix = 2;
  while (await prismaIncludingDeleted.post.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
