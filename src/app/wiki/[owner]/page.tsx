import { notFound, permanentRedirect, redirect } from "next/navigation";
import type { Metadata } from "next";
import { gatedAnyViewer, titleWhenOk } from "@/lib/route-access";
import {
  readableWikiPages,
  redirectRejection,
  resolveWikiPath,
  routeSegments,
  searchOf,
  wikiOwnerOf,
  wikiReturnPath,
} from "@/lib/wiki-pages";
import { ownerSegment } from "@/lib/wiki-address";
import { signInPath } from "@/lib/sign-in-redirect";
import PageList from "../page-list";
import styles from "../wiki.module.css";

// docs/WIKI.md "URLs" — a namespace's list, `/wiki/commons` or `/wiki/@<slug>`:
// its pages the viewer may read, by the wiki read rule, newest edit first. A
// namespace with nothing the viewer may read answers as an unknown owner's
// does, a deleted owner's included, so the wiki tells nobody more about an
// account than /authors/ does.
const loadNamespace = gatedAnyViewer(async (user, owner: string) => {
  const answer = await resolveWikiPath([owner], async (found) => {
    const pages = await readableWikiPages(found, user);
    return pages.length > 0 ? { value: pages } : null;
  });
  if (answer.kind === "not-found") return "not-found";
  if (answer.kind === "redirect") return redirectRejection(answer.redirect);
  if (answer.kind === "absent") return user ? "not-found" : "signed-out";
  return { owner: wikiOwnerOf(answer.owner), pages: answer.value };
});

export async function generateMetadata({ params }: { params: Promise<{ owner: string }> }): Promise<Metadata> {
  const { owner } = await params;
  // generateMetadata's params arrive decoded already.
  return titleWhenOk(await loadNamespace(owner), (value) => (value.owner.kind === "commons" ? "Commons" : ownerSegment(value.owner)));
}

export default async function WikiNamespacePage({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { owner } = await params;
  const decoded = routeSegments([owner], { encoded: true });
  if (!decoded) notFound();
  const search = searchOf(await searchParams);
  const access = await loadNamespace(decoded[0]);
  if (access.status === "signed-out") redirect(signInPath(wikiReturnPath(decoded, search)));
  if (access.status === "redirect") {
    if (access.permanent) permanentRedirect(`${access.to}${search}`);
    redirect(`${access.to}${search}`);
  }
  if (access.status !== "ok") notFound();
  const namespace = access.value.owner;
  return (
    <main className={styles.main}>
      <h1>{namespace.kind === "commons" ? "Commons" : ownerSegment(namespace)}</h1>
      <p className={styles.intro}>Pages{access.user ? " you can read" : ""}, most recently edited first.</p>
      <PageList owner={namespace} pages={access.value.pages} />
    </main>
  );
}
