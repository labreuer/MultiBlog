import type { JSONContent } from "@tiptap/core";
import { BIBLIOGRAPHY_HEADING, citationBibliography, type Bibliography } from "@/lib/entity-chips/kinds/citation-bibliography";
import { chipsInJSON } from "@/lib/entity-chips/renderings";
import type { ChipInputs } from "@/lib/entity-chips/types";
import { entryParts } from "@/lib/references/entry";
import DownloadMenu from "./DownloadMenu";
import TitleRuns from "./TitleRuns";
import styles from "./Bibliography.module.css";

// docs/CITATIONS.md, "The bibliography" — a doc's bibliography as markup.
// No "use client": the reading view and side-by-side render it on the
// server for their first paint, and LiveBibliography in the browser after.

/**
 * The list, or nothing for a doc that cites no work the context holds.
 * `download`, the selection its works are downloaded by (`doc=<id>`), puts a
 * download icon beside the heading.
 */
export default function BibliographyList({ bibliography, download }: { bibliography: Bibliography; download?: string }) {
  if (bibliography.items.length === 0) return null;
  return (
    <section className={styles.bibliography} data-bibliography={bibliography.form} aria-label={BIBLIOGRAPHY_HEADING}>
      <div className={styles.headingRow}>
        <h2 className={styles.heading}>{BIBLIOGRAPHY_HEADING}</h2>
        {download && <DownloadMenu selection={download} />}
      </div>
      <ul className={styles.list}>
        {bibliography.items.map((item) => (
          <li key={item.refId} className={`${styles.entry} ${item.deleted ? styles.deleted : ""}`} data-ref={item.refId}>
            {item.lead && <span className={styles.lead}>{item.lead} </span>}
            {entryParts(item.entry).map((part, index) => {
              if (!part.title) return <span key={index}>{part.text}</span>;
              const title = <TitleRuns runs={part.runs ?? [{ text: part.text }]} />;
              return item.href ? (
                <a key={index} href={item.href}>
                  {title}
                </a>
              ) : (
                <span key={index}>{title}</span>
              );
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The bibliography of a doc body as a static render shows it, from the inputs its labels were computed with. */
export function StaticBibliography({ body, inputs, download }: { body: JSONContent; inputs: ChipInputs; download?: string }) {
  return <BibliographyList bibliography={citationBibliography(chipsInJSON(body), inputs.styles, inputs.context)} download={download} />;
}
