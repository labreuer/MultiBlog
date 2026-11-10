// docs/CITATIONS.md, "The readers", `.nbib` — PubMed's only export a
// citation manager reads: MEDLINE's tagged format, a four-character tag, a
// hyphen and a value, a value going on over lines indented six spaces, and a
// blank line between records. Read by hand, since citation-js's PubMed plugin
// only fetches a record by its id.
//
// Pure and browser-safe. Each record is a raw CSL-JSON object, for
// `parseCslItem` to build field by field.

type Tagged = Map<string, string[]>;

/** The records of a MEDLINE file, each as its tags' values in order. */
function records(text: string): Tagged[] {
  const out: Tagged[] = [];
  let current: Tagged | null = null;
  let last: { tag: string; index: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const tagged = /^([A-Z][A-Z0-9]{1,3})\s*-\s?(.*)$/.exec(line);
    if (tagged && line.length >= 5 && line[4] === "-") {
      const [, tag, value] = tagged;
      if (tag === "PMID" || !current) {
        current = new Map();
        out.push(current);
      }
      const values = current.get(tag) ?? [];
      values.push(value.trim());
      current.set(tag, values);
      last = { tag, index: values.length - 1 };
    } else if (current && last && /^\s{2,}\S/.test(line)) {
      const values = current.get(last.tag)!;
      values[last.index] = `${values[last.index]} ${line.trim()}`;
    } else if (!line.trim()) {
      last = null;
    }
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2020 Dec 31", "2020 Dec", "2020 Dec-2021 Jan", "2020": the first date's parts. */
function publicationDate(value: string | undefined): { "date-parts": number[][] } | undefined {
  const match = /^(\d{4})(?:\s+([A-Za-z]{3})[a-z]*(?:\s+(\d{1,2}))?)?/.exec(value ?? "");
  if (!match) return undefined;
  const parts = [Number(match[1])];
  const month = match[2] ? MONTHS.indexOf(match[2].toLowerCase()) + 1 : 0;
  if (month > 0) {
    parts.push(month);
    if (match[3]) parts.push(Number(match[3]));
  }
  return { "date-parts": [parts] };
}

/** "Polack, Fernando P" as a CSL name. */
function fullName(value: string): { family: string; given?: string } | { literal: string } {
  const [family, ...given] = value.split(",");
  return given.join(",").trim() ? { family: family.trim(), given: given.join(",").trim() } : { literal: value.trim() };
}

/** "Polack FP", MEDLINE's short form, when a record has no full names: the last word is the initials. */
function shortName(value: string): { family: string; given?: string } | { literal: string } {
  const words = value.trim().split(/\s+/);
  if (words.length < 2 || !/^[A-Z]{1,4}$/.test(words.at(-1)!)) return { literal: value.trim() };
  return { family: words.slice(0, -1).join(" "), given: words.at(-1)!.split("").join(". ") + "." };
}

/** The value tagged `[doi]` among an `AID` or `LID`'s values. */
function doiOf(values: string[] | undefined): string | undefined {
  return values?.map((value) => /^(.*\S)\s*\[doi\]$/.exec(value)?.[1]).find(Boolean);
}

export type NbibRecord = { label: string; raw: Record<string, unknown> };

/**
 * The records of a PubMed `.nbib` file as raw CSL-JSON. `AID … [doi]` is a
 * record's DOI, and `LID … [doi]` is where a paper online ahead of print
 * keeps it. A group author (`CN`) is a name that isn't split.
 */
export function readNbib(text: string): NbibRecord[] {
  return records(text).map((record, index) => {
    const one = (tag: string) => record.get(tag)?.[0];
    const title = one("TI")?.replace(/\.$/, "");
    const names = record.has("FAU") ? record.get("FAU")!.map(fullName) : (record.get("AU") ?? []).map(shortName);
    const collective = (record.get("CN") ?? []).map((literal) => ({ literal }));
    const types = record.get("PT") ?? [];
    const issns = [...new Set((record.get("IS") ?? []).map((value) => value.replace(/\s*\(.*\)\s*$/, "").trim()).filter(Boolean))];
    return {
      label: `PubMed record ${one("PMID") ?? index + 1}`,
      raw: {
        type: types.some((type) => /^preprint$/i.test(type)) ? "article" : "article-journal",
        title,
        author: [...names, ...collective],
        issued: publicationDate(one("DP")),
        "container-title": one("JT"),
        volume: one("VI"),
        issue: one("IP"),
        page: one("PG"),
        DOI: doiOf(record.get("AID")) ?? doiOf(record.get("LID")),
        abstract: one("AB"),
        ISSN: issns.length > 0 ? issns.join(", ") : undefined,
        PMID: one("PMID"),
        PMCID: one("PMC"),
      },
    };
  });
}
