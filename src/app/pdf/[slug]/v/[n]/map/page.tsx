import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import LocalTime from "@/components/LocalTime";
import PdfMapActions from "@/components/pdf/PdfMapActions";
import { canUserManageFile } from "@/lib/file-authz";
import { parseVersionNumber, pdfMapPath, pdfPath } from "@/lib/file-version";
import { pageMapViewFor, type MapRunView } from "@/lib/pdf-page-map-view";
import { titleWhenOk } from "@/lib/route-access";
import { signInPath } from "@/lib/sign-in-redirect";
import { loadFileVersionForRead, readingTitle } from "../../../reading";
import styles from "./page.module.css";

// docs/PDF.md §13, "Matching the pages" — a version's page map, at
// `/pdf/<slug>/v/<n>/map`: how its sheets pair with those of the version it
// was uploaded over, which were removed and which no rule could place, and
// the questions its runs of sheets raise, each answered here. Where the
// version has no map, this is where one is asked for.
//
// Open to whoever may manage the file: building a map and answering a run
// are theirs (`canUserManageFile`), and the page shows nothing a manager
// isn't given. It reads the same gate the version's own page does first, so
// a file its reader can't see answers as that page does.
//
// A sheet's link is a plain `<a>`, never a `<Link>`: it carries a fragment,
// which a client navigation would leave on the path (CLAUDE.md, Gotchas).

type Params = { params: Promise<{ slug: string; n: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, n } = await params;
  const versionNumber = parseVersionNumber(n);
  if (versionNumber === null) return {};
  return titleWhenOk(await loadFileVersionForRead(slug, versionNumber), ({ file, shown }) => `Page map: ${readingTitle(file, shown)}`);
}

const span = ([first, last]: [number, number]) => (first === last ? `${first}` : `${first}–${last}`);

const QUESTION: Record<MapRunView["kind"], string> = {
  labels: "Pair these sheets as their text does, where their labels pair them otherwise?",
  place: "Pair these sheets by their place, where their text is too unlike to say?",
};

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
  const sheetLink = (number: number, sheet: number) => <a href={`${own(number)}#sheet=${sheet}&v=${number}`}>{sheet}</a>;
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

          {view.map.runs.length > 0 && (
            <section>
              <h2>Questions</h2>
              {view.map.runs.map((run) => {
                const first = run.rows[0];
                const last = run.rows[run.rows.length - 1];
                return (
                  <article key={run.index} className={styles.run} data-testid="pdf-map-run" data-run-state={run.state}>
                    <h3>
                      {run.rows.length === 1 ? `Sheet ${first.baseSheet}` : `Sheets ${first.baseSheet}–${last.baseSheet}`} of version {base}
                    </h3>
                    <p>{QUESTION[run.kind]}</p>
                    <p className={styles.quiet}>
                      {run.state === "open" && "Nobody has answered. Until someone accepts, these sheets are unmapped."}
                      {run.state === "accepted" && (
                        <>
                          Accepted{run.answeredBy && ` by ${run.answeredBy}`}
                          {run.answeredAt && (
                            <>
                              , <LocalTime value={run.answeredAt} />
                            </>
                          )}
                          . The sheets are paired as proposed, and that stays.
                        </>
                      )}
                      {run.state === "declined" && (
                        <>
                          Declined{run.answeredBy && ` by ${run.answeredBy}`}
                          {run.answeredAt && (
                            <>
                              , <LocalTime value={run.answeredAt} />
                            </>
                          )}
                          . The sheets are unmapped. It may still be accepted.
                        </>
                      )}
                    </p>
                    <div className={styles.rows}>
                      <table>
                        <thead>
                          <tr>
                            <th>Version {base}</th>
                            {run.kind === "labels" && <th>By its label</th>}
                            <th>{run.kind === "labels" ? "By its text" : "By its place"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {run.rows.map((row) => (
                            <tr key={row.baseSheet}>
                              <td>
                                sheet {sheetLink(base, row.baseSheet)}
                                {row.baseLabel && ` (${row.baseLabel})`}
                                {row.baseText !== null && <span className={styles.excerpt}>{row.baseText || "(no text)"}</span>}
                              </td>
                              {run.kind === "labels" && <td>{row.byLabel === null ? "none" : <>sheet {sheetLink(view.number, row.byLabel)}</>}</td>}
                              <td>
                                sheet {sheetLink(view.number, row.proposed)}
                                {row.proposedLabel && ` (${row.proposedLabel})`}
                                {run.kind === "place" && row.labelAgrees && <em> The labels agree.</em>}
                                {row.proposedText !== null && <span className={styles.excerpt}>{row.proposedText || "(no text)"}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {run.state !== "accepted" && <PdfMapActions versionId={view.versionId} run={{ index: run.index, declined: run.state === "declined" }} />}
                  </article>
                );
              })}
            </section>
          )}

          <section>
            <h2>The sheets</h2>
            {view.map.paired.length > 0 && (
              <p data-testid="pdf-map-paired">
                Paired:{" "}
                {view.map.paired.map((pair, index) => (
                  <span key={pair.from[0]}>
                    {index > 0 && "; "}
                    {span(pair.from)} → {span(pair.to)}
                  </span>
                ))}
                .
              </p>
            )}
            {view.map.removed.length > 0 && (
              <p data-testid="pdf-map-removed">
                Removed, with nothing in their place in version {view.number}: {view.map.removed.map(span).join(", ")}.
              </p>
            )}
            {view.map.unmapped.length > 0 && (
              <p data-testid="pdf-map-unmapped">
                Unmapped, where sheets of version {view.number} stand and none is known to be it: {view.map.unmapped.map(span).join(", ")}.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
