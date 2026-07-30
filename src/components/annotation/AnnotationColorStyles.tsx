import { SAFE_ID, SAFE_COLOR } from "@/lib/safe-css";

// Colors a doc's annotation highlights (the mark from
// src/lib/annotation-extension.ts) by their author's own color — the same
// value AuthorHighlightStyles.tsx paints that person's attributed body text
// with — instead of prose.module.css's flat amber fallback. One rule per
// anchored (non-degraded) annotation, keyed by its own id: the mark's
// renderHTML already emits data-annotation-id, so no change to the mark or
// the schema is needed, just a --thread-color custom property for
// prose.module.css's .annotation-highlight rule to read (same convention
// quote-highlight-extension.ts already uses for quote threads).
export default function AnnotationColorStyles({ colors }: { colors: Record<string, string> }) {
  const rules = Object.entries(colors)
    .filter(([id, color]) => SAFE_ID.test(id) && SAFE_COLOR.test(color))
    .map(([id, color]) => `[data-annotation-id="${id}"] { --thread-color: ${color}; }`)
    .join("\n");

  if (!rules) {
    return null;
  }
  return <style>{rules}</style>;
}
