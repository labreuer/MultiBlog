// Palette assigned to users at sign-up (User.color) and used for both collab
// carets and author-highlight marks — one real color per person, not a
// per-render hash, so it's stable across sessions and consistent everywhere.
export const AUTHOR_COLOR_PALETTE = ["#f783ac", "#845ef7", "#339af0", "#20c997", "#fab005", "#ff6b6b"];

// The one hardcoded fallback for "no thread/author color available" —
// written into style attributes and validated by SAFE_COLOR, which only
// accepts hex, so this can't be a CSS custom property. Hoisted here so the
// five previously independent copies (AnnotatableArticle, CollabEditorBody,
// doc-link-colors, pseudo-border) can't drift from each other.
export const NEUTRAL_THREAD_COLOR = "#999999";

export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AUTHOR_COLOR_PALETTE[hash % AUTHOR_COLOR_PALETTE.length];
}
