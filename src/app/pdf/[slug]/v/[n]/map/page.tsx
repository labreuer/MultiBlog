import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import LocalTime from "@/components/LocalTime";
import PdfCarryActions from "@/components/pdf/PdfCarryActions";
import PdfMapActions from "@/components/pdf/PdfMapActions";
import PdfPageMapList from "@/components/pdf/PdfPageMapList";
import { canUserManageFile } from "@/lib/file-authz";
import { parseVersionNumber, pdfMapPath, pdfPath } from "@/lib/file-version";
import { pageMapViewFor } from "@/lib/pdf-page-map-view";
import { titleWhenOk } from "@/lib/route-access";
import { signInPath } from "@/lib/sign-in-redirect";
import { loadFileVersionForRead, readingTitle } from "../../../reading";
import styles from "./page.module.css";

// docs/PDF.md §13, "Matching the pages" — a version's page map, at
// `/pdf/<slug>/v/<n>/map`: how its sheets pair with those of the version it
// was uploaded over, which were removed and which no rule could place, and
// the questions its runs of sheets raise, each answered here. Where the
// version has no map, this is where one is asked for. The map itself is
// drawn sheet by sheet, by the component the file's manage page will draw it
// with too (`PdfPageMapList`; §14, "A version's page map, sheet by sheet").
//
// **Below a promoted version's map is the bulk carry** (§13, "Moving a note
// forward"): pairing a run of sheets moves no note, and gives the notes on
// those sheets a place to be carried to. The carry is started on the version
// this map is from, shows what it would move, and is run from here. A
// candidate's notes are carried by its promotion, from its own page.
//
// Open to whoever may manage the file: building a map and answering a run
// are theirs (`canUserManageFile`), and the page shows nothing a manager
// isn't given. It reads the same gate the version's own page does first, so
// a file its reader can't see answers as that page does.
//
// A version's link is a plain `<a>`, never a `<Link>`, as every sheet's in
// the list is: a fragment a client navigation brought would be left on the
// path (CLAUDE.md, Gotchas).

type Params = { params: Promise<{ slug: string; n: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, n } = await params;
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) return {};
  return titleWhenOk(await loadFileVersionForRead(slug, versionNumber), ({ file, shown }) => `Page map: ${readingTitle(file, shown)}`);
}

export default async function PdfVersionMapPage({ params }: Params) {
  const { slug, n } = await params;
  // Shape first: `/v/01/map` names no version, and costs no query.
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) notFound();
  const access = await loadFileVersionForRead(slug, versionNumber);
  if (access.status === "signed-out") redirect(signInPath(pdfMapPath(slug, versionNumber)));
  // A past slug: the redirect names the version's page, and its map is beside it.
  if (access.status === "redirect") redirect(`${access.to}/map`);
  if (access.status === "not-found") notFound();
  const forbidden = (
    <main className={styles.page}>
      <h1>Forbidden</h1>
      <p>A file&apos;s page maps are shown to whoever may manage it.</p>
    </main>
  );
  if (access.status === "forbidden") return forbidden;
  const {
    value: { file, shown },
    user,
  } = access;
  if (!(await canUserManageFile(user.id, user.role, file.id))) return forbidden;
  const view = await pageMapViewFor(file.id, shown.id);
  if (!view) notFound();

  const own = (number: number) => pdfPath(file.slug, { number, isLatest: false }, { own: true });
  const base = view.baseNumber;

  return (
    <main className={styles.page}>
      <h1>
        Page map of <a href={own(view.number)}>{readingTitle(file, { ...shown, address: "version" })}</a>
      </h1>
      {base === null ? (
        <p>Version {view.number} is this file&apos;s first, so it has no earlier version for its sheets to be matched with.</p>
      ) : view.map === null ? (
        <section data-testid="pdf-map-none">
          <p>
            The sheets of version {view.number} are not matched with those of version {base}, the version it was uploaded over.
          </p>
          {view.state === "abandoned" ? (
            <p>Version {view.number} was abandoned, and its text is gone, so they can&apos;t be matched now.</p>
          ) : (
            <>
              <p>
                <strong>Matching them says the two versions hold the same text.</strong> It moves no note. What it changes at once is where links land: a link
                that names either version is carried to the other from then on, and no longer opens the version it names. A map is stored once, and nothing
                takes it away. Leave a later draft unmatched: its links go on opening the draft they were written against.
              </p>
              <PdfMapActions versionId={view.versionId} build />
            </>
          )}
        </section>
      ) : (
        <>
          <section data-testid="pdf-map-numbers">
            <p>
              Each sheet of version {base} against version {view.number}: {view.map.numbers.paired} paired, {view.map.numbers.removed} removed,{" "}
              {view.map.numbers.unmapped} unmapped.
              {view.map.storedAt && (
                <>
                  {" "}
                  Stored <LocalTime value={view.map.storedAt} />
                  {view.map.storedBy && ` by ${view.map.storedBy}`}
                  {view.map.byCarry && ", by a carry of notes"}.
                </>
              )}
            </p>
            <p className={styles.quiet}>
              A link that names either version is carried to the other through this map. A link to a removed or an unmapped sheet is carried only by its words,
              where they are found once.
            </p>
          </section>

          {view.baseVersionId !== null && view.latestNumber !== null && (view.state === "latest" || view.state === "earlier") && (
            <section data-testid="pdf-map-carry">
              <h2>Notes</h2>
              <p className={styles.quiet}>
                A page map moves no note. A carry moves forward every posted note and minted link part on version {base} that places itself through it, and
                shows what it would do first. Run again after a run of sheets is paired, it takes the notes those sheets now reach.
              </p>
              <PdfCarryActions versionId={view.baseVersionId} number={base} latestNumber={view.latestNumber} />
            </section>
          )}
          {view.state === "candidate" && (
            <p className={styles.quiet} data-testid="pdf-map-carry-later">
              Version {view.number} is not yet the latest. Its promotion can carry the notes forward, from <a href={own(view.number)}>its own page</a>.
            </p>
          )}

          <PdfPageMapList slug={file.slug} number={view.number} baseNumber={base} versionId={view.versionId} map={view.map} />
        </>
      )}
    </main>
  );
}
