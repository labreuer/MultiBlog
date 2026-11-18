import Link from "next/link";
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
import { canReadWikiDoc } from "@/lib/doc-authz";
import { docEditorTabTitle } from "@/lib/doc-title";
import { signInPath } from "@/lib/sign-in-redirect";
import { wikiPagePath } from "@/lib/wiki-address";
import DocEditView, { DOC_EDIT_SELECT, canEditLoadedDoc } from "@/app/doc/[slug]/edit/doc-edit-view";

// docs/WIKI.md "Requests and responses" — a wiki page's editor, for whoever
// may edit it. Signed out, the sign-in redirect, whatever is there; a reader
// who can't edit, Forbidden with a link to the page, which reveals nothing
// to someone who can read it; anyone else signed in, a 404, as for the page.
// A deleted page has no address, so it is edited at /doc/<id>/edit, which
// is where the Settings panel's Delete goes on to ("Deleting a page").
const loadWikiEditor = gatedAnyViewer(async (user, owner: string, page: string) => {
  const answer = await resolveWikiPath([owner, page, "edit"], async (found, address) => {
    const doc = await findWikiPage(ownerIdOf(found), address!.name, address!.variant, DOC_EDIT_SELECT);
    if (!doc || !(await canReadWikiDoc(user, doc))) return null;
    return { value: doc, page: { name: doc.wikiName!, variant: doc.wikiVariant } };
  });
  if (answer.kind === "not-found") return "not-found";
  if (answer.kind === "redirect") return redirectRejection(answer.redirect);
  if (user === null) return "signed-out";
  if (answer.kind === "absent") return "not-found";
  const path = wikiPagePath({ owner: wikiOwnerOf(answer.owner), name: answer.value.wikiName!, variant: answer.value.wikiVariant });
  if (!canEditLoadedDoc(answer.value, user)) return { kind: "forbidden" as const, title: answer.value.title, path };
  return { kind: "editor" as const, doc: answer.value, user, path };
});

export async function generateMetadata({ params }: { params: Promise<{ owner: string; page: string }> }): Promise<Metadata> {
  const { owner, page } = await params;
  // generateMetadata's params arrive decoded already.
  return titleWhenOk(await loadWikiEditor(owner, page), (value) => docEditorTabTitle(value.kind === "editor" ? value.doc.title : value.title));
}

export default async function WikiEditRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; page: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { owner, page } = await params;
  const decoded = routeSegments([owner, page], { encoded: true });
  if (!decoded) notFound();
  const search = searchOf(await searchParams);
  const access = await loadWikiEditor(decoded[0], decoded[1]);
  if (access.status === "signed-out") redirect(signInPath(wikiReturnPath([...decoded, "edit"], search)));
  if (access.status === "redirect") {
    if (access.permanent) permanentRedirect(`${access.to}${search}`);
    redirect(`${access.to}${search}`);
  }
  if (access.status !== "ok") notFound();
  const { value } = access;
  if (value.kind === "forbidden") {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>
          You don&apos;t have permission to edit this page. <Link href={value.path}>Read it</Link>.
        </p>
      </main>
    );
  }
  return <DocEditView doc={value.doc} user={value.user} />;
}
