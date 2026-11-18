import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { isDocParamShape, resolveDocParam } from "@/lib/resolve-doc-param";
import { gated, titleWhenOk } from "@/lib/route-access";
import { canUserReadDoc } from "@/lib/doc-authz";
import { docEditorTabTitle } from "@/lib/doc-title";
import { signInPath } from "@/lib/sign-in-redirect";
import { wikiPathOfDoc } from "@/lib/wiki-address";
import DocEditView, { DOC_EDIT_SELECT, canEditLoadedDoc } from "./doc-edit-view";

// resolveDocParam rather than a direct query — the id-or-slug ambiguity this
// route shares with /doc/[slug] and /doc/[slug]/slug (PLAN.md §12f). No
// deletedByUserId check, unlike the reading route: a soft-deleted doc must
// still load here so the Settings panel can offer Undelete.
//
// A wiki doc (docs/WIKI.md "URLs"): a live one is edited at its address, so
// an editor is sent there with a 307; a deleted one isn't, since its address
// may already be another page's, and loads here for its Undelete ("Deleting
// a page"). A viewer who can't read it gets a 404 rather than Forbidden,
// which would confirm that a page of that name exists.
const loadDocForEdit = gated(async (user, slug: string) => {
  if (!isDocParamShape(slug)) return "not-found";
  const doc = await resolveDocParam(slug, DOC_EDIT_SELECT);
  if (!doc) {
    return "not-found";
  }
  const canEdit = canEditLoadedDoc(doc, user);
  if (doc.wikiName !== null) {
    if (!canEdit) return (await canUserReadDoc(user.id, user.role, doc)) ? "forbidden" : "not-found";
    if (doc.deletedByUserId === null) {
      const path = wikiPathOfDoc({ wikiName: doc.wikiName, wikiVariant: doc.wikiVariant, ownerSlug: doc.wikiOwner?.slug ?? null });
      return { redirect: `${path}/edit` };
    }
    return doc;
  }
  if (!canEdit) {
    return "forbidden";
  }
  return doc;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return titleWhenOk(await loadDocForEdit(slug), (doc) => docEditorTabTitle(doc.title));
}

export default async function EditDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Free — generateMetadata already ran this for the same request.
  const access = await loadDocForEdit(slug);
  if (access.status === "signed-out") {
    redirect(signInPath(`/doc/${slug}/edit`));
  }
  if (access.status === "redirect") {
    redirect(access.to);
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to edit this doc.</p>
      </main>
    );
  }
  return <DocEditView doc={access.value} user={access.user} />;
}
