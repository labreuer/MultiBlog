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
  type FilePages,
  type FragmentLinkFinding,
  type FragmentLinkHref,
  type PassageFinding,
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
// **Read-only.** `storedPageText` extracts a file lazily when its text is
// missing at the current version; this doesn't, so a check never writes.
// It reads the current version where the file has one, and otherwise the
// newest it has, as search does (docs/FULLTEXT.md §4): a skeleton barely
// depends on the version (src/lib/pdf-fragment.ts), so either answers. A
// `p=` needs the file's page labels: `file.page_labels`, or, for a file whose
// labels haven't been read yet (NULL, filled on first read: docs/MCP.md §8),
// the labels read from its bytes and not stored.
//
// The pure half, the href's parse and the findings, is
// src/lib/pdf-fragment-findings.ts.

type FileRef = Omit<FilePages, "pages" | "ownLabels"> & { sha256: string; storedLabels: unknown };
type PageMap = FilePages["pages"];

const FILE_SELECT = { id: true, slug: true, sha256: true, pageCount: true, pageLabels: true, deletedByUserId: true } as const;

/**
 * Reads, for one run, each page a link names once, so a doc that quotes one
 * book 65 times reads those pages once.
 *
 * **It holds the pages links name, never every page of every file a run
 * touches** — one doc linking into 75 books named 26,000 pages, whose text and
 * skeletons took the web process past its heap. What `check` keeps grows with
 * the links, not the books. A whole file is read only for a miss, since its
 * `foundOnPage` looks at every page, and only the most recent such file is
 * held.
 */
export class FragmentChecker {
  private files = new Map<string, Promise<FileRef | null>>();
  private labels = new Map<string, Promise<string[]>>();
  private cited = new Map<string, PageMap>();
  private whole: { fileId: string; pages: Promise<PageMap> } | null = null;
  private version: Promise<string> | null = null;

  /**
   * Every page of the file a slug names now, past slugs followed, with its
   * labels; null for none, or a deleted one. Held until another file's every
   * page is asked for.
   */
  async pagesFor(slug: string): Promise<FilePages | null> {
    const file = await this.fileFor(slug);
    if (!file) return null;
    const [pages, ownLabels] = await Promise.all([this.wholeFile(file), this.labelsOf(file)]);
    return { ...file, ownLabels, pages };
  }

  /**
   * The 1-based sheet holding `passage` when exactly one sheet outside
   * `named` (0-based) holds it, once: the viewer's question when a passage
   * isn't on the sheets its link names (§6). Null otherwise, and for a file
   * that is deleted or has no stored text. Reads the whole file's stored
   * text, and extracts nothing.
   */
  async sheetHolding(fileId: string, passage: PassageText, named: readonly number[]): Promise<number | null> {
    let pending = this.files.get(`id:${fileId}`);
    if (!pending) {
      pending = prisma.storedFile.findUnique({ where: { id: fileId }, select: FILE_SELECT }).then((file) => (file ? this.refFor(file) : null));
      this.files.set(`id:${fileId}`, pending);
    }
    const file = await pending;
    if (!file) return null;
    return passageElsewhere({ pages: await this.wholeFile(file) }, passage, named);
  }

  private fileFor(slug: string): Promise<FileRef | null> {
    let pending = this.files.get(slug);
    if (!pending) {
      pending = resolveFileParam(slug, FILE_SELECT).then((resolved) => (resolved ? this.refFor(resolved.file) : null));
      this.files.set(slug, pending);
    }
    return pending;
  }

  private async refFor(file: {
    id: string;
    slug: string;
    sha256: string;
    pageCount: number | null;
    pageLabels: unknown;
    deletedByUserId: string | null;
  }): Promise<FileRef | null> {
    if (file.deletedByUserId !== null || file.pageCount === null) return null;
    this.version ??= currentTextVersion();
    const current = await this.version;
    const versions = await prisma.filePageText.groupBy({ by: ["textVersion"], where: { fileId: file.id } });
    const names = versions.map((row) => row.textVersion);
    const textVersion = names.includes(current) ? current : (names.sort().at(-1) ?? null);
    return { fileId: file.id, slug: file.slug, sha256: file.sha256, pageCount: file.pageCount, textVersion, storedLabels: file.pageLabels };
  }

  /** The file's own labels: as stored, or read from its bytes and not stored where they haven't been read yet. [] when they can't be read. */
  private labelsOf(file: FileRef): Promise<string[]> {
    let pending = this.labels.get(file.fileId);
    if (!pending) {
      const stored = file.storedLabels;
      pending = Array.isArray(stored)
        ? Promise.resolve(stored.map((label) => (typeof label === "string" ? label : "")))
        : readFile(storagePathFor(file.sha256))
            .then((bytes) => extractPdfMetadata(bytes))
            .then((metadata) => metadata.pageLabels)
            .catch((error: unknown) => {
              console.error(`[pdf-fragment-check] couldn't read the page labels of file ${file.fileId}:`, error);
              return [];
            });
      this.labels.set(file.fileId, pending);
    }
    return pending;
  }

  private wholeFile(file: FileRef): Promise<PageMap> {
    if (this.whole?.fileId !== file.fileId) {
      this.whole = { fileId: file.fileId, pages: this.readPages(file, null) };
    }
    return this.whole.pages;
  }

  /** The pages at `indexes`, or every page for null. */
  private async readPages(file: FileRef, indexes: readonly number[] | null): Promise<PageMap> {
    const pages: PageMap = new Map();
    if (file.textVersion === null || indexes?.length === 0) return pages;
    const rows = await prisma.filePageText.findMany({
      where: { fileId: file.fileId, textVersion: file.textVersion, ...(indexes ? { pageIndex: { in: [...indexes] } } : {}) },
      select: { pageIndex: true, text: true },
    });
    for (const row of rows) pages.set(row.pageIndex, { text: row.text, skeleton: skeletonOf(row.text) });
    return pages;
  }

  async check(link: FragmentLinkHref): Promise<FragmentLinkFinding> {
    const file = await this.fileFor(link.slug);
    if (!file) return { kind: "unknown-file", slug: link.slug };

    const pagesNamed = [...link.passages.map((passage) => passage.page), ...(link.page ? [link.page] : [])];
    const ownLabels = pagesNamed.some((page) => "label" in page) ? await this.labelsOf(file) : null;
    const usableLabels = ownLabels ? usablePageLabels(ownLabels, file.pageCount) !== null : null;

    if (link.page) {
      return { kind: "checked", slug: link.slug, currentSlug: file.slug, fileId: file.fileId, passages: [], page: checkPage(file.pageCount, ownLabels, link.page), usableLabels, unread: 0 };
    }

    let cited = this.cited.get(file.fileId);
    if (!cited) {
      cited = new Map();
      this.cited.set(file.fileId, cited);
    }
    const toRead = [...new Set(link.passages.flatMap((passage) => sheetsNamed(passage.page, ownLabels, file.pageCount)))].filter(
      (index) => !cited.has(index),
    );
    for (const [index, page] of await this.readPages(file, toRead)) cited.set(index, page);

    // Only the pages links name, so a miss is asked again of the whole file,
    // the one finding that reads past its own page.
    const named: FilePages = { ...file, ownLabels, pages: cited };
    const passages: PassageFinding[] = [];
    for (const passage of link.passages) {
      const finding = checkPassage(named, passage);
      passages.push(
        finding.kind === "no-match" || finding.kind === "no-such-label"
          ? checkPassage({ ...named, pages: await this.wholeFile(file) }, passage)
          : finding,
      );
    }
    return { kind: "checked", slug: link.slug, currentSlug: file.slug, fileId: file.fileId, passages, page: null, usableLabels, unread: link.unread };
  }
}
