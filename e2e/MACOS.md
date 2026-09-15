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
| Accessibility | System Settings → Privacy & Security → Accessibility, for the app hosting the session (VS Code, Terminal) | `cliclick` (`brew install cliclick`): real mouse moves, drags and clicks; System Events clicks; `scripts/macos/native-wheel.c`: real wheel notches, line or pixel, with ctrl or ⌘. **Granted 2026-09-14.** |
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

### Native wheel events with `scripts/macos/native-wheel.c`

cliclick has no wheel verb, and Playwright's `mouse.wheel` is pixel-mode in every engine, so a
real mouse notch — Gecko's *line*-mode event in particular — comes from CoreGraphics directly.
`scripts/macos/native-wheel.c` posts one `CGEventCreateScrollWheelEvent` at a screen point with an
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
- **A dev-server restart reloads every open app tab, and each comes back with the *current*
  token.** Starting a fresh relay token to shake off tabs left from an earlier session does not
  work: Turbopack's reconnect reloads them and they carry the new `<script>`. Route by user
  agent instead (next bullet), or ask before closing tabs that are not yours.
- **The relay has one queue, not one per tab.** `pollers.shift()` hands each command to
  whichever tab has waited longest, so with two browsers open an eval lands in either. Wrap the
  code so the wrong tab returns a sentinel and retry until it doesn't:
  `(() => { if (!/Firefox/.test(navigator.userAgent)) return "__WRONG_TAB__"; return (<code>); })()`.
  The tabs take turns, so a match comes within a handful of tries. Trust the `ua` a result
  carries, not `/status`'s `device`, which is only whoever said hello last.
- **Chrome is not installed here, but Playwright's bundle is a real headed Blink.**
  `open -na "$HOME/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-x64/Google Chrome for Testing.app" --args --user-data-dir=<scratch dir> --no-first-run <url>`
  opens it with an empty profile, so it holds no session: sign in through the form with an
  eval that sets the inputs through `HTMLInputElement.prototype`'s native `value` setter, fires
  `input`, and clicks submit — a React form ignores a plain `.value =`. Delete the profile
  directory afterwards.
- **The serialiser caps arrays at 100 entries** (`{ __t: "truncated", of: N }` as the last
  element). Return a long log as `JSON.stringify(log)` — one string — and parse it locally.
  A string result over about 60 KB used to vanish too: the client posted results with
  `keepalive: true`, which browsers cap at 64 KB and drop silently, so the eval timed out
  with the page alive and answering smaller evals. Fixed 2026-09-15 (keepalive only under
  the cap); on an older client, fetch the log in slices.
- **A suspended tab is a black hole.** Safari suspends a background tab after a while; its
  held long-poll stays in the relay's queue, and the next command it is handed is never
  evaluated — the eval times out, and the tab *behind* it, the one you wanted, looks dead.
  Two Safari tabs left from an earlier session did this to every Firefox eval for ten minutes.
  Probe with a bare eval returning `navigator.userAgent + location.href` a few times to map
  who answers; then blank or close the strays (`tell application "Safari" to set URL of (every
  tab of every window whose URL contains "…") to "about:blank"`), and say that you did.
  Route by `location.href` as well as UA, since the strays are usually the same browser.
- **A recorder re-armed by replacing its array records nothing.** The listeners closed over
  the first array; `window.__log = []` gives the reader a new, empty one. Truncate in place
  (`window.__log.length = 0`). The symptom is the document visibly changing while the log
  stays empty, which reads as "the events never reached the page".
- **Stamp recorder entries with `Date.now()`**, not only `performance.now()` relative to
  arming: lining a page's log up with an OS-level log (below) needs a wall clock, and the
  arm time is nowhere.
- **A window in the background may not answer.** Chrome and Firefox throttle background
  windows' timers hard after a few minutes; `tell application "Firefox" to activate` before
  an eval, and back to the browser under test before posting a gesture.

### Synthesizing a trackpad pinch: `scripts/macos/native-magnify.c` and `scripts/macos/magnify-tap.m`

No public API creates a magnify gesture and no Playwright engine can, so until 2026-09-15 a
pinch measurement needed a hand on the trackpad, and the user's hand at that — with retries,
focus fumbles, and no way to know what the OS had actually sent. Both halves are now tools.

**Reading what the OS sends.** `scripts/macos/magnify-tap.m` is a listen-only `CGEventTap` at the
session level; `[NSEvent eventWithCGEvent:]` reads each event exactly as AppKit would, and it
prints one JSON line per magnify event with `magnification`, `phase` and `timestamp`. It sees
whatever the frontmost app sees — a hand pinch, or a posted one. Build with `clang -ObjC
-framework AppKit -framework CoreGraphics`. Accessibility is the grant it needs.

**Posting one.** `scripts/macos/native-magnify.c` posts a Began, N Changed frames of magnification
`M`, and an Ended at a screen point. The private fields were found by *probing*, not by
reading anyone's list: build a `CGEvent` of type 29, set one candidate field from 100 to 200
to a marker value, convert with `eventWithCGEvent:`, and see which field comes back as
`magnification` (113, with field 110 = 8 for the zoom HID type) and which as `phase` (132,
with CG values 1/2/4 mapping to AppKit's 1/4/8). The probe is twenty lines of Objective-C and
takes a second; keep it that way rather than trusting a constant off the internet. Gestures
follow *focus*, not the pointer: activate the app first, and a frame posted while another
window is frontmost goes there. The tap confirms the post went out; the page's recorder
confirms what the engine made of it.

**Lining the clocks up.** The tap's `timestamp` is seconds since boot; a page's events are
`performance.timeOrigin + performance.now()`. Python's `time.time() - time.monotonic()` is
*not* the offset (it was 56 000 s off here). Derive it from a gesture you can identify in
both logs — Firefox's Σ`deltaY` = −100·Σ`M` names its gesture to four decimals — and check it
against the others; the remaining pairings then fall out to a few milliseconds.

**The bare page.** `scripts/macos/pinch-test.html` has nothing on it but the recorder and the relay
client, so it measures the engine's delivery with the page costing nothing; `?busy=60` makes
each event cost sixty synchronous milliseconds instead, and `?prevent=0` drops
`preventDefault`. Serve it with `python3 -m http.server 4323 --bind 127.0.0.1` from
`scripts/macos/`, post the same pinch at it that you posted at the app, and compare.

## What was measured: the OS's magnify stream against all three engines, 2026-09-15

Prompted by the user feeling that Firefox zoomed far more than Safari after PR 32's follow
window. Same rig as the day before, plus the tap and the poster above. Four hand pinches per
browser first (with retries and one whole Safari redo — the fumbles show up in the tap as
gestures no browser received), then the synthetic pinch. Firefox's DOM `deltaY` summed to
−100·Σ`M` to four decimals on every gesture; Chromium's to −100·Σln(1+`M`) within 0.7% on its
one clean gesture; Safari's `scale` grew only by the frames it delivered, 6–32% of what the OS
sent, and the identical posted pinch moved the document ×3.3 in Firefox and Chromium against
×1.35 in Safari. The bare page then showed Safari delivering all 20 frames to a cheap
handler and 6 to a 60 ms one. Tables and the finding in docs/PDF.md §10c.

## What was measured: trackpad pinch in Firefox and Chromium, 2026-09-14

**A hand pinch on the MacBook trackpad, real Firefox 155.0.1 and Playwright's Chromium 151
bundle**, on a throwaway SHARED file from `scripts/test-file.ts` — the user's own Firefox session,
and Chromium signed in as the file's throwaway owner through the form. The recorder was the
Safari run's: a window-level capture listener for every `wheel` (`deltaMode` first), every
`gesture*`, touch and non-mouse pointer event, and both `resize`s, each entry stamped with the
document's `--scale-factor`, `visualViewport.scale`, `devicePixelRatio` and `innerWidth`; a
bubble-phase listener recorded `defaultPrevented`. Two evals per browser, routed by user agent
as above. The user did one slow spread and one quick pinch in each, and worried the gesture had
needed several clicks to take; the recorder ignored mouse clicks by design, so those are not in
the log, and nothing in it is a stray — both gestures open with the sub-pixel frame a pinch
starts with, every frame is trusted and prevented, and the browser's own zoom never moved.
Result: ctrl-wheel only in both browsers, a slow pinch at exact parity with the gain, and a
quick pinch whose 12–72 px frames the app then read as mouse notches — the finding behind
`PINCH_FOLLOW_MS`. Table and findings in docs/PDF.md §10c.

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
