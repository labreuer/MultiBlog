import { notFound, permanentRedirect, redirect } from "next/navigation";
import type { Metadata } from "next";
import { gatedAnyViewer, titleWhenOk } from "@/lib/route-access";
import {
  findWikiPage,
  ownerIdOf,
  redirectRejection,
  resolveWikiPath,
  routeSegments,
  searchOf,
  wikiOwnerOf,
  wikiReturnPath,
} from "@/lib/wiki-pages";
import { canReadWikiDoc, canUserReadDoc } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { signInPath } from "@/lib/sign-in-redirect";
import { parseScrubUpdateId } from "@/lib/scrub-url";
import DocReadingView, { DOC_READ_SELECT } from "@/app/doc/[slug]/doc-reading-view";
import PublicWikiPage from "../../public-page";

// docs/WIKI.md "Requests and responses" — a wiki page at its address, by the
// wiki read rule (canReadWikiDoc). A reader with canViewDocs gets the doc
// view; a PUBLIC page's reader signed out, or signed in without canViewDocs,
// gets the public render. Signed out, a missing page and one the viewer may
// not read look alike, a sign-in redirect each, and signed in, both are a
// 404, never Forbidden: an address names an owner and a page, so a Forbidden
// would confirm that a private page by that name exists.
//
// Dynamic and uncached, by decision ("Public pages"): one route answers a
// signed-in reader with the doc view and everyone else with the public
// render, and reads the session to tell them apart.
//
// The loader takes decoded segments (routeSegments): the page is handed its
// params encoded and generateMetadata decoded.
const loadWikiPage = gatedAnyViewer(async (user, owner: string, page: string) => {
  const answer = await resolveWikiPath([owner, page], async (found, address) => {
    const doc = await findWikiPage(ownerIdOf(found), address!.name, address!.variant, DOC_READ_SELECT);
    if (!doc || !(await canReadWikiDoc(user, doc))) return null;
    return { value: doc, page: { name: doc.wikiName!, variant: doc.wikiVariant } };
  }, { oldAddressesFor: { viewer: user } });
  if (answer.kind === "not-found") return "not-found";
  if (answer.kind === "redirect") return redirectRejection(answer.redirect);
  if (answer.kind === "absent") return user ? "not-found" : "signed-out";
  const doc = answer.value;
  const namespace = wikiOwnerOf(answer.owner);
  // The doc view's gates are canUserReadDoc's, which a PUBLIC page's text
  // alone doesn't pass: its annotations and history stay its readers'.
  if (user !== null && (await canUserReadDoc(user.id, user.role, doc))) return { view: "doc" as const, doc, user, namespace };
  return { view: "public" as const, doc, user, namespace };
});

export async function generateMetadata({ params }: { params: Promise<{ owner: string; page: string }> }): Promise<Metadata> {
  const { owner, page } = await params;
  // generateMetadata's params arrive decoded already.
  return titleWhenOk(await loadWikiPage(owner, page), (value) => docTitleOrFallback(value.doc.title));
}

export default async function WikiPageRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; page: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { owner, page } = await params;
  const decoded = routeSegments([owner, page], { encoded: true });
  if (!decoded) notFound();
  const query = await searchParams;
  const search = searchOf(query);
  const access = await loadWikiPage(decoded[0], decoded[1]);
  if (access.status === "signed-out") redirect(signInPath(wikiReturnPath(decoded, search)));
  if (access.status === "redirect") {
    if (access.permanent) permanentRedirect(`${access.to}${search}`);
    redirect(`${access.to}${search}`);
  }
  if (access.status !== "ok") notFound();
  const { value } = access;
  if (value.view === "public") return <PublicWikiPage doc={value.doc} owner={value.namespace} viewer={value.user} />;
  const sel = typeof query.sel === "string" ? query.sel : undefined;
  const at = typeof query.at === "string" ? query.at : undefined;
  return <DocReadingView doc={value.doc} user={value.user} sel={sel} scrubUpdateId={parseScrubUpdateId(at)} />;
}
