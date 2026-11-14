import { notFound, redirect } from "next/navigation";
import { canUserManageFile, canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { gated, type AccessRejection } from "@/lib/route-access";
import PdfSurfaceClient from "@/components/pdf/PdfSurfaceClient";
import { pdfAnnotationEntriesFor } from "@/lib/pdf-annotation-entries";
import { getOwnFileDraftAnnotations } from "@/lib/annotation-data";
import { anchoredLinkForViewer } from "@/lib/anchored-link-data";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import TagChips from "@/components/tags/TagChips";
import FileReferencesPanel from "@/components/pdf/FileReferencesPanel";
import PdfVersionList from "@/components/pdf/PdfVersionList";
import PdfAbandonedVersion from "@/components/pdf/PdfAbandonedVersion";
import { candidateFactsFor } from "@/lib/file-version-candidate";
import { actorFromSessionUser } from "@/lib/actor";
import { referencesOfFile } from "@/lib/reference-files";
import { canWriteReferences } from "@/lib/role-checks";
import AnchoredLinkTray from "@/components/anchored-link/AnchoredLinkTray";
import { fileVersionTitle, pdfPath, type ShownVersion } from "@/lib/file-version";
import { carriesOf } from "@/lib/file-anchor-move";
import {
  VERSION_SUMMARY_SELECT,
  linkVersionsOf,
  mintedPartsByVersion,
  postedNotesByVersion,
  summariseVersions,
  type FileVersionSummary,
  type VersionManage,
} from "@/lib/file-version-data";
import { linkVersionsJson } from "@/lib/pdf-link-reading";
import styles from "./page.module.css";

// PLAN.md §19, docs/PDF.md §13 "Addresses" — the PDF reading view, for both
// of a file's kinds of address:
//
//   /pdf/<slug>          the latest version (page.tsx)
//   /pdf/<slug>/v/<n>    version n, whatever its state (v/[n]/page.tsx)
//
// One loader and one body, so the two can't differ in their gate, in which
// notes they draw or in what they hand the viewer. `versionNumber` is null
// for the bare address.
//
// Inherently dynamic (per-user gated), like /doc/[slug]: no
// generateStaticParams and none should be added, since a route eligible for
// static generation that also calls a dynamic API throws DYNAMIC_SERVER_USAGE
// at build (§10 item 17).
//
// A Server Component, so the session and permission work happens before any
// bytes are named; the viewer itself is a client island behind `ssr: false`
// (see PdfViewerClient for why that boundary has to exist at all).

// The one resolver that can answer "somewhere else": a past slug redirects to
// the current one rather than rendering here, so a shared link doesn't
// quietly become the canonical URL — the same contract /doc/[slug] has
// through resolveDocSlugHistory. That is the `redirect` arm of Access, and it
// is returned *before* the gate. **The redirect keeps the rest of the
// address**: `/pdf/book/v/1` goes to `/pdf/barfield/v/1`, since a version has
// no slug of its own and follows its file's.
type FileVersionForRead = {
  file: { id: string; slug: string; title: string; visibility: "PRIVATE" | "SHARED"; currentVersionId: string | null };
  versions: FileVersionSummary[];
  shown: ShownVersion;
  /** The hash of the version shown, which its byte URL names. */
  sha256: string;
  /** The file's versions as a link's reading takes them, as one string (`linkVersionsJson`). */
  linkVersions: string;
};

export const loadFileVersionForRead = gated(async (user, slug: string, versionNumber: number | null): Promise<FileVersionForRead | AccessRejection> => {
  const resolved = await resolveFileParam(slug, {
    id: true,
    slug: true,
    title: true,
    visibility: true,
    deletedByUserId: true,
    currentVersionId: true,
    versions: { select: VERSION_SUMMARY_SELECT },
  });
  if (!resolved) {
    return "not-found";
  }
  if (resolved.redirectTo) {
    const { file } = resolved;
    return { redirect: versionNumber === null ? pdfPath(file.slug) : pdfPath(file.slug, { number: versionNumber, isLatest: false }) };
  }
  // resolveFileParam uses prismaIncludingDeleted so a management route could
  // offer an undelete; this is the reading route, so it checks itself.
  if (resolved.file.deletedByUserId !== null) {
    return "not-found";
  }
  if (!(await canUserReadFile(user.id, user.role, resolved.file))) {
    return "forbidden";
  }
  const { versions: rows, ...file } = resolved.file;
  const versions = summariseVersions({ currentVersionId: file.currentVersionId, versions: rows });
  const found =
    versionNumber === null ? versions.find((version) => version.id === file.currentVersionId) : versions.find((version) => version.number === versionNumber);
  // A number the file never had. Checked after the gate, so the answer says
  // nothing to someone who may not read the file. An abandoned version is
  // found: it has no bytes to show, and its address answers with a page that
  // says so (`PdfAbandonedVersion`).
  if (!found) {
    return "not-found";
  }
  const shown: ShownVersion = {
    id: found.id,
    number: found.number,
    isLatest: found.state === "latest",
    state: found.state,
    address: versionNumber === null ? "bare" : "version",
  };
  const linkVersions = linkVersionsJson(await linkVersionsOf({ currentVersionId: file.currentVersionId, versions: rows }));
  return { file, versions, shown, sha256: found.sha256, linkVersions };
});

/** The page's title: the file's on the bare address, and `<title>, version <n>` on a version's own, the latest's included. */
export function readingTitle(file: { title: string }, shown: ShownVersion): string {
  return fileVersionTitle(file.title, shown, { always: shown.address === "version" });
}

export async function PdfReading({ slug, versionNumber, sel }: { slug: string; versionNumber: number | null; sel: string | undefined }) {
  // Free — generateMetadata already ran this for the same request.
  const access = await loadFileVersionForRead(slug, versionNumber);
  const withSel = (path: string) => pathWithQuery(path, new URLSearchParams(sel ? { sel } : {}));
  if (access.status === "signed-out") {
    // Keeps ?sel= for the same reason the slug-history redirect below does.
    const here = versionNumber === null ? pdfPath(slug) : pdfPath(slug, { number: versionNumber, isLatest: false });
    redirect(signInPath(withSel(here)));
  }
  if (access.status === "redirect") {
    // The slug-history redirect names only the path — re-append ?sel= or a
    // shared link minted against a slug that later changed would land on the
    // right file with its passages silently gone (docs/ANCHORED_LINKS.md).
    redirect(withSel(access.to));
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to read this file.</p>
      </main>
    );
  }
  const {
    value: { file, versions, shown, sha256, linkVersions },
    user,
  } = access;

  // An abandoned version's address: which version it was, that it was
  // abandoned and when, and where the latest is. Nothing of the viewer is
  // mounted, since the version has no bytes and no page text.
  if (shown.state === "abandoned") {
    const gone = versions.find((version) => version.id === shown.id);
    return (
      <PdfAbandonedVersion
        slug={file.slug}
        title={file.title}
        number={shown.number}
        abandonedAt={gone?.abandonedAt ?? null}
        latestNumber={versions.find((version) => version.state === "latest")?.number ?? null}
      />
    );
  }

  // The hash is in the path, which is what makes this URL immutable and lets
  // the byte route answer `immutable` — see the route's own header. It is the
  // hash of the version shown, so the viewer reads that version's bytes for
  // as long as it is open, whichever version becomes the latest meanwhile.
  const fileUrl = `/api/files/${file.id}/${sha256}`;

  // docs/ANCHORED_LINKS.md — the link ?sel= names, as this viewer may see
  // it, delivered as an initial prop. Initial props are the one delivery
  // that safely crosses the ssr:false boundary below (CLAUDE.md's
  // router.refresh() trap is about refresh-based delivery, not this).
  const anchoredLink = sel ? await anchoredLinkForViewer(sel, user) : null;

  // Fetched here rather than inside the panel for the same reason
  // /doc/[slug] fetches its threads at the page level (PLAN.md §13o): the
  // *highlights* and the *cards* have to come from one snapshot, or the two
  // could disagree about which annotations exist.
  //
  // Shared with `loadPdfAnnotationEntries`, which the surface calls after a
  // post — see that action, and PdfAnnotationSurface's `liveEntries`. Both
  // take the version shown: what is drawn is that version's alone.
  const { entries, elsewhere } = await pdfAnnotationEntriesFor(file, shown.id);
  // The viewer's own drafts — "Your private notes", the only way back into a
  // draft once its composer is gone. Their own id, never anyone else's
  // (getOwnFileDraftAnnotations).
  const ownDrafts = await getOwnFileDraftAnnotations(file.id, user.id, { slug: file.slug, fileVersionId: shown.id });
  // A reference's record is public, and this page has checked its reader may read the file.
  const references = await referencesOfFile(file.id);

  // docs/PDF.md §13 — what whoever may manage the file is given: the upload
  // of a new version, a waiting version's promotion and abandoning with what
  // a promotion would do, and the notes still on each earlier version.
  // Null for every other reader, so none of it reaches their page.
  const latest = versions.find((version) => version.state === "latest");
  const waiting = versions.find((version) => version.state === "candidate");
  const manage: VersionManage | null = (await canUserManageFile(user.id, user.role, file.id))
    ? {
        fileId: file.id,
        takesVersions: latest !== undefined && latest.pageCount !== null,
        notesOn: versions.length > 1 ? await postedNotesByVersion(file.id) : {},
        partsOn: versions.length > 1 ? await mintedPartsByVersion(file.id) : {},
        carries: versions.length > 1 ? await carriesOf(file.id) : [],
        candidateFacts: waiting && latest ? await candidateFactsFor(actorFromSessionUser(user), file.id, waiting, latest) : null,
      }
    : null;

  // PLAN.md §20d — the tag chips, handed to the viewer as its Metadata
  // pane.
  //
  // Passed as a prop, not imported by the client island: PdfSurfaceClient is a
  // `"use client"` module behind `ssr: false`, which may not import a Server
  // Component but may receive one already rendered (its header has the whole
  // reason). Gated by this page's canUserReadFile above, exactly as the doc
  // page's chips are gated by canUserReadDoc.
  //
  // The `key` is pre-emptive. An async Server Component handed across a
  // client boundary as a prop needs one the moment its client renders it
  // among siblings (CLAUDE.md's Gotchas; /doc/[slug]'s byline is the live
  // case). PdfMetadataPanel renders it beside the references this file is
  // the PDF of, each keyed.
  return (
    <>
      {/* The key makes the *version* a mount boundary (docs/PDF.md §13,
          "Addresses"): a client navigation between two versions of one file
          (the banner's link to the latest, the version list, a link's parts
          on two versions) must mount a new surface, or the old one would
          carry one version's viewer, ready flag and once-only link jump onto
          the other's page. Keyed on the file it would stay. It also covers
          the doc page's case, an anchored-link banner client-navigating
          between two PDFs of one link. */}
      <PdfSurfaceClient
        key={shown.id}
        fileId={file.id}
        slug={file.slug}
        version={shown}
        versions={versions}
        linkVersions={linkVersions}
        manage={manage}
        fileUrl={fileUrl}
        // A version's own page says "the latest" beside its title while it is.
        title={shown.address === "version" && shown.isLatest ? `${readingTitle(file, shown)} (the latest)` : readingTitle(file, shown)}
        entries={entries}
        elsewhere={elsewhere}
        ownDrafts={ownDrafts}
        anchoredLink={anchoredLink}
        metadata={[
          <TagChips key="tags" target={{ kind: "file", id: file.id }} />,
          // docs/CITATIONS.md, "A work's PDF": the references this is the PDF of, and for a writer the picker.
          <FileReferencesPanel
            key="references"
            fileId={file.id}
            initial={references}
            canWrite={canWriteReferences(user.role)}
            isPrivate={file.visibility === "PRIVATE"}
          />,
          // Listed once a file has a second version: its only version needs no
          // list. A manager has it from the first, since it holds the upload.
          (versions.length > 1 || manage?.takesVersions) && (
            <PdfVersionList key="versions" slug={file.slug} versions={versions} shownId={shown.id} manage={manage} />
          ),
        ]}
      />
      {/* docs/ANCHORED_LINKS.md — the open-link tray, a self-fetching
          sibling of the viewer island rather than a child of it: it must
          not wait out the ssr:false boundary, and fixed positioning keeps
          it out of the viewer's own chrome. */}
      <AnchoredLinkTray />
    </>
  );
}
