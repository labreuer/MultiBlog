import { notFound, redirect } from "next/navigation";
import { gated, type AccessRejection } from "@/lib/route-access";
import { canUserReadFile } from "@/lib/file-authz";
import { resolveFileParam } from "@/lib/file-slug";
import { formatBytes } from "@/lib/file-format";
import { signInPath } from "@/lib/sign-in-redirect";
import { fileVersionState, filesPath } from "@/lib/file-version";
import AutoDownload from "./AutoDownload";
import styles from "./page.module.css";

// PLAN.md §19 — where a download lands someone who had to sign in first, for
// both of a file's kinds of address (docs/PDF.md §13, "Addresses"):
//
//   /files/<slug>          the latest version (page.tsx)
//   /files/<slug>/v/<n>    version n (v/[n]/page.tsx)
//
// `versionNumber` is null for the bare address.
//
// **Why it exists.** /files/<slug>/download is a URL meant to be pasted and
// clicked by a person, so an anonymous click goes to /sign-in with a
// callbackUrl. That callbackUrl used to be the download URL itself, which was
// wrong in a way that took a measurement to see: signing in ran
// `router.push("/files/<slug>/download")`, the router fetched a route handler
// that answers with bytes rather than an RSC payload, and the browser turned
// the result into a download. A download does not navigate — so the file
// arrived and the app sat on the sign-in form, looking exactly like a failed
// login. This page is a real destination for that callbackUrl: it says what is
// being downloaded, and starts the download itself.
//
// **Gated on `canUserReadFile`, not `canManageFiles`.** The distinction is the
// whole point. /files (the table) is ADMIN/EDITOR/AUTHOR, but *reading* a
// SHARED file also admits AUTHORIZED — so sending someone to a filtered /files
// would have answered "you don't have permission to manage files" to a person
// who had just legitimately downloaded the thing. A file's own page answering
// the file's own question is what makes that impossible. The asymmetry is not
// new: /files/<slug>/download already gates this way, directly below here.
//
// **Not advertised anywhere.** FilesTable keeps linking straight to /download,
// so a signed-in manager never pays an interstitial; nothing links here. It
// is a landing, not the canonical URL for a file. It works fine if typed —
// there is no secret in a page whose every fact its viewer may already read —
// but nothing points at it.
//
// No `generateMetadata` reading the file: a title derived from gated data is
// how a PRIVATE file's name reaches the tab of a viewer the body answers with
// "Forbidden" (src/lib/route-access.ts's header). A static title costs nothing
// here, since this page is a waypoint rather than something to bookmark.
type FileForDownload = { slug: string; title: string; version: { number: number; isLatest: boolean; filename: string; byteSize: number } };

const loadFileForDownload = gated(async (user, slug: string, versionNumber: number | null): Promise<FileForDownload | AccessRejection> => {
  const resolved = await resolveFileParam(slug, {
    id: true,
    slug: true,
    title: true,
    visibility: true,
    currentVersionId: true,
    versions: { select: { id: true, number: true, filename: true, byteSize: true, promotedAt: true, abandonedAt: true } },
    deletedByUserId: true,
  });
  if (!resolved || resolved.file.deletedByUserId !== null) {
    return "not-found";
  }
  if (!(await canUserReadFile(user.id, user.role, resolved.file))) {
    return "forbidden";
  }
  // Checked after the permission gate so a stale slug doesn't tell someone who
  // may not read the file what its current one is. `resolveFileParam`'s own
  // `redirectTo` is not usable here — it names /pdf/<slug>, that route's
  // canonical address rather than this one's.
  const { file } = resolved;
  const here = (isLatest: boolean) => filesPath(file.slug, versionNumber === null ? null : { number: versionNumber, isLatest }, { own: true });
  if (resolved.redirectTo) {
    // A version has no slug of its own: the rest of the address is kept.
    return { redirect: here(false) };
  }
  const found = file.versions.find((candidate) => (versionNumber === null ? candidate.id === file.currentVersionId : candidate.number === versionNumber));
  // A number the file never had, or an abandoned version, which has no bytes.
  if (!found || found.abandonedAt !== null) {
    return "not-found";
  }
  const isLatest = fileVersionState(found, file.currentVersionId) === "latest";
  return { slug: file.slug, title: file.title, version: { number: found.number, isLatest, filename: found.filename, byteSize: found.byteSize } };
});

export async function FileDownloadLanding({ slug, versionNumber }: { slug: string; versionNumber: number | null }) {
  const access = await loadFileForDownload(slug, versionNumber);
  if (access.status === "signed-out") {
    redirect(signInPath(filesPath(slug, versionNumber === null ? null : { number: versionNumber, isLatest: false })));
  }
  if (access.status === "redirect") {
    redirect(access.to);
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
  const file = access.value;
  const { version } = file;

  // The canonical download URL rather than the byte route directly, so this
  // page holds no opinion about hashes or `?download=1` — it re-uses the one
  // resolver everything else links to. `slug` comes from the row, so a visitor
  // arriving on a past slug has already been redirected above.
  //
  // A version's own address downloads that version, under its own filename.
  const href = `${filesPath(file.slug, versionNumber === null ? null : version, { own: true })}/download`;

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>{versionNumber === null ? file.title : `${file.title}, version ${version.number}`}</h1>
        <dl className={styles.facts}>
          <dt>Filename</dt>
          <dd>{version.filename}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(version.byteSize)}</dd>
        </dl>
        <p className={styles.status}>
          Your download should start automatically. If it doesn&apos;t,{" "}
          <a href={href}>download it here</a>.
        </p>
      </div>
      <AutoDownload href={href} />
      {/* The JavaScript-off path, which /sign-in already takes seriously enough
          to have its own spec — someone who signed in without JS would
          otherwise reach a page that only *claims* a download is coming.
          Written as raw markup because React 19 hoists a `<meta>` element it
          renders normally, which would lift it out of the <noscript> and fire
          the refresh for everyone. `slug` is `[a-z0-9-]` by slugify, so there
          is nothing here to escape. */}
      <noscript
        dangerouslySetInnerHTML={{ __html: `<meta http-equiv="refresh" content="0;url=${href}">` }}
      />
    </main>
  );
}
