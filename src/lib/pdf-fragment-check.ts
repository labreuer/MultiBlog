import { fileVersionState, pageStampFor, type FileVersionState } from "@/lib/file-version";
import { readFile } from "node:fs/promises";
import { prisma } from "./prisma";
import { resolveFileParam } from "./file-slug";
import { storagePathFor } from "./file-storage";
import { currentTextVersion, extractPdfMetadata } from "./pdf-extract";
import { sheetsNamed, usablePageLabels } from "./pdf-page-labels";
import { skeletonOf, type PassageText } from "./pdf-fragment";
import {
  checkPage,
  checkPassage,
  passageElsewhere,
  versionNamedBy,
  type FilePages,
  type FragmentLinkFinding,
  type FragmentLinkHref,
  type PageLinkFinding,
  type PassageFinding,
  type VersionFault,
} from "./pdf-fragment-findings";

// docs/PDF_FRAGMENT_LINKS.md §8 — the check every confirmation of a fragment
// link shares: the integrity script, run over everything or one doc, the
// one-quote CLI and MCP's write check. It resolves each passage against the
// file's stored page text, the text the viewer's own extraction reproduces,
// and says what it found. A page link (a `page` or a `p` and no `text`) is
// checked for its page alone. The viewer's miss asks it where the passage is
// instead (`sheetHolding`, §6).
//
// **Server-only, and it reads as the operator.** The scripts hold the
// database's credentials, where a read gate protects nothing. A front door
// that reads as a user (the MCP server, MCP.md §8, and the viewer's server
// action) must ask `canUserReadFile` before calling in, and answer a file the
// user can't read as not found, or the check becomes a way to ask what a
// PRIVATE file says.
//
// **A link is read as the viewer reads it** (docs/PDF.md §13, "Links into
// the file"): each page on the version it names, by that version's labels
// and page text. Its `v=` names the version, or without one the version the
// link's own address names, or the file's first. No version has a page map
// yet, so no link is carried, and the version a link names is the one it
// opens. A page that names an abandoned version, or one the file never had,
// has nothing to be read on, and its finding says which. What means "the
// file" with no link in hand (`pagesFor` and `pagesAt` without a version, a
// citation's quotation) reads the latest. Every read of page text below is by
// a version's id.
//
// **Read-only.** `storedPageText` extracts a version lazily when its text is
// missing at the current text version; this doesn't, so a check never writes.
// It reads the current text version where the file's version has it, and
// otherwise the newest it has, as search does (docs/FULLTEXT.md §4): a
// skeleton barely depends on the text version (src/lib/pdf-fragment.ts), so
// either answers. A `p=` needs the page labels: `file_version.page_labels`,
// or, where they haven't been read yet (NULL, filled on first read:
// docs/MCP.md §8), the labels read from the bytes and not stored.
//
// The pure half, the href's parse and the findings, is
// src/lib/pdf-fragment-findings.ts.

/** One version of a file, with the text version its pages are read at. */
type FileRef = Omit<FilePages, "pages" | "ownLabels"> & { versionId: string; sha256: string; storedLabels: unknown };
type PageMap = FilePages["pages"];

/** A file as the check holds it: every version it has, by number. */
type FileEntry = {
  fileId: string;
  slug: string;
  currentVersionId: string | null;
  versions: {
    id: string;
    number: number;
    sha256: string;
    pageCount: number | null;
    pageLabels: unknown;
    state: FileVersionState;
    uploadedAt: Date;
    uploadedAtUpdateId: bigint;
  }[];
};

const FILE_SELECT = {
  id: true,
  slug: true,
  deletedByUserId: true,
  currentVersionId: true,
  versions: {
    select: { id: true, number: true, sha256: true, pageCount: true, pageLabels: true, promotedAt: true, abandonedAt: true, uploadedAt: true, uploadedAtUpdateId: true },
  },
} as const;

type FileRow = {
  id: string;
  slug: string;
  deletedByUserId: string | null;
  currentVersionId: string | null;
  versions: {
    id: string;
    number: number;
    sha256: string;
    pageCount: number | null;
    pageLabels: unknown;
    promotedAt: Date | null;
    abandonedAt: Date | null;
    uploadedAt: Date;
    uploadedAtUpdateId: bigint;
  }[];
};

/**
 * Reads, for one run, each page a link names once, so a doc that quotes one
 * book 65 times reads those pages once.
 *
 * **It holds the pages links name, never every page of every file a run
 * touches** — one doc linking into 75 books named 26,000 pages, whose text and
 * skeletons took the web process past its heap. What `check` keeps grows with
 * the links, not the books. A whole version is read only for a miss, since its
 * `foundOnPage` looks at every page, and only the most recent such version is
 * held.
 */
export class FragmentChecker {
  private files = new Map<string, Promise<FileEntry | null>>();
  private refs = new Map<string, Promise<FileRef | null>>();
  // Labels and pages are a version's, so they are kept by version id.
  private labels = new Map<string, Promise<string[]>>();
  private cited = new Map<string, PageMap>();
  private whole: { versionId: string; pages: Promise<PageMap> } | null = null;
  private version: Promise<string> | null = null;

  /**
   * Every page of one version of the file a slug names now, past slugs
   * followed, with its labels: the latest, or the version numbered
   * `versionNumber`. Null for no such file or version, a deleted file, an
   * abandoned version, or one that isn't a PDF. Held until another version's
   * every page is asked for.
   */
  async pagesFor(slug: string, versionNumber?: number): Promise<FilePages | null> {
    const entry = await this.fileFor(slug);
    const file = entry ? await this.versionOf(entry, versionNumber ?? null) : null;
    if (!file || "kind" in file) return null;
    const [pages, ownLabels] = await Promise.all([this.wholeFile(file), this.labelsOf(file)]);
    return { ...file, ownLabels, pages };
  }

  /** The versions of the file a slug names, by number, with which is the latest; null for none, or a deleted one. */
  async versionsOf(slug: string): Promise<{ versions: { number: number; state: FileVersionState }[]; latest: number } | null> {
    const entry = await this.fileFor(slug);
    if (!entry) return null;
    const latest = entry.versions.find((version) => version.id === entry.currentVersionId);
    if (!latest) return null;
    return { versions: entry.versions.map(({ number, state }) => ({ number, state })), latest: latest.number };
  }

  /**
   * When the file a slug names gained its second version: the moment from
   * which a link into it without `v=` can only have been typed by hand
   * (docs/PDF.md §13, "Links into the file"). Null for a file with one
   * version.
   */
  async secondVersionMark(slug: string): Promise<{ updateId: bigint; at: Date } | null> {
    const second = (await this.fileFor(slug))?.versions.find((version) => version.number === 2);
    return second ? { updateId: second.uploadedAtUpdateId, at: second.uploadedAt } : null;
  }

  /**
   * The 1-based sheet holding `passage` when exactly one sheet outside
   * `named` (0-based) holds it, once: the viewer's question when a passage
   * isn't on the sheets its link names (§6). Null otherwise, and for a file
   * that is deleted or has no stored text. Reads the whole version's stored
   * text, and extracts nothing.
   *
   * `fileVersionId` is the version the viewer shows, which need not be the
   * latest (docs/PDF.md §13): the sheets it has looked on are that version's,
   * so the rest of that version is where the passage is looked for. A version
   * of another file answers null.
   */
  async sheetHolding(fileId: string, fileVersionId: string, passage: PassageText, named: readonly number[]): Promise<number | null> {
    const file = await this.fileVersionById(fileId, fileVersionId);
    if (!file) return null;
    return passageElsewhere({ pages: await this.wholeFile(file) }, passage, named);
  }

  /**
   * The pages at `indexes` (0-based) of the latest version of the file with
   * this id, with its own labels: what a citation's passage is placed against
   * (src/lib/cited-passage.ts). Null for a file that is deleted or isn't a
   * PDF. Kept for the run, as the pages links name are.
   */
  async pagesAt(fileId: string, indexes: readonly number[]): Promise<FilePages | null> {
    const entry = await this.fileById(fileId);
    const file = entry ? await this.versionOf(entry, null) : null;
    if (!file || "kind" in file) return null;
    await this.readInto(file, indexes);
    return { ...file, ownLabels: await this.labelsOf(file), pages: this.citedOf(file) };
  }

  private fileById(fileId: string): Promise<FileEntry | null> {
    let pending = this.files.get(`id:${fileId}`);
    if (!pending) {
      pending = prisma.storedFile.findUnique({ where: { id: fileId }, select: FILE_SELECT }).then((file) => (file ? entryFor(file) : null));
      this.files.set(`id:${fileId}`, pending);
    }
    return pending;
  }

  /** One version of a file, whatever its state; null where it isn't that file's, is abandoned, or the file is deleted. */
  private async fileVersionById(fileId: string, fileVersionId: string): Promise<FileRef | null> {
    const entry = await this.fileById(fileId);
    const version = entry?.versions.find((candidate) => candidate.id === fileVersionId);
    if (!entry || !version) return null;
    const file = await this.versionOf(entry, version.number);
    return file && !("kind" in file) ? file : null;
  }

  private fileFor(slug: string): Promise<FileEntry | null> {
    let pending = this.files.get(slug);
    if (!pending) {
      pending = resolveFileParam(slug, FILE_SELECT).then((resolved) => (resolved ? entryFor(resolved.file) : null));
      this.files.set(slug, pending);
    }
    return pending;
  }

  /**
   * One version of a file as the check reads it: the latest for null. A
   * version with nothing to read is the fault that says why (abandoned, or a
   * number the file never had); null for a file that isn't a PDF.
   */
  private async versionOf(entry: FileEntry, versionNumber: number | null): Promise<FileRef | VersionFault | null> {
    const version = versionNumber === null ? entry.versions.find((candidate) => candidate.id === entry.currentVersionId) : entry.versions.find((candidate) => candidate.number === versionNumber);
    if (!version) return versionNumber === null ? null : { kind: "no-such-version", version: versionNumber };
    if (version.state === "abandoned") return { kind: "abandoned-version", version: version.number };
    if (version.pageCount === null) return null;
    let pending = this.refs.get(version.id);
    if (!pending) {
      pending = (async (): Promise<FileRef> => {
        this.version ??= currentTextVersion();
        const current = await this.version;
        const held = await prisma.filePageText.groupBy({ by: ["textVersion"], where: { fileVersionId: version.id } });
        const names = held.map((row) => row.textVersion);
        return {
          fileId: entry.fileId,
          versionId: version.id,
          versionNumber: version.number,
          stamp: pageStampFor(version.number, entry.versions.length),
          slug: entry.slug,
          sha256: version.sha256,
          pageCount: version.pageCount!,
          textVersion: names.includes(current) ? current : (names.sort().at(-1) ?? null),
          storedLabels: version.pageLabels,
        };
      })();
      this.refs.set(version.id, pending);
    }
    return pending;
  }

  /** The version's own labels: as stored, or read from its bytes and not stored where they haven't been read yet. [] when they can't be read. */
  private labelsOf(file: FileRef): Promise<string[]> {
    let pending = this.labels.get(file.versionId);
    if (!pending) {
      const stored = file.storedLabels;
      pending = Array.isArray(stored)
        ? Promise.resolve(stored.map((label) => (typeof label === "string" ? label : "")))
        : readFile(storagePathFor(file.sha256))
            .then((bytes) => extractPdfMetadata(bytes))
            .then((metadata) => metadata.pageLabels)
            .catch((error: unknown) => {
              console.error(`[pdf-fragment-check] couldn't read the page labels of file ${file.fileId}, version ${file.versionNumber}:`, error);
              return [];
            });
      this.labels.set(file.versionId, pending);
    }
    return pending;
  }

  private wholeFile(file: FileRef): Promise<PageMap> {
    if (this.whole?.versionId !== file.versionId) {
      this.whole = { versionId: file.versionId, pages: this.readPages(file, null) };
    }
    return this.whole.pages;
  }

  /** The pages of a version that links have named so far. */
  private citedOf(file: FileRef): PageMap {
    let cited = this.cited.get(file.versionId);
    if (!cited) {
      cited = new Map();
      this.cited.set(file.versionId, cited);
    }
    return cited;
  }

  /** Reads the pages at `indexes` that the run doesn't hold yet. */
  private async readInto(file: FileRef, indexes: readonly number[]): Promise<void> {
    const cited = this.citedOf(file);
    const toRead = [...new Set(indexes)].filter((index) => index >= 0 && index < file.pageCount && !cited.has(index));
    for (const [index, page] of await this.readPages(file, toRead)) cited.set(index, page);
  }

  /** The pages at `indexes`, or every page for null. */
  private async readPages(file: FileRef, indexes: readonly number[] | null): Promise<PageMap> {
    const pages: PageMap = new Map();
    if (file.textVersion === null || indexes?.length === 0) return pages;
    const rows = await prisma.filePageText.findMany({
      where: { fileVersionId: file.versionId, textVersion: file.textVersion, ...(indexes ? { pageIndex: { in: [...indexes] } } : {}) },
      select: { pageIndex: true, text: true },
    });
    for (const row of rows) pages.set(row.pageIndex, { text: row.text, skeleton: skeletonOf(row.text) });
    return pages;
  }

  /**
   * One passage on the version numbered `versionNumber` of the file a slug
   * names, whatever version the passage itself names: what MCP's write check
   * asks to say where an unstamped link's words are (docs/PDF.md §13, "Links
   * into the file"). Null where there is no such file to read.
   */
  async checkPassageOn(slug: string, versionNumber: number, passage: FragmentLinkHref["passages"][number]): Promise<PassageFinding | null> {
    const entry = await this.fileFor(slug);
    if (!entry) return null;
    return this.passageOn(entry, versionNumber, passage);
  }

  /** A page link's page on the version numbered `versionNumber`, as `checkPassageOn` reads a passage. */
  async checkPageOn(slug: string, versionNumber: number, page: NonNullable<FragmentLinkHref["page"]>): Promise<PageLinkFinding | null> {
    const entry = await this.fileFor(slug);
    if (!entry) return null;
    const file = await this.versionOf(entry, versionNumber);
    if (!file) return null;
    if ("kind" in file) return file;
    return checkPage(file, "label" in page ? await this.labelsOf(file) : null, page);
  }

  private async passageOn(entry: FileEntry, versionNumber: number, passage: FragmentLinkHref["passages"][number]): Promise<PassageFinding | null> {
    const file = await this.versionOf(entry, versionNumber);
    if (!file) return null;
    if ("kind" in file) return { ...file, passage };
    const ownLabels = "label" in passage.page ? await this.labelsOf(file) : null;
    await this.readInto(file, sheetsNamed(passage.page, ownLabels, file.pageCount));
    // Only the pages links name, so a miss is asked again of the whole
    // version, the one finding that reads past its own page.
    const named: FilePages = { ...file, ownLabels, pages: this.citedOf(file) };
    const finding = checkPassage(named, passage);
    return finding.kind === "no-match" || finding.kind === "no-such-label" ? checkPassage({ ...named, pages: await this.wholeFile(file) }, passage) : finding;
  }

  async check(link: FragmentLinkHref): Promise<FragmentLinkFinding> {
    const entry = await this.fileFor(link.slug);
    const latest = entry?.versions.find((version) => version.id === entry.currentVersionId);
    if (!entry || !latest || latest.pageCount === null) return { kind: "unknown-file", slug: link.slug };
    const checked = {
      kind: "checked" as const,
      slug: link.slug,
      currentSlug: entry.slug,
      fileId: entry.fileId,
      versionCount: entry.versions.length,
      latestVersion: latest.number,
      addressVersion: link.version,
    };

    // Whether each version a `p=` is read on has usable labels: false if any lacks them.
    const labelled: boolean[] = [];
    const usableOn = async (versionNumber: number, page: FragmentLinkHref["passages"][number]["page"]) => {
      if (!("label" in page)) return;
      const file = await this.versionOf(entry, versionNumber);
      if (file && !("kind" in file)) labelled.push(usablePageLabels(await this.labelsOf(file), file.pageCount) !== null);
    };
    const usableLabels = () => (labelled.length === 0 ? null : labelled.every(Boolean));

    if (link.page) {
      const version = versionNamedBy(link, link.page);
      await usableOn(version, link.page);
      const page = await this.checkPageOn(link.slug, version, link.page);
      if (!page) return { kind: "unknown-file", slug: link.slug };
      return { ...checked, passages: [], page, usableLabels: usableLabels(), unread: 0 };
    }

    const passages: PassageFinding[] = [];
    for (const passage of link.passages) {
      const version = versionNamedBy(link, passage.page);
      await usableOn(version, passage.page);
      const finding = await this.passageOn(entry, version, passage);
      if (!finding) return { kind: "unknown-file", slug: link.slug };
      passages.push(finding);
    }
    return { ...checked, passages, page: null, usableLabels: usableLabels(), unread: link.unread };
  }
}

/** A file's row as the check holds it, or null for a deleted one. */
function entryFor(file: FileRow): FileEntry | null {
  if (file.deletedByUserId !== null) return null;
  return {
    fileId: file.id,
    slug: file.slug,
    currentVersionId: file.currentVersionId,
    versions: file.versions
      .map((version) => ({
        id: version.id,
        number: version.number,
        sha256: version.sha256,
        pageCount: version.pageCount,
        pageLabels: version.pageLabels,
        state: fileVersionState(version, file.currentVersionId),
        uploadedAt: version.uploadedAt,
        uploadedAtUpdateId: version.uploadedAtUpdateId,
      }))
      .sort((a, b) => a.number - b.number),
  };
}
