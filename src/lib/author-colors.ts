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

// The one formula for "this author's highlight wash" — shared by
// AuthorHighlightStyles and the dashboard Settings color sample so the two
// can't drift (docs/DASHBOARD.md "The color sample").
export function authorHighlightBackground(color: string): string {
  return `color-mix(in srgb, ${color} var(--anchor-tint), transparent)`;
}

// Black or white for the avatar fallback's initials on a solid `color` fill.
// Needed because User.color is unclamped by decision (docs/DASHBOARD.md) —
// a near-white pick would leave white initials invisible. Perceptual
// mid-gray threshold (0.5) rather than the WCAG-optimal ~0.179: the strict
// threshold would flip the house default blue (#5b8cff) to black initials,
// while 0.5 changes only genuinely light fills. Fine for glyphs that are
// decorative (aria-hidden, the full name always beside them). Unrecognized
// input gets white, the behavior all fills had before this existed.
export function onAuthorColor(color: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return "#ffffff";
  const channel = (i: number) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.5 ? "#000000" : "#ffffff";
}
