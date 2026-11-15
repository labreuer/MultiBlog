"use client";

import { useState, type ReactNode } from "react";
import LocalTime from "@/components/LocalTime";
import PdfMapActions from "@/components/pdf/PdfMapActions";
import { pdfPath } from "@/lib/file-version";
import { formatPageName } from "@/lib/pdf-open-params";
import { rowSheetsOn, sheetRanges, type MapRow } from "@/lib/pdf-page-map-rows";
import type { MapRunSheet, MapRunView, PageMapView } from "@/lib/pdf-page-map-view";
import styles from "./PdfPageMapList.module.css";

// docs/PDF.md §14, "A version's page map, sheet by sheet" — a page map as a
// list: every sheet of the base, in order, in rows, with a strip above that
// draws the whole base and scrolls to a row, and "Questions only" to hide
// every row but the questions. A question's card is in its row and says what
// is going on in words, with its two choices.
//
// One component, so that every page drawing a map draws the same list: the
// map page, and a candidate's card on the file's manage page. On either, an
// answer to a question refreshes the page, and its row changes in place.
//
// A sheet's link is a plain `<a>`, never a `<Link>`: it carries a fragment,
// which a client navigation would leave on the path (CLAUDE.md, Gotchas).
// The strip's links are fragments of this page alone.

type Props = {
  slug: string;
  number: number;
  baseNumber: number;
  versionId: string;
  map: NonNullable<PageMapView["map"]>;
  /** The list's heading: an h2 on the map page, an h3 under a candidate's card. */
  heading?: "h2" | "h3";
  /** Whether each sheet links to the viewer: not on a deleted file's page, where `/pdf/<slug>` is a 404 or another file's. */
  linked?: boolean;
};

/** How many pairs a matched stretch lists at each end when expanded. */
const ENDS = 3;
/** The most pairs between its ends that a matched stretch lists for what they say: more are only counted. */
const FEW = 20;
/** The most ranges a list of sheets names before counting the rest. */
const RANGES = 6;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const span = ([first, last]: [number, number]) => (first === last ? `${first}` : `${first}–${last}`);
const sheetCount = ([first, last]: [number, number]) => last - first + 1;
const capitalized = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`;
const pageOf = (label: string) => (label.trim() === "" ? "" : ` (p. ${label.trim()})`);

/** Sheets named as ranges where they are consecutive: "sheets 14–15", "sheet 3", "sheets 2, 4–5". */
function sheetsNamed(sheets: readonly number[]): string {
  const ranges = sheetRanges(sheets);
  const named = ranges.slice(0, RANGES).map(span).join(", ");
  const rest = ranges.slice(RANGES).reduce((sum, range) => sum + sheetCount(range), 0);
  const word = sheets.length === 1 ? "sheet" : "sheets";
  return rest > 0 ? `${word} ${named} and ${plural(rest, "more")}` : `${word} ${named}`;
}

function rowSheets(row: MapRow): number {
  return row.kind === "added" ? sheetCount(row.version) : sheetCount(row.base);
}

/** A run that is still a question: open, or left unmatched, which can still be paired. */
const isQuestion = (row: MapRow, runs: readonly MapRunView[]) => row.kind === "run" && runs[row.run].state !== "accepted";

export default function PdfPageMapList({ slug, number, baseNumber, versionId, map, heading: Heading = "h2", linked = true }: Props) {
  const [questionsOnly, setQuestionsOnly] = useState(false);
  // Written as every link into a file is (`formatPageName`), stamped with its version: a map is of a file with two at least.
  const sheetLink = (version: number, sheet: number): ReactNode =>
    linked ? <a href={`${pdfPath(slug, { number: version, isLatest: false }, { own: true })}#${formatPageName({ sheet, stamp: version })}`}>{sheet}</a> : sheet;
  const spanLinks = (version: number, [first, last]: [number, number]): ReactNode =>
    first === last ? (
      sheetLink(version, first)
    ) : (
      <>
        {sheetLink(version, first)}–{sheetLink(version, last)}
      </>
    );
  const listLinks = (version: number, sheets: readonly number[]): ReactNode => {
    const ranges = sheetRanges(sheets);
    const rest = ranges.slice(RANGES).reduce((sum, range) => sum + sheetCount(range), 0);
    return (
      <>
        {ranges.slice(0, RANGES).map((range, index) => (
          <span key={range[0]}>
            {index > 0 && ", "}
            {spanLinks(version, range)}
          </span>
        ))}
        {rest > 0 && ` and ${plural(rest, "more")}`}
      </>
    );
  };
  const questions = map.rows.filter((row) => isQuestion(row, map.runs)).length;

  return (
    <section className={styles.list} data-testid="pdf-map-list">
      <Heading>The sheets</Heading>
      <nav className={styles.strip} aria-label={`Every sheet of version ${baseNumber}, by row`} data-testid="pdf-map-strip">
        {map.rows.map((row, index) => {
          const kind = row.kind === "run" ? `run-${map.runs[row.run].state}` : row.kind;
          const pages = map.rowPages[index];
          const label =
            row.kind === "added"
              ? `Added in version ${number}: ${sheetsNamed(rowSheetsOn(row, "version"))}${pages.version ? ` (${pages.version})` : ""}`
              : `${capitalized(sheetsNamed(rowSheetsOn(row, "base")))}${pages.base ? ` (${pages.base})` : ""} of version ${baseNumber}: ${KIND_WORD[kind as keyof typeof KIND_WORD]}`;
          return (
            <a
              key={index}
              href={`#map-row-${index}`}
              className={`${styles.segment} ${styles[`segment-${kind}`] ?? ""}`}
              style={row.kind === "added" ? undefined : { flexGrow: rowSheets(row) }}
              title={label}
              aria-label={label}
            />
          );
        })}
      </nav>
      {questions > 0 && (
        <label className={styles.questionsOnly}>
          <input type="checkbox" checked={questionsOnly} onChange={(event) => setQuestionsOnly(event.target.checked)} data-testid="pdf-map-questions-only" />{" "}
          Questions only ({questions})
        </label>
      )}
      <ol className={styles.rows}>
        {map.rows.map((row, index) => (
          <li
            key={index}
            id={`map-row-${index}`}
            className={styles.row}
            data-testid="pdf-map-row"
            data-row-kind={row.kind}
            hidden={questionsOnly && !isQuestion(row, map.runs)}
          >
            <div className={styles.rowSheets}>
              <span>
                {row.kind === "added" ? "—" : spanLinks(baseNumber, row.base)}
                {map.rowPages[index].base && <span className={styles.pages}> ({map.rowPages[index].base})</span>}
              </span>
              <span aria-label="to">→</span>
              <span>
                {row.kind === "matched" || row.kind === "added"
                  ? spanLinks(number, row.version)
                  : row.kind === "run"
                    ? listLinks(number, row.version)
                    : "—"}
                {map.rowPages[index].version && <span className={styles.pages}> ({map.rowPages[index].version})</span>}
              </span>
              <span className={styles.count}>{plural(rowSheets(row), "sheet")}</span>
            </div>
            <RowBody row={row} number={number} baseNumber={baseNumber} runs={map.runs} versionId={versionId} sheetLink={sheetLink} />
          </li>
        ))}
      </ol>
    </section>
  );
}

const KIND_WORD = {
  matched: "paired",
  removed: "removed",
  unmapped: "unmapped, nothing proposed",
  "run-open": "a question",
  "run-declined": "left unmatched",
  "run-accepted": "paired by an answer",
} as const;

type BodyProps = {
  row: MapRow;
  number: number;
  baseNumber: number;
  runs: readonly MapRunView[];
  versionId: string;
  sheetLink: (version: number, sheet: number) => ReactNode;
};

function RowBody({ row, number, baseNumber, runs, versionId, sheetLink }: BodyProps) {
  if (row.kind === "removed") {
    return <p className={styles.what}>Removed: nothing stands in {sheetCount(row.base) === 1 ? "its" : "their"} place in version {number}.</p>;
  }
  if (row.kind === "unmapped") {
    return (
      <p className={styles.what}>
        Unmapped, with nothing proposed: sheets of version {number} stand where {sheetCount(row.base) === 1 ? "it stood, and none is known to be it" : "they stood, and none is known to be them"}.
      </p>
    );
  }
  if (row.kind === "added") {
    return (
      <p className={styles.what}>
        Added in version {number}: no sheet of version {baseNumber} goes to {sheetCount(row.version) === 1 ? "it" : "them"}.
      </p>
    );
  }
  if (row.kind === "run") return <RunCard run={runs[row.run]} number={number} baseNumber={baseNumber} versionId={versionId} sheetLink={sheetLink} />;
  return <MatchedBody row={row} number={number} baseNumber={baseNumber} sheetLink={sheetLink} />;
}

function MatchedBody({ row, number, baseNumber, sheetLink }: { row: Extract<MapRow, { kind: "matched" }> } & Omit<BodyProps, "row" | "runs" | "versionId">) {
  const count = sheetCount(row.base);
  const moved =
    row.offset === 0
      ? count === 1
        ? "in its place"
        : "each in its place"
      : `${plural(Math.abs(row.offset), "sheet")} ${row.offset < 0 ? "earlier" : "later"} in version ${number}`;
  const facts: string[] = [];
  if (row.labelsAgree !== null) {
    facts.push(
      count === 1
        ? row.labelsAgree === 1
          ? "The page numbers agree"
          : row.labelsDiffer!.length > 0
            ? "The page numbers differ"
            : "Neither has a page number"
        : `Their page numbers agree on ${row.labelsAgree}`,
    );
  }
  if (row.withoutText !== null && row.withoutText.length > 0) {
    facts.push(count === 1 ? "a sheet has no text" : `${row.withoutText.length} ${row.withoutText.length === 1 ? "has" : "have"} a sheet without text`);
  }
  const sentence = facts.join(", and ");
  const said = sentence === "" ? "" : ` ${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
  return (
    <>
      <p className={styles.what}>
        Paired, {moved}.{said}
      </p>
      {count > 1 && <Pairs row={row} baseNumber={baseNumber} number={number} sheetLink={sheetLink} />}
    </>
  );
}

/** A matched stretch's pairs: the first and last few, and between them the ones whose page numbers differ or that have a sheet without text, where they are few. */
function Pairs({ row, number, baseNumber, sheetLink }: { row: Extract<MapRow, { kind: "matched" }> } & Omit<BodyProps, "row" | "runs" | "versionId">) {
  const [first, last] = row.base;
  const differ = new Set(row.labelsDiffer ?? []);
  const without = new Set(row.withoutText ?? []);
  const notable = new Set([...differ, ...without]);
  const shown = new Set<number>();
  for (let sheet = first; sheet <= Math.min(last, first + ENDS - 1); sheet++) shown.add(sheet);
  for (let sheet = Math.max(first, last - ENDS + 1); sheet <= last; sheet++) shown.add(sheet);
  if (notable.size <= FEW) for (const sheet of notable) shown.add(sheet);
  const sheets = [...shown].sort((a, b) => a - b);
  const items: ReactNode[] = [];
  let previous = first - 1;
  for (const sheet of sheets) {
    if (sheet > previous + 1) {
      items.push(
        <li key={`gap-${sheet}`} className={styles.gap}>
          … {plural(sheet - previous - 1, "more pair")}
        </li>,
      );
    }
    const notes = [differ.has(sheet) && "page numbers differ", without.has(sheet) && "a sheet has no text"].filter(Boolean).join("; ");
    items.push(
      <li key={sheet}>
        {sheetLink(baseNumber, sheet)} → {sheetLink(number, sheet + row.offset)}
        {notes && <span className={styles.note}> ({notes})</span>}
      </li>,
    );
    previous = sheet;
  }
  return (
    <details className={styles.pairs}>
      <summary>
        The pairs{notable.size > FEW && `: ${notable.size} between the ends say something, too many to list`}
      </summary>
      <ol>{items}</ol>
    </details>
  );
}

function RunCard({ run, number, baseNumber, versionId, sheetLink }: { run: MapRunView } & Omit<BodyProps, "row" | "runs">) {
  const all = run.sheets;
  let opening: string;
  if (run.kind === "place") {
    opening = `The words of ${all.length === 1 ? "this sheet" : "these sheets"} are too unlike any sheet's of version ${number} to pair ${all.length === 1 ? "it" : "them"} unasked. By ${all.length === 1 ? "its" : "their"} place, ${all.length === 1 ? "it" : "they"} would go to ${sheetsNamed(all.map((sheet) => sheet.proposed))}.`;
  } else {
    const given = all.filter((sheet) => sheet.line === "refused" || sheet.line === "label-other");
    if (given.length === 0) {
      opening = `${all.length === 1 ? "This sheet stands" : "These sheets stand"} between sheets whose pairing is in question, and ${all.length === 1 ? "is" : "are"} placed by counting from them.`;
    } else {
      const who = given.length === all.length ? (all.length === 1 ? "this sheet" : "these sheets") : `${sheetsNamed(given.map((sheet) => sheet.baseSheet))} of version ${baseNumber}`;
      const goes = `By their printed page numbers, ${who} would go to ${sheetsNamed(given.map((sheet) => sheet.byLabel!))} of version ${number}.`;
      const words = sheetsNamed(given.map((sheet) => sheet.proposed));
      opening = given.every((sheet) => sheet.line === "refused")
        ? `${goes} The words there are a different page's. The words are on ${words}.`
        : `${goes} The map proposes ${words}, from their words.`;
    }
  }
  const pair = run.kind === "labels" ? "by their words" : "by their place";
  return (
    <article className={styles.run} data-testid="pdf-map-run" data-run-state={run.state}>
      <p>{opening}</p>
      <p className={styles.quiet}>
        {run.state === "open" && "Nobody has answered. Until someone pairs them, these sheets are unmapped."}
        {run.state === "accepted" && (
          <>
            Paired {pair}
            {run.answeredBy && ` by ${run.answeredBy}`}
            {run.answeredAt && (
              <>
                , <LocalTime value={run.answeredAt} />
              </>
            )}
            .
          </>
        )}
        {run.state === "declined" && (
          <>
            Left unmatched{run.answeredBy && ` by ${run.answeredBy}`}
            {run.answeredAt && (
              <>
                , <LocalTime value={run.answeredAt} />
              </>
            )}
            . These sheets are unmapped, and can still be paired.
          </>
        )}
      </p>
      <div className={styles.runSheets}>
        <table>
          <thead>
            <tr>
              <th>Version {baseNumber}</th>
              <th>Version {number}, proposed</th>
            </tr>
          </thead>
          <tbody>
            {all.map((sheet) => (
              <tr key={sheet.baseSheet}>
                <td>
                  sheet {sheetLink(baseNumber, sheet.baseSheet)}
                  {pageOf(sheet.baseLabel)}
                  {sheet.baseText !== null && <span className={styles.excerpt}>{sheet.baseText || "(no text)"}</span>}
                </td>
                <td>
                  sheet {sheetLink(number, sheet.proposed)}
                  {pageOf(sheet.proposedLabel)}
                  {sheet.proposedText !== null && <span className={styles.excerpt}>{sheet.proposedText || "(no text)"}</span>}
                  <SheetLine sheet={sheet} number={number} sheetLink={sheetLink} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {run.state !== "accepted" && (
        <>
          <p className={styles.quiet}>
            Pairing them {pair} carries links to these sheets to the sheets proposed, and lets a carry move the notes on them. Un-pairing them later makes
            them a question again, and leaves where it was any note a carry has moved meanwhile.
            {run.state === "open" &&
              " Left unmatched, a link to them is carried only where its words are found, and a note on them stays where it is until its author moves it. Sheets left unmatched can still be paired."}
          </p>
          <PdfMapActions versionId={versionId} run={{ index: run.index, kind: run.kind, declined: run.state === "declined" }} />
        </>
      )}
      {run.state === "accepted" && (
        <PdfMapActions versionId={versionId} unpair={{ index: run.index, carried: run.carried ?? 0, baseNumber, number }} />
      )}
    </article>
  );
}

function SheetLine({ sheet, number, sheetLink }: { sheet: MapRunSheet; number: number; sheetLink: BodyProps["sheetLink"] }) {
  const not =
    sheet.byLabel === null ? null : (
      <>
        Not sheet {sheetLink(number, sheet.byLabel)}
        {pageOf(sheet.byLabelLabel)}, whose page number matches
      </>
    );
  let said: ReactNode;
  switch (sheet.line) {
    case "refused":
      said = (
        <>
          {not}: its words are a different page&apos;s.
          {sheet.byLabelText !== null && <span className={styles.excerpt}>{sheet.byLabelText || "(no text)"}</span>}
        </>
      );
      break;
    case "no-text":
      said = <>{not}. There is no text to compare, so it goes with the sheets around it.</>;
      break;
    case "label-other":
      said = <>{not}.</>;
      break;
    case "counted":
      said = "Its page number gives it no sheet. It is placed by counting from the sheets around it.";
      break;
    case "agrees":
      said = "Its page number agrees.";
      break;
    case "differs":
      said = "Its page number doesn't agree.";
      break;
    default:
      return null;
  }
  return (
    <span className={styles.sheetLine} data-testid="pdf-map-run-line" data-line={sheet.line}>
      {said}
    </span>
  );
}
