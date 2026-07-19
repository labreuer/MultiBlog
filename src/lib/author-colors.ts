// Palette assigned to users at sign-up (User.color) and used for both collab
// carets and author-highlight marks — one real color per person, not a
// per-render hash, so it's stable across sessions and consistent everywhere.
export const AUTHOR_COLOR_PALETTE = ["#f783ac", "#845ef7", "#339af0", "#20c997", "#fab005", "#ff6b6b"];

export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AUTHOR_COLOR_PALETTE[hash % AUTHOR_COLOR_PALETTE.length];
}
