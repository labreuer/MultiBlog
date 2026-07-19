import type { AuthorColorMap } from "@/lib/use-author-colors";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

// Renders one CSS rule per known author, so `.author-highlight[data-author-id]`
// spans (which only carry an id, never a color) get painted with that
// person's real color. Validates both id and color before interpolating —
// they ultimately come from the User table via an API response, not from
// trusted local state.
export default function AuthorHighlightStyles({ colors }: { colors: AuthorColorMap }) {
  const rules = Object.entries(colors)
    .filter(([id, info]) => SAFE_ID.test(id) && SAFE_COLOR.test(info.color))
    .map(
      ([id, info]) =>
        `.author-highlight[data-author-id="${id}"] { background-color: color-mix(in srgb, ${info.color} 30%, transparent); }`,
    )
    .join("\n");

  if (!rules) {
    return null;
  }
  return <style>{rules}</style>;
}
