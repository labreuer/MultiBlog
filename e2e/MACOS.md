# The suite on macOS, and the real Safari

What is different about running and verifying on the Mac, and how to reach the one
browser no Playwright project is: Safari.app itself. Written 2026-09-14 from PR #31's
"real Safari" check; the machine facts are that day's and are dated because they will
move.

## The machine, and its ceiling

A 2019 MacBook Air — 2 physical cores (i5-8210Y, fanless), 16 GB — on **macOS 14.8.9**
with **Safari 26.6.1**. It cannot run macOS 15, and that one fact fences off two testing
paths at once:

- **Playwright's webkit project does not launch here.** `playwright.config.ts` records
  why: the macOS 14 WebKit build is pinned to a frozen revision whose protocol lacks a
  setting the current Playwright sends, so every test dies in `newPage` before its body
  runs. Not fixable from this side; it unblocks on macOS 15+ or on the Fedora box.
- **Appium / WebDriverAgent** has to build onto a device with an Xcode newer than macOS 14
  accepts (`scripts/remote-console.ts` header).

The chromium and firefox projects run as they do anywhere, through the same tsx scripts
(`npm run e2e`, `e2e:firefox`, `check-ports`, `stop:all`). Two cores cannot carry
Playwright's default worker count beside `next dev`, collab and Postgres — `.env` sets
`E2E_WORKERS` for this machine, with the measurement in its comment — and a full run is
about twenty minutes here against the Fedora box's one to two.

## Driving the real Safari

Safari is what a Mac reader uses, and the webkit project shares its engine, not its UI
(README.md, "Firefox and WebKit"). When a webkit finding needs confirming in the real
thing, everything below runs from a session on this machine. None of it needs Xcode,
Selenium, or a running Playwright.

### The permission ladder

Each rung is a separate grant, and only the user can give any of them. Know which rung a
question needs before asking for one.

| rung | grant | what it unlocks |
|---|---|---|
| none | — | `open -a Safari <url>`; the remote-console eval channel into the app's own pages; AppleScript *reads* of Safari (URL of the current tab, window bounds — Automation for Safari is already granted on this Mac, and prompts once elsewhere). |
| Accessibility | System Settings → Privacy & Security → Accessibility, for the app hosting the session (VS Code, Terminal) | `cliclick` (`brew install cliclick`): real mouse moves, drags and clicks; System Events clicks; `scripts/native-wheel.c`: real wheel notches, line or pixel, with ctrl or ⌘. **Granted 2026-09-14.** |
| Safari setting | Develop menu → Allow JavaScript from Apple Events | AppleScript `do JavaScript` — redundant with the relay, not enabled. |
| admin password | `safaridriver --enable` in a terminal | WebDriver against Safari (Selenium, WebdriverIO). Not enabled; the relay covers everything it would have, short of a second tab. |

The first rung is the important one: navigation, DOM measurement, scripted selections, and
evidence across hard navigations all live there. Only a *gesture* — a drag that WebKit
treats as a user selection, a click whose mousedown can move the selection — needs the
second.

### The recipe

1. **Relay, with a pinned token**, so a restart does not invalidate the URL baked into the
   app (docs/ENV.md):

   ```
   REMOTE_CONSOLE_TOKEN=<anything> npx tsx scripts/remote-console.ts
   ```

2. **Dev server with the client injected.** Put `REMOTE_CONSOLE_SRC` in the *environment*
   of `dev:all` rather than in `.env` — same effect (`src/app/layout.tsx` reads
   `process.env` at render, dev builds only), and nothing to un-edit when you are done:

   ```
   REMOTE_CONSOLE_SRC='http://localhost:4322/client.js?token=<the token>' npm run dev:all
   ```

   Confirm with `curl -s localhost:3000/sign-in | grep -o '<script src="http://localhost:4322[^"]*"'`.

3. **Open the tab**: `open -a Safari http://localhost:3000/dashboard`. The page's own
   client registers within a second — `curl -s localhost:4322/status` shows it. The tab is
   the user's Safari, so their session cookie for localhost:3000 is already there; sign in
   as a throwaway account only if the test needs one, and say so, because it replaces theirs.

4. **Evaluate**: `curl -s --data-binary '<js>' 'localhost:4322/eval?timeout=<ms>'`. An
   expression or a function body, `await` allowed, result serialised (elements come back as
   tag, class, rect and text). `window.__rcConsole` holds captured `console.error`/`warn`.

5. **Read back after a navigation** — the eval that navigates times out by design (its
   client died with the page), so the next page's client registers a moment later and:

   ```
   osascript -e 'tell application "Safari" to get URL of current tab of front window'
   ```

   is the ground truth for where the tab landed, independent of the relay.

6. **Tear down**: kill the relay (it is an arbitrary-code channel; never leave it running),
   `npm run stop:all`, delete throwaway rows. Leave the tab; it is the user's.

### Patching a page before it hydrates

Some questions need code in place *before* the app's own effects run — the session-refresh
check below had to wrap `fetch` before `SessionRefresh` POSTed. The relay makes this
possible without touching the app:

- Issue the navigating eval with a short timeout (`?timeout=300`), then immediately loop
  the patch eval with `?timeout=250` until its result says it installed.
- The old page's poller is dropped the moment it unloads (`res.on("close")` in the relay),
  and the new page's client is a synchronous `<script>` that polls during parse — so the
  queued patch runs at `readyState=loading` or `interactive`, before React's deferred
  bundle can hydrate. Measured: installed at 400–750 ms into the page, first session GET at
  ~1100 ms, the POST at ~1400 ms.
- Make the patch idempotent (`if (window.__x) return "already installed"`) and have it
  refuse the wrong page (`if (location.pathname !== "/dashboard") return "wrong page"`) —
  the loop may hand one copy to the page being left.
- Evidence that must outlive the next navigation goes in `sessionStorage`: same origin,
  same tab, survives a hard navigation, readable from whichever page is alive afterwards.
  Log timestamps from `performance.now()` and `document.readyState` with each entry.

### Native input with cliclick

Screen coordinates for a page point, with `{wl, wt, wr, wb}` from AppleScript's
`bounds of front window` and `innerHeight` from an eval:

```
x_screen = wl + x_page
y_screen = (wb - innerHeight) + y_page
```

Calibrated exact on 2026-09-14 by installing a one-shot `mousemove` listener and moving the
mouse to a known screen point — do that once per session rather than trusting the toolbar
height, and **re-read the bounds before every trial**: the window moved 4 px between two
runs and the first drag after that selected nothing.

A drag-select of a phrase, given its `Range.getBoundingClientRect()`:

```
cliclick -r "m:$x1,$y" "w:250" "dd:$x1,$y" "w:120" "dm:$xm,$y" "w:120" "dm:$x2,$y" "w:120" "du:$x2,$y"
```

Two traps, each of which cost a misread run:

- **Move, wait, then act.** The first event after `tell application "Safari" to activate`
  is dropped unless a `m:` and a `w:250` precede the `dd:` or `c:`. Without it the drag
  starts nowhere and the page sees no mousedown.
- **A click straight out of a drag misses.** `c:` immediately after `du:` lands on nothing
  the page can see; put `m:<target>` and `w:150` before it. Verify a click by recording
  `mousedown`/`mouseup`/`click` on `document` (capture phase) before sending it — the
  recorder is a one-line eval and turns "the popup is still open" from a mystery into
  "the click never arrived".

### Native wheel events with `scripts/native-wheel.c`

cliclick has no wheel verb, and Playwright's `mouse.wheel` is pixel-mode in every engine, so a
real mouse notch — Gecko's *line*-mode event in particular — comes from CoreGraphics directly.
`scripts/native-wheel.c` posts one `CGEventCreateScrollWheelEvent` at a screen point with an
optional ctrl or ⌘ on the event's flags; its header has the build line and the sign convention
(`delta > 0` scrolls up, so the page sees a negative `deltaY`). Build it with clang: this
machine's `swiftc` refuses its own SDK, which is a toolchain skew and not something to fix.

The recipe is the Safari one above with two changes. **Firefox** (`open -a Firefox <url>`) is
just another tab that carries the injected client, and it gives the screen origin of its
viewport for free: `mozInnerScreenX`/`mozInnerScreenY` plus a `clientX`/`clientY` is the
screen point, no window-bounds arithmetic. And the listener that records what arrived **must
read `deltaMode` before `deltaX`/`deltaY`**, or it becomes the thing being tested: Gecko
converts the event to pixels for every later reader the moment a delta is read first
(docs/PDF.md §10c). Record in capture phase on `document` and again in bubble phase for
`defaultPrevented`; read `devicePixelRatio` and `innerWidth` before and after, since Firefox's
own ctrl-wheel is a *full* zoom that moves those and not `visualViewport.scale`.

Other things that read as failures and are not:

- **A file swap reloads the page under your patch.** Swapping a source file for main's
  version to get a control run triggers Turbopack HMR; the page may fully reload, and a
  patch installed just before that is gone with nothing in the log after "installed". Wait
  a few seconds after the swap, and treat an empty log as "rerun", not as a result.
- The eval that navigates always reports a timeout. Expected.
- All Safari tabs share one cookie jar, as with the preview pane (docs/BROWSER_PANE.md).

## What was measured: PR #32, 2026-09-14

**Ctrl-wheel on the PDF surface, real Firefox 155.0.1.** The page was the user's own Firefox
(it already held a session for localhost:3000, so nothing was signed in or replaced), on a
throwaway SHARED file from `scripts/test-file.ts`, the dev server started with
`REMOTE_CONSOLE_SRC` in its environment. Eight native events, each read on the app's page:
a 1-line notch with ctrl is `deltaMode` 1, `deltaY` −1 — **one line on macOS, not the three
Firefox sends on Linux and Windows** — and one ×1.10 step; down is ×0.91; ⌘ instead of ctrl
is the same step with `metaKey`; a 3-line event is still one step; 2 px is the pinch curve;
60 px is one step; a bare notch scrolls and is not prevented. `devicePixelRatio` and
`innerWidth` never moved, so Firefox's own zoom never fired. Then a `window`-level capture
listener that read `deltaY` first was armed for one notch: the app's listener saw mode 0,
`deltaY` −17, and the viewer did not move — the shim is real, and on a Mac it costs the whole
notch. Table in docs/PDF.md §10c.

## What was measured: PR #31, 2026-09-14

Both app fixes the webkit project found, verified in Safari 26.6.1 with a control run on
main's version of each file (swapped in, measured, restored — the tree was clean after).

**Session refresh** (`src/components/SessionRefresh.tsx`). The trial hard-navigated to
/dashboard with a `fetch` wrapper installed before hydration that hard-navigated to the
front page the instant the session POST began — the same abort a reader's early click
causes. With the fix: the POST aborted, next-auth logged `ClientFetchError: Load failed`,
the confirming GET fired, no request for /sign-in was ever made, and the tab landed on the
front page. With main's file: the page requested /sign-in and the tab ended there. Two
clean runs each way.

**Selection popover** (`src/lib/use-selection-popover.ts`). Native drag across a phrase
in a /side-by-side column, native click on Save, four-second watch. With the fix: popup
closed about 100 ms after the click, selection emptied, nothing reopened, link row
written. With main's hook: popup closed the same way, link written — and the selection
**stayed exactly the dragged phrase**. Safari relocated it into the new decoration span;
it did not expand to the paragraph. The same held for a scripted selection. So the
expansion the fix was written against is specific to Playwright's WebKit build; in Safari
the fix's value is the cleared highlight, and the code comment now says so.
