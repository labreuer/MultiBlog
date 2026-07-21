# MultiBlog — TipTap/ProseMirror notes

## ProseMirror

### Object-spread with a conditional override silently keeps stale array data

**The bug:** `stripMarkFromDoc` (`src/lib/tiptap-schema.ts`), which recursively removes one
mark type from a ProseMirror JSON doc before it's persisted to `revisions.doc`, looked like
this:

```ts
export function stripMarkFromDoc(doc: JSONContent, markName: string): JSONContent {
  function strip(node: JSONContent): JSONContent {
    const marks = node.marks?.filter((mark) => mark.type !== markName);
    const content = node.content?.map(strip);
    return {
      ...node,
      ...(marks !== undefined ? { marks } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  }
  return strip(doc);
}
```

The fixed version:

```ts
export function stripMarkFromDoc(doc: JSONContent, markName: string): JSONContent {
  function strip(node: JSONContent): JSONContent {
    // Destructure marks/content out of the base spread — `{...node, ...(cond
    // ? {marks} : {})}` spreads node's *original, unfiltered* marks first,
    // so when the conditional half contributes nothing (the filtered array
    // is empty — the common case for a text run whose only mark was the one
    // being stripped), nothing overrides it and the unfiltered marks leak
    // straight through unstripped.
    const { marks: rawMarks, content: rawContent, ...rest } = node;
    const marks = rawMarks?.filter((mark) => mark.type !== markName);
    const content = rawContent?.map(strip);
    return {
      ...rest,
      // Omit the key entirely when filtering leaves nothing, rather than
      // keeping `marks: []` — ProseMirror's own Node#toJSON never emits an
      // empty marks array either, so leaving one in here made a freshly
      // stripped doc structurally unequal (per docsEqual) to the identical
      // content coming back from a live editor's getJSON() a moment later,
      // spuriously creating a no-op revision on save-then-publish.
      ...(marks !== undefined && marks.length > 0 ? { marks } : {}),
      ...(content !== undefined ? { content } : {}),
    };
  }
  return strip(doc);
}
```

**The problem, in two layers:**

1. `{...node, ...(marks !== undefined ? { marks } : {}) }` spreads the entire original
   `node` first — including its *unfiltered* `marks` array — and only conditionally spreads
   a second object on top to override it. As long as `marks` is defined (which it is,
   whenever `node.marks` was defined, since `.filter()` always returns an array), that
   override fires and everything looks fine. But a plain object spread only *overrides* a
   key if the later spread actually contributes it — it can't *remove* one contributed by an
   earlier spread. So the moment the override condition is written more narrowly (see next
   point), any node whose filtered marks come back empty falls through to `...node`'s
   original, unfiltered `marks` — the exact array `strip()` was supposed to remove entries
   from. This is what actually broke first: a fix for problem 2 below was applied by
   narrowing `marks !== undefined` to `marks !== undefined && marks.length > 0`, without
   also cutting `node`'s original `marks` out of the base spread — so on a text node whose
   *only* mark was the one being stripped (the common case: freshly-typed text tagged with
   exactly one `authorHighlight` mark and nothing else), the filtered-to-empty array no
   longer triggered the override, and the raw, unstripped mark leaked straight into the
   persisted revision. Confirmed by dumping the stored revision from Postgres directly:
   `{"text": "...", "type": "text", "marks": [{"type": "authorHighlight", ...}]}` — the mark
   the function exists to remove, still there. The fix: destructure `marks`/`content` out of
   `node` before spreading, so the base spread (`...rest`) has nothing stale left to leak.

2. Even before that regression, the *original* code had a subtler issue: it always kept a
   `marks` key on the output node whenever the input had one, even when filtering emptied it
   — producing `marks: []`. ProseMirror's own `Node#toJSON()` never does this: a node with
   zero marks simply omits the `marks` key entirely (`if (this.marks.length) obj.marks =
   ...`). So a doc that had gone through `stripMarkFromDoc` (with a stray `marks: []` on some
   node) was structurally different — by key count, not content — from the *same* doc
   produced fresh by a live editor's own `getJSON()` a moment later, which never has that key
   for a markless node. `docsEqual` (`src/lib/diff.ts`) does a structural, key-set-aware
   comparison specifically to survive Postgres jsonb losing key order on read-back — but it
   still requires both sides to have the *same set of keys*, so this mismatch made it report
   "different" for what was actually identical content.

**Where this actually bit:** `saveDraft` strips `authorHighlight` marks from the client's
submitted doc before storing it as a new revision; a few lines later on the client,
`clearAuthorHighlights` removes the same mark from the *live* editor via a real transaction,
so the working doc and the just-saved revision end up with equivalent content moments apart.
`publishPost`/`schedulePost` reuse the latest revision instead of creating a new one only when
`docsEqual(latest.doc, cleanDoc)` — so either half of this bug (stray `marks: []`, or a mark
that should've been stripped but wasn't) made a plain "save, then immediately publish with no
further edits" sequence look like a real change, creating a spurious extra revision every
time.

**The fix, in full:** destructure `marks` and `content` out of the base object before
spreading (so there's no stale array left for a skipped conditional to leak), *and* only
re-add the `marks` key when the filtered result is non-empty (so the output matches
ProseMirror's own convention of omitting it entirely rather than serializing `[]`).
