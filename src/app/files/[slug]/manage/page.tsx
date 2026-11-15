import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { gated, type AccessRejection } from "@/lib/route-access";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { canManageAnySharedFile, canUserManageFile } from "@/lib/file-authz";
import { resolveFileParam, uniqueFileSlug } from "@/lib/file-slug";
import { latestVersionOf } from "@/lib/file-version";
import { formatBytes, formatLabelForContentType, isPdfContentType } from "@/lib/file-format";
import { FILE_MANAGER_ROLES } from "@/lib/role-checks";
import { staffDisplayNameOf } from "@/lib/display-name";
import { signInPath } from "@/lib/sign-in-redirect";
import type { Prisma } from "@/generated/prisma/client";
import SlugManager from "@/components/SlugManager";
import LocalTime from "@/components/LocalTime";
import { actorFromSessionUser } from "@/lib/actor";
import { FileDeleteSection, FileOwnersSection, FileTitleSection, FileVisibilitySection, type OwnerEntry } from "./sections";
import FileVersionsSection from "./versions";
import { managedVersionsOf, VERSIONS_SELECT } from "./versions-data";
import styles from "./page.module.css";

// docs/PDF.md §14 — one page per file where its managers do everything
// managing it involves: its title, its slug, its visibility, its owners, its
// versions (a PDF's upload, promotion, abandoning and carries, with each
// version's page map), and deleting or restoring it. The acts are
// src/lib/file-manage.ts's and src/lib/file-anchor-move.ts's, through the
// answering actions in src/app/actions/files.ts and, for the two that take
// seconds and nobody waits on, the Route Handlers under
// /api/files/versions/<id>/.
//
// **Addressed by the file's id** (`/files/<id>/manage`), as `/doc/<id>/edit`
// is: the page changes the slug, so a slug address would move under it, and
// two deleted files may share a slug while a deleted file is exactly what
// this page opens, to restore it. A slug, or a past one, is taken too, and
// redirects to the id **after the gate**, so a reader who may not manage the
// file is answered Forbidden at the address they typed and learns no id.
//
// **The id is read first, and the slug only where no file has that id.** A
// slug is whatever a manager types, so a file can be given another file's id
// as its slug; read slug first, that file would answer the other's links.
//
// **A deleted file's page is its facts and its restore.** Every other section
// is drawn disabled, and nothing links to the file by its slug: `/pdf/<slug>`
// answers 404 for a deleted file, or opens the live file that took its slug.
//
// The title is static and never the file's, as `/files/<slug>`'s is: a title
// read from gated data reaches the tab of a viewer the body refuses
// (src/lib/route-access.ts).
export const metadata: Metadata = { title: "Manage file" };

const select = {
  id: true,
  slug: true,
  title: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  deletedByUserId: true,
  createdBy: { select: { name: true, email: true } },
  updatedBy: { select: { name: true, email: true } },
  deletedBy: { select: { name: true, email: true } },
  currentVersionId: true,
  currentVersion: { select: { filename: true, contentType: true, byteSize: true, pageCount: true } },
  metrics: { select: { annotationCount: true } },
  versions: VERSIONS_SELECT,
  slugHistory: { orderBy: { createdAt: "asc" }, select: { slug: true, createdAt: true } },
  // Every owner, a deleted account's included: the list is shown whole and
  // `expected` is compared with all of it (setFileOwners).
  owners: {
    orderBy: { ownerOrder: "asc" },
    select: { user: { select: { id: true, name: true, email: true, role: true, deletedByUserId: true } } },
  },
} satisfies Prisma.StoredFileSelect;

type ManagedFile = Prisma.StoredFileGetPayload<{ select: typeof select }>;

const loadManagedFile = gated(async (user, param: string): Promise<ManagedFile | AccessRejection> => {
  const file =
    (await prismaIncludingDeleted.storedFile.findUnique({ where: { id: param }, select })) ??
    (await resolveFileParam(param, select))?.file ??
    null;
  if (!file) return "not-found";
  // A gate that opens a deleted file: restoring one is managing it.
  if (!(await canUserManageFile(user.id, user.role, file.id))) return "forbidden";
  if (param !== file.id) return { redirect: `/files/${file.id}/manage` };
  return file;
});

export default async function ManageFilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: param } = await params;
  const access = await loadManagedFile(param);
  if (access.status === "signed-out") redirect(signInPath(`/files/${param}/manage`));
  if (access.status === "redirect") redirect(access.to);
  if (access.status === "not-found") notFound();
  if (access.status === "forbidden") {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to manage this file.</p>
      </main>
    );
  }
  const { value: file, user } = access;
  const latest = latestVersionOf(file);
  const isPdf = isPdfContentType(latest.contentType);
  const deleted = file.deletedByUserId !== null;
  const nameOf = (person: { name: string | null; email: string } | null) => (person ? staffDisplayNameOf(person, user.role) : "");

  const [eligible, standardSlug, managedVersions] = await Promise.all([
    // Live accounts only (the filtered client), as the doc byline picker reads them.
    prisma.user.findMany({
      where: { role: { in: FILE_MANAGER_ROLES } },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
    uniqueFileSlug(file.title, file.id),
    managedVersionsOf(actorFromSessionUser(user), file, { isPdf }),
  ]);
  const owners: OwnerEntry[] = file.owners.map(({ user: owner }) => ({
    id: owner.id,
    label: nameOf(owner),
    note:
      owner.deletedByUserId !== null
        ? "account deleted"
        : !FILE_MANAGER_ROLES.includes(owner.role)
          ? "no longer an admin, editor or author"
          : null,
  }));
  const isOwner = owners.some((owner) => owner.id === user.id);
  // Where the file is read: its viewer for a PDF, its download otherwise.
  const readHref = isPdf ? `/pdf/${file.slug}` : `/files/${file.slug}/download`;

  return (
    <main className={styles.main}>
      <p className={styles.back}>
        <Link href="/files">← Files</Link>
      </p>
      <h1 className={styles.title}>{file.title}</h1>

      <section className={styles.section} aria-labelledby="file-facts">
        <h2 id="file-facts">The file</h2>
        <p>
          {deleted ? (
            <span className={styles.muted}>Deleted, so it can&apos;t be read until it is restored.</span>
          ) : isPdf ? (
            <Link href={readHref}>Read it</Link>
          ) : (
            <a href={readHref}>Download it</a>
          )}
        </p>
        <dl className={styles.facts}>
          <dt>Filename</dt>
          <dd>{latest.filename}</dd>
          <dt>Type</dt>
          <dd>{formatLabelForContentType(latest.contentType)}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(latest.byteSize)}</dd>
          {latest.pageCount !== null && (
            <>
              <dt>Pages</dt>
              <dd>{latest.pageCount.toLocaleString("en-US")}</dd>
            </>
          )}
          <dt>Added</dt>
          <dd>
            <LocalTime value={file.createdAt} />
            {file.createdBy && <> by {nameOf(file.createdBy)}</>}
          </dd>
          <dt>Last changed</dt>
          <dd>
            <LocalTime value={file.updatedAt} />
            {file.updatedBy && <> by {nameOf(file.updatedBy)}</>}
          </dd>
          <dt>Annotations</dt>
          <dd>{(file.metrics?.annotationCount ?? 0).toLocaleString("en-US")}</dd>
        </dl>
      </section>

      {deleted && <p className={styles.deletedNote}>This file is deleted. Restore it, below, to change anything else about it.</p>}

      {/* `disabled` on a fieldset disables every control inside it, which is
          the whole of "drawn disabled" for a deleted file. */}
      <fieldset className={styles.sections} disabled={deleted}>
        <FileTitleSection fileId={file.id} title={file.title} />

        <section className={styles.section} aria-labelledby="file-address">
          <h2 id="file-address">Address</h2>
          {/* Keyed on the slug and its past ones: SlugManager keeps what it
              was mounted with, and a restore can change both. */}
          <SlugManager
            key={[file.slug, ...file.slugHistory.map((row) => row.slug)].join("\n")}
            entityType="file"
            entityId={file.id}
            currentSlug={file.slug}
            standardSlug={standardSlug}
            urlPrefix={isPdf ? "/pdf" : "/files"}
            urlSuffix={isPdf ? "" : "/download"}
            linkCurrent={!deleted}
            history={file.slugHistory.map((row) => ({ slug: row.slug, createdAt: row.createdAt.toISOString() }))}
          />
        </section>

        <FileVisibilitySection
          fileId={file.id}
          visibility={file.visibility}
          viewerIsOwner={isOwner}
          viewerManagesAnyShared={canManageAnySharedFile(user.role)}
        />

        <FileOwnersSection
          fileId={file.id}
          slug={file.slug}
          isPdf={isPdf}
          visibility={file.visibility}
          viewerId={user.id}
          viewerManagesAnyShared={canManageAnySharedFile(user.role)}
          owners={owners}
          eligible={eligible.map((person) => ({ id: person.id, label: nameOf(person) }))}
        />

        {/* Keyed on the file, so what it holds (a promotion's outcome, a
            build that is running) outlives every refresh. */}
        <FileVersionsSection key={file.id} fileId={file.id} slug={file.slug} isPdf={isPdf} deleted={deleted} managed={managedVersions} />
      </fieldset>

      <FileDeleteSection
        fileId={file.id}
        deleted={deleted}
        deletedAt={file.deletedAt?.toISOString() ?? null}
        deletedBy={nameOf(file.deletedBy)}
      />
    </main>
  );
}
