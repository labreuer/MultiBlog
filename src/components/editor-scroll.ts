// The attribute marking CollabEditorBody's scroll frame — the
// `overflow-y: auto` box the doc body scrolls inside (EditorChrome.module.css's
// .editorContent), as opposed to the page scrolling.
//
// Its own module because two components need to agree on the string and
// neither should import the other: CollabEditorBody sets it, and the doc
// editor's annotation rail (PLAN.md §18c) reads it to find out which band of
// text is currently visible. A CSS-module class name would have been the
// obvious carrier and can't be — those are hashed per build, so they're not
// addressable from a querySelector in a different module.
export const EDITOR_SCROLL_ATTRIBUTE = "data-editor-scroll";
