// The banner overlay's rotation (docs/BLOG.md, "The banner overlay"):
// <!-- one-of --> … <!-- or --> … <!-- end --> in the markup file keeps one
// of its alternatives, the one `pick(count)` names.
const ONE_OF = /<!--\s*one-of\s*-->([\s\S]*?)<!--\s*end\s*-->/g;
const OR = /<!--\s*or\s*-->/;

export function resolveOneOfs(html: string, pick: (count: number) => number): string {
  return html.replace(ONE_OF, (_, body: string) => {
    const alternatives = body.split(OR);
    return alternatives[pick(alternatives.length)];
  });
}
