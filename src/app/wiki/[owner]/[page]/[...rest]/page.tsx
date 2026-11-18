import { notFound, permanentRedirect } from "next/navigation";
import { wikiRedirect } from "@/lib/wiki-address";
import { routeSegments, searchOf } from "@/lib/wiki-pages";

// docs/WIKI.md "In a URL" — every sub-path a page's own routes don't take, so
// `…/EDIT` and anything deeper get the lowercase redirect too, rather than
// 404ing unredirected through src/app/[year]/'s routes or none. Only the
// fixed redirects apply here, each permanent and for everyone, since each is
// a function of the URL; anything else is a 404.
export default async function WikiSubPath({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; page: string; rest: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { owner, page, rest } = await params;
  const decoded = routeSegments([owner, page, ...rest], { encoded: true });
  if (!decoded) notFound();
  const answer = wikiRedirect(decoded, searchOf(await searchParams));
  if (answer) permanentRedirect(answer.path);
  notFound();
}
