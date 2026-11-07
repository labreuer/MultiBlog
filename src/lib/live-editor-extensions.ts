import type { Extensions } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { AuthorHighlight } from "./author-highlight-extension";
import { Annotation } from "./annotation-extension";
import { PendingAnnotation } from "./pending-annotation-extension";
import { BlurredSelection } from "./blurred-selection-extension";
import { VirtualKeyboardEnter } from "./virtual-keyboard-enter-extension";
import { Indent } from "./indent-extension";
import { FormatInputEvents } from "./format-input-extension";
import { AnnotationHighlight, type AnnotationAnchorInput } from "./annotation-highlight-extension";
import { EDITOR_LINK_OPTIONS, StarterKit, tableExtensions, titleExtensions } from "./tiptap-schema";

// The whole extension list of each editor that binds a ydoc, here rather than
// in the component that builds the editor, so `schema-version.test.ts` reads
// the lists the editors really run: docs/YDOC.md "A tab whose schema is out
// of date is refused". A node, mark or attribute added to one of these
// changes what a tab on the old bundle deletes from the shared document, and
// the test fails until SCHEMA_VERSION is bumped for it.
//
// So an editor's `extensions` is one of these calls and nothing beside it.
// An extension appended in the component is one the test never sees.
//
// Each list's schema equals its decoder's in tiptap-schema.ts
// (`docContentExtensions`, `annotationContentExtensions`,
// `titleAuthorHighlightExtensions`); the test holds them to that too.

/** The author mark's option: whose id new text is marked with, or null to mark nothing. */
type GetAuthorId = () => string | null;

type CaretUser = { id: string; name: string; color: string; initials?: string };

/** The doc body editor (`CollabEditorBody`): the doc editor, a side-by-side column in write mode, /ydoc-debug. */
export function docEditorExtensions(options: {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  user: CaretUser;
  /** Draws a remote caret. The component's, since it is drawn with the component's styles. */
  renderCaret: (user: Record<string, unknown>) => HTMLElement;
  getAuthorId: GetAuthorId;
  initialAnchors: AnnotationAnchorInput[];
}): Extensions {
  return [
    StarterKit.configure({ undoRedo: false, link: EDITOR_LINK_OPTIONS }),
    // The table nodes (docs/TABLES.md) — the same list contentExtensions
    // carries, so this editor's schema is that one plus the marks below
    // and never a table short of it. Not in the annotation editor's list, on
    // purpose: annotationContentExtensions says why.
    ...tableExtensions,
    Collaboration.configure({ document: options.ydoc }),
    CollaborationCaret.configure({ provider: options.provider, user: options.user, render: options.renderCaret }),
    AuthorHighlight.configure({ getAuthorId: options.getAuthorId }),
    // Keeps a non-empty selection painted (class "selection", styled in
    // prose.module.css) while the editor is blurred — the link popover's
    // URL box takes focus, and with it the browser's one DOM selection,
    // so without this the text Ctrl-K is about to link goes unmarked the
    // moment the popover opens. A decoration on state.selection, which
    // survives the blur regardless (LinkControls reads it at Save). Ours,
    // not @tiptap/extensions' Selection — that file says why.
    // docs/TIPTAP.md, "The link popover is a form".
    BlurredSelection,
    // Enter inserts the hard break Shift-Enter does while the virtual
    // keyboard is up — the extension file says why, and how it is detected.
    VirtualKeyboardEnter,
    // The indent/outdent commands behind the toolbar's pair and
    // Ctrl/⌘+Shift+. and , — list nesting or quote depth by where the caret
    // is; the extension file says why those keys.
    Indent,
    // The iPad keyboard's B/I/U buttons, which send no key — the
    // extension file says what they send instead.
    FormatInputEvents,
    // Registers the mark type so a doc's annotation marks sync/render
    // correctly here too (PLAN.md §12i) — posts never get one applied,
    // and an unused mark type in the schema costs nothing.
    Annotation,
    // View-only decoration (PLAN.md §13f) — never touches the ydoc, so
    // registering it unconditionally doesn't drift this schema from the
    // reading view's. Harmless on embedders with no selection widget.
    PendingAnnotation,
    // Also view-only, and for the same reason (PLAN.md §13o) — the
    // reading-view anchor's counterpart to the `Annotation` mark above.
    // Unlike the reading views, this editor has a real transaction mapping
    // to track those offsets through, so the ranges follow local typing
    // exactly rather than being re-found by text.
    AnnotationHighlight.configure({ anchors: options.initialAnchors }),
  ];
}

/**
 * An annotation body's editor (`AnnotationBody`): the doc editor's shape
 * without tables or the `annotation` mark, as annotationContentExtensions is.
 */
export function annotationEditorExtensions(options: {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  user: CaretUser;
  getAuthorId: GetAuthorId;
}): Extensions {
  return [
    StarterKit.configure({ undoRedo: false, link: EDITOR_LINK_OPTIONS }),
    Collaboration.configure({ document: options.ydoc }),
    CollaborationCaret.configure({ provider: options.provider, user: options.user }),
    AuthorHighlight.configure({ getAuthorId: options.getAuthorId }),
    // Selection stays painted while the link popover holds focus —
    // docEditorExtensions' comment on the same line.
    BlurredSelection,
    // Enter inserts the hard break Shift-Enter does while the virtual
    // keyboard is up — the extension file says why, and how it is detected.
    VirtualKeyboardEnter,
    // The indent/outdent commands behind the toolbar's pair and
    // Ctrl/⌘+Shift+. and , — list nesting or quote depth by where the caret
    // is; the extension file says why those keys.
    Indent,
    // The iPad keyboard's B/I/U buttons, which send no key — the
    // extension file says what they send instead.
    FormatInputEvents,
  ];
}

// Enter would otherwise attempt a splitBlock that the `content: "paragraph"`
// schema rejects anyway; making it an explicit no-op keeps it from also
// scrolling//bubbling as a failed command.
const SingleLine = Extension.create({
  name: "titleSingleLine",
  addKeyboardShortcuts() {
    return { Enter: () => true };
  },
});

/** A title's editor (`CollabTitleField`), bound to the `title` fragment of the body's Y.Doc. */
export function titleEditorExtensions(options: { ydoc: Y.Doc; getAuthorId: GetAuthorId }): Extensions {
  return [
    ...titleExtensions,
    SingleLine,
    Collaboration.configure({ document: options.ydoc, field: "title" }),
    AuthorHighlight.configure({ getAuthorId: options.getAuthorId }),
  ];
}
