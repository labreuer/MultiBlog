import type { ReactNode } from "react";
import type { TitleRun } from "@/lib/references/markup";

// docs/CITATIONS.md, "What a record keeps", "Markup in a field" — a title's
// runs as markup: what a bibliography entry and a reference's page draw. No
// "use client": both render on the server first.

function wrapped(run: TitleRun): ReactNode {
  let node: ReactNode = run.text;
  for (const mark of run.marks ?? []) {
    if (mark === "italic") node = <i>{node}</i>;
    else if (mark === "bold") node = <b>{node}</b>;
    else if (mark === "sup") node = <sup>{node}</sup>;
    else if (mark === "sub") node = <sub>{node}</sub>;
    else if (mark === "smallCaps") node = <span style={{ fontVariant: "small-caps" }}>{node}</span>;
    // `nocase` says only that a style must not change the case: it draws as the text.
  }
  return node;
}

export default function TitleRuns({ runs }: { runs: readonly TitleRun[] }) {
  return (
    <>
      {runs.map((run, index) => (
        <span key={index}>{wrapped(run)}</span>
      ))}
    </>
  );
}
