import Link from "next/link";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { readableWikiPages } from "@/lib/wiki-pages";
import { wikiNamespacesFor } from "@/lib/wiki-create";
import { wikiNamespacePath } from "@/lib/wiki-address";
import PageList from "./page-list";
import styles from "./wiki.module.css";

export const metadata: Metadata = { title: "Wiki" };

// docs/WIKI.md "URLs" — the wiki's front, for anyone: the commons' pages the
// viewer may read, newest edit first, a link to the viewer's own namespace
// when it has a page they may read, and to /wiki/new when they may create one.
export default async function WikiIndexPage() {
  const session = await auth();
  const viewer = session?.user ?? null;
  const commons = await readableWikiPages({ kind: "commons" }, viewer, { take: 200 });
  const self = viewer
    ? await prismaIncludingDeleted.user.findUnique({ where: { id: viewer.id }, select: { id: true, slug: true } })
    : null;
  const ownPages = self
    ? await readableWikiPages({ kind: "person", id: self.id, slug: self.slug, deleted: false, viaOldSlug: false }, viewer, { take: 1 })
    : [];
  const namespaces = viewer ? await wikiNamespacesFor(viewer) : null;
  const mayCreate = namespaces !== null && (namespaces.person !== null || namespaces.commons);

  return (
    <main className={styles.main}>
      <h1>Wiki</h1>
      <p className={styles.intro}>The commons&apos; pages{viewer ? " you can read" : ""}, most recently edited first.</p>
      {commons.length === 0 ? (
        <p className={styles.empty}>There are no commons pages {viewer ? "you can read" : "to show"} yet.</p>
      ) : (
        <PageList owner={{ kind: "commons" }} pages={commons} />
      )}
      {((self && ownPages.length > 0) || mayCreate) && (
        <p className={styles.links}>
          {self && ownPages.length > 0 && <Link href={wikiNamespacePath({ kind: "person", slug: self.slug })}>Your pages</Link>}
          {mayCreate && <Link href="/wiki/new">New page</Link>}
        </p>
      )}
    </main>
  );
}
