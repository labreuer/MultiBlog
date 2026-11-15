import type { Actor } from "@/lib/actor";
import { carriesOf } from "@/lib/file-anchor-move";
import { candidateFactsFor, type CandidateFacts } from "@/lib/file-version-candidate";
import { mintedPartsByVersion, postedNotesByVersion, summariseVersions, VERSION_SUMMARY_SELECT, type FileVersionSummary } from "@/lib/file-version-data";
import { pageMapViewFor, type PageMapView } from "@/lib/pdf-page-map-view";
import type { Prisma } from "@/generated/prisma/client";

// docs/PDF.md §14, "What the page holds", item 6 — what a file's manage page
// reads for its versions section: everything §13 gives a manager about a
// file's versions, which the viewer's Metadata pane no longer shows. The page
// has already run `canUserManageFile`. Server-only.

/** The select this reads, for the page's file query to take along. */
export const VERSIONS_SELECT = { select: VERSION_SUMMARY_SELECT } as const;

export type ManagedVersions = {
  versions: FileVersionSummary[];
  /** Whether the file takes a new version at all: a PDF with page text does, a .docx doesn't. */
  takesVersions: boolean;
  /** How many posted notes are on each version, by version id: what is still on an earlier one until a carry or its author moves it. */
  notesOn: Record<string, number>;
  /** How many parts of minted links are on each version, by version id. */
  partsOn: Record<string, number>;
  /** The bulk carries that moved a note of this file, newest first (`carriesOf`). */
  carries: { id: string; toVersionId: string; at: string; moves: number; shown: number; hidden: boolean }[];
  /** What a promotion of the waiting version would do to the file's citations; null where none waits. */
  candidateFacts: CandidateFacts | null;
  /** The waiting version's page map, sheet by sheet; null where none waits or it has none. */
  candidateMap: NonNullable<PageMapView["map"]> | null;
  /**
   * Changes whenever the waiting version's map does: built, or a run of it
   * answered or un-paired. The card asks for its carry preview again on a
   * change, since the preview read the map.
   */
  candidateMapKey: string;
};

type Rows = { id: string; currentVersionId: string | null; versions: Prisma.FileVersionGetPayload<{ select: typeof VERSION_SUMMARY_SELECT }>[] };

export async function managedVersionsOf(actor: Actor, file: Rows, opts: { isPdf: boolean }): Promise<ManagedVersions> {
  const versions = summariseVersions(file);
  const latest = versions.find((version) => version.state === "latest");
  const waiting = versions.find((version) => version.state === "candidate");
  const several = versions.length > 1;
  const [notesOn, partsOn, carries, candidateFacts, view] = await Promise.all([
    several ? postedNotesByVersion(file.id) : {},
    several ? mintedPartsByVersion(file.id) : {},
    several ? carriesOf(file.id) : [],
    waiting && latest ? candidateFactsFor(actor, file.id, waiting, latest) : null,
    waiting?.map ? pageMapViewFor(file.id, waiting.id) : null,
  ]);
  const candidateMap = view?.map ?? null;
  return {
    versions,
    takesVersions: opts.isPdf && latest !== undefined && latest.pageCount !== null,
    notesOn,
    partsOn,
    carries,
    candidateFacts,
    candidateMap,
    candidateMapKey: candidateMap ? `map:${candidateMap.runs.map((run) => run.state).join(",")}` : "none",
  };
}
