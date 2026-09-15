# scripts/macos

Native input for measuring real browsers on a Mac — the things no Playwright engine, and no
`dispatchEvent`, can produce. All four are macOS-only by construction and none is TypeScript;
they build with `clang` (this machine's `swiftc` refuses its own SDK) and need the
**Accessibility** grant for the app hosting the session. Recipes, the permission ladder, the
traps, and what each was used to measure: [e2e/MACOS.md](../../e2e/MACOS.md). The findings
they produced live in [docs/PDF.md](../../docs/PDF.md) §10c.

| file | what it does | build |
|---|---|---|
| `native-wheel.c` | posts one real scroll-wheel notch, line or pixel mode, ctrl or ⌘ on the flags | `clang -framework ApplicationServices native-wheel.c -o /tmp/native-wheel` |
| `native-magnify.c` | posts a trackpad pinch: Began, N Changed frames of magnification M, Ended | `clang -framework ApplicationServices native-magnify.c -o /tmp/native-magnify` |
| `magnify-tap.m` | logs every magnify event the OS delivers, as AppKit reads it, one JSON line each | `clang -ObjC -framework AppKit -framework CoreGraphics magnify-tap.m -o /tmp/magnify-tap` |
| `pinch-test.html` | a page with nothing on it but a pinch recorder — the control for how much an engine delivers when the page costs nothing | serve with `python3 -m http.server 4323 --bind 127.0.0.1` from here |

Build into `/tmp` or the session scratchpad, never into the tree. Gestures follow focus, not
the pointer: activate the browser under test before posting. The magnify event's private
CGEvent fields (110, 113, 132) were found by probing what `[NSEvent eventWithCGEvent:]` reads,
and the probe is described in e2e/MACOS.md so it can be re-run if a macOS update moves them.
