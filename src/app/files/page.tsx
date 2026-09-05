import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { canManageFiles, canManageAnySharedFile } from "@/lib/file-authz";
import { isAdmin } from "@/lib/authz";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parseFilesFilters, type FilesFilters, type FilesSortKey } from "@/lib/files-query";
import { ownerFilterWhere, listOwnerFilterOptions } from "@/lib/author-filter";
import type { SortColumn } from "@/lib/table-sort";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import FilesTable from "@/components/FilesTable";
import FileUploader from "@/components/FileUploader";

export const metadata: Metadata = { title: "Files" };

// PLAN.md §19 — the file listing, deliberately /docs' twin (src/app/docs/page.tsx)
// down to the ADMIN-only scoping override, so the two admin tables can't drift
// on rules that are specified as identical.

function buildFilterWhere(filters: FilesFilters): Prisma.StoredFileWhereInput {
  const where: Prisma.StoredFileWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  // Searches the display title *and* the original filename: a file uploaded as
  // `2019-smith-et-al.pdf` and retitled "Coastal erosion" should be findable by
  // either, and which one someone remembers is not predictable.
  if (filters.q) {
    where.OR = [
      { title: { contains: filters.q, mode: "insensitive" } },
      { filename: { contains: filters.q, mode: "insensitive" } },
    ];
  }
  Object.assign(where, ownerFilterWhere(filters.owners, filters.ownerMode) as Prisma.StoredFileWhereInput);
  return where;
}

function buildOrderBy(sort: SortColumn<FilesSortKey>[]): Prisma.StoredFileOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.StoredFileOrderByWithRelationInput => {
    switch (key) {
      case "title":
        return { title: dir };
      case "filename":
        return { filename: dir };
      case "owners":
        // Through the file_metrics view — the same string_agg the cell shows.
        return { metrics: { owners: { sort: dir, nulls: "last" } } };
      case "annotations":
        // Also the view: a filtered count, which Prisma's `_count` can't
        // express. No `nulls` handling, unlike owners beside it — the view
        // COALESCEs the count to 0, so the column is declared non-null and
        // Prisma rejects the {sort, nulls} form for it. A file with no view row
        // at all still sorts as a NULL *relation*, which Prisma puts last.
        return { metrics: { annotationCount: dir } };
      case "visibility":
        return { visibility: dir };
      case "pages":
        return { pageCount: { sort: dir, nulls: "last" } };
      case "size":
        // The raw byte count, not the rounded string the cell prints — so
        // "980 KB" sorts below "1.2 MB" rather than above it.
        return { byteSize: dir };
      case "created":
        return { createdAt: dir };
      case "slug":
        return { slug: dir };
      case "updatedAt":
        return { updatedAt: dir };
      case "updatedBy":
        return { updatedBy: { name: { sort: dir, nulls: "last" } } };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function FilesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Hoisted above the gate so an anonymous visitor's callbackUrl keeps the
  // filters, sort and page they arrived with — this table's whole state lives
  // in the querystring (CLAUDE.md, "Admin tables are one kit").
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery("/files", urlSearchParams)));
  }
  if (!canManageFiles(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Files</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage files.</p>
      </main>
    );
  }

  const [prefs, ownerOptions] = await Promise.all([
    getTablePrefs(session.user.id, "files"),
    listOwnerFilterOptions(session.user.id),
  ]);
  const filters = parseFilesFilters(
    urlSearchParams,
    prefs,
    ownerOptions.map((o) => o.slug),
  );

  // Which rows this table selects (docs/PERMISSIONS.md), restating
  // file-authz.ts's rule as a `where` the same way /docs restates doc-authz's:
  //   - a SHARED file is listed for any ADMIN/EDITOR, owner or not;
  //   - a PRIVATE file is listed for its owners — so an AUTHOR sees
  //     only their own, which is exactly the specified rule;
  //   - ADMIN alone can drop that scoping with "Show all files"
  //     (?showAllFiles=1), an explicit per-visit opt-in stored nowhere. It
  //     widens this query and only this query: opening a PRIVATE file the admin
  //     doesn't own still goes through canUserReadFile, which refuses it.
  const viewerIsAdmin = isAdmin(session.user.role);
  const viewerCanManageAnyShared = canManageAnySharedFile(session.user.role);
  const bypassOwnerScoping = viewerIsAdmin && filters.showAllFiles;
  const ownerScope: Prisma.StoredFileWhereInput = {
    OR: [
      { owners: { some: { userId: session.user.id } } },
      ...(viewerCanManageAnyShared ? [{ visibility: "SHARED" as const }] : []),
    ],
  };
  const where: Prisma.StoredFileWhereInput = {
    AND: [bypassOwnerScoping ? {} : ownerScope, buildFilterWhere(filters)],
  };

  const [files, totalCount] = await Promise.all([
    prismaIncludingDeleted.storedFile.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      select: {
        id: true,
        slug: true,
        title: true,
        filename: true,
        visibility: true,
        pageCount: true,
        byteSize: true,
        createdAt: true,
        updatedAt: true,
        deletedByUserId: true,
        deletedAt: true,
        // Read from the same view that sorts them, so the displayed and sorted
        // expressions can't drift (§16e).
        metrics: { select: { owners: true, annotationCount: true } },
        // Ids only: canManage below is a membership test, not a display value.
        owners: { select: { userId: true } },
        updatedBy: { select: { name: true, email: true } },
      },
    }),
    prismaIncludingDeleted.storedFile.count({ where }),
  ]);

  const rows = files.map((file) => ({
    id: file.id,
    slug: file.slug,
    title: file.title,
    filename: file.filename,
    // NULL only when the file has no owners — same empty cell either way.
    owners: file.metrics?.owners ?? "",
    visibility: file.visibility,
    pageCount: file.pageCount,
    byteSize: file.byteSize,
    // No view row at all means no owners and no annotations, so zero.
    annotationCount: file.metrics?.annotationCount ?? 0,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    updatedByName: file.updatedBy ? (file.updatedBy.name ?? file.updatedBy.email) : "",
    deletedAt: file.deletedAt,
    deleted: file.deletedByUserId !== null,
    // canUserManageFile's rule inlined, decided here rather than per row
    // through that function, which costs a query apiece. The "Show all files"
    // override has no say: it widens which rows are listed, not who may act on
    // them, so a PRIVATE file it brings into view is read-only in this table.
    canManage:
      file.owners.some((o) => o.userId === session.user.id) ||
      (viewerCanManageAnyShared && file.visibility === "SHARED"),
  }));

  return (
    <main style={{ maxWidth: 1100, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Files</h1>
      <FileUploader isAdmin={viewerIsAdmin} />
      <FilesTable
        rows={rows}
        totalCount={totalCount}
        filters={filters}
        prefs={prefs}
        isAdmin={viewerIsAdmin}
        ownerOptions={ownerOptions}
      />
    </main>
  );
}
