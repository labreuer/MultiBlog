# Driving the browser pane

Everything here is **browser-pane behavior specifically**. None of it applies under
Playwright — which is half the reason to prefer `npm run e2e` for anything repeatable. Use
the pane for behavior the suite doesn't cover, or when you need to *look* at something
rather than assert on it.

## Screenshots time out; measure instead

The `computer` screenshot action reliably times out in this environment. Verify with
`read_page` / `javascript_tool` measurements — bounding rects, computed styles — instead.

Coordinate-based clicks are collateral damage: `computer` refuses `left_click` with a
`coordinate` until a screenshot has cached the viewport dimensions, so coordinates are never
an available fallback here. If you genuinely need an image, `page.screenshot()` in a
throwaway spec produces one.

## `ref`-based clicks can silently no-op

On the editor's action buttons, `computer`'s `ref` clicks report success and nothing
happens — seen repeatedly on Publish in the old `PostEditor`, before `PostPublisher`
replaced it (PLAN.md §15c). When a click appears to do nothing, drive it from
`javascript_tool` instead:

```js
[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Publish').click()
```

That dispatches a real React-visible click and works every time. Confirm the result via
`get_page_text` rather than assuming.

## Setting the editor's content in one shot

Focus `.tiptap`, select its contents with a `Range`, then
`document.execCommand('insertText', false, "…")` — collapsing the range first appends,
leaving it selected replaces.

Wrap it in an IIFE: `javascript_tool` reuses one scope across calls, so a bare `const t = …`
fails with "already declared" on the second call.

Note that `document.querySelector('.tiptap')` matches the **title** editor first; the body
editor is `querySelectorAll('.tiptap')[1]`. See [TIPTAP.md](TIPTAP.md).

## The console buffer accumulates across navigations

For a clean error check, open a fresh tab.

## A stale session outlives the user row

Sessions use NextAuth's `jwt` strategy (`src/lib/auth.ts`): `id`/`role`/`color` are baked
into the session cookie once at sign-in and never re-read from the DB on later requests.

Deleting a throwaway `User` row mid-session does **not** sign them out or revoke their
role — the browser tab keeps showing (and acting as) that stale identity until an explicit
sign-out or the JWT expires. Don't take "the user row is gone" as proof a test session has
ended; click Sign out, or open a fresh tab, before relying on the signed-out UI state.

## Tabs share one cookie jar

If you sign in as a second user in tab B, tab A silently becomes that second user too the
next time it does a fresh navigation. An already-loaded tab's live WS connection and React
state keep its original identity only until you reload or navigate it.

Do each test user's sign-in in its own tab, and only reload a tab when you actually mean to
switch who it's authenticated as.

This is why anything concurrent — two authors editing one post — belongs in a spec instead:
Playwright gives each identity its own `browser.newContext()`, with its own jar. See the
`secondUser()` fixture and `e2e/collab.spec.ts`.
