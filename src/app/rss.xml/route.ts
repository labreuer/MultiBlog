import { prisma } from "@/lib/prisma";
import { extractText } from "@/lib/diff";

export const revalidate = 60;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const baseUrl = process.env.APP_URL ?? "http://localhost:3000";

  const posts = await prisma.post.findMany({
    where: { status: "PUBLISHED", currentRevisionId: { not: null } },
    orderBy: { publishedAt: "desc" },
    take: 30,
    include: { currentRevision: { select: { title: true, doc: true } } },
  });

  const items = posts
    .map((post) => {
      const title = post.currentRevision?.title ?? post.title;
      const link = `${baseUrl}/${post.slug}`;
      const description = post.currentRevision ? extractText(post.currentRevision.doc).slice(0, 300) : "";
      const pubDate = (post.publishedAt ?? post.createdAt).toUTCString();
      return `  <item>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <guid>${escapeXml(link)}</guid>
    <pubDate>${pubDate}</pubDate>
    <description>${escapeXml(description)}</description>
  </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>MultiBlog</title>
  <link>${escapeXml(baseUrl)}</link>
  <description>A multi-author blog with revisions and quote-anchored comments.</description>
${items}
</channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
