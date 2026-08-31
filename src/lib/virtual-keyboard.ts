// Whether the virtual (on-screen) keyboard is currently taking up screen
// real estate — the signal the body editors' Enter/Backspace remap keys off
// (virtual-keyboard-enter-extension.ts). This replaced pointer-based
// modality tracking, whose iPad-with-hardware-keyboard failure was
// structural: every tap said "touch" and no keystroke was allowed to say
// otherwise, so hardware Enter kept soft-breaking. Keyboard geometry asks
// the right question directly — a hardware keyboard puts nothing on
// screen, so Enter splits paragraphs again the moment one is attached.
//
// The standard options, and why this one:
// - VisualViewport (used here): when the keyboard docks, iOS Safari and
//   modern Android Chrome shrink `visualViewport.height` while
//   `window.innerHeight` stays — the difference *is* the keyboard (plus
//   any other UA inset). Works everywhere the app's baseline reaches.
// - `navigator.virtualKeyboard` (the purpose-built spec): precise
//   `geometrychange` rects, but Chromium-on-Android only — no iOS — and
//   reporting requires `overlaysContent = true`, an opt-in that changes
//   how the keyboard affects layout for the whole page. Not worth either
//   cost for a yes/no.
// - The `interactive-widget` viewport meta: configures which viewport the
//   keyboard resizes; it is a knob, not a detector.
//
// The arithmetic: inset = innerHeight − visualViewport.height × scale.
// Multiplying by `scale` cancels pinch-zoom (zoomed 2×, the visual
// viewport reports half the CSS pixels at scale 2). URL-bar show/hide
// cancels too: it moves innerHeight and the visual viewport together.
//
// Known blind spots, all of which degrade to stock Enter rather than to a
// stuck remap: iPadOS's *floating/split* keyboard doesn't dock and shrinks
// nothing; Android Chrome < 108 resized the layout viewport along with the
// visual one, so the difference reads ~0; and a browser with no
// visualViewport at all never installs. The hardware-keyboard shortcut
// strip on an iPad (~55–70px) sits below the floor on purpose.
// Verified by hand on a real iPad (docked keyboard on, hardware keyboard
// off), 2026-08-30.

// Below this, whatever is insetting the viewport is not a keyboard: the
// smallest docked keyboards are ~260px, the iPad hardware-keyboard
// accessory strip ~70px, and transient UA chrome less.
const KEYBOARD_MIN_INSET_PX = 100;

let inset = 0;
let override: boolean | null = null;
let installed = false;

function measure(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  inset = Math.max(0, Math.round(window.innerHeight - vv.height * vv.scale));
}

// Dev/test override: true and false force the answer, null returns it to
// the measurement. Exposed on window (below) because real keyboard
// geometry is unreachable from a spec — Playwright cannot shrink
// visualViewport — and unconditionally because `npm run e2e` runs the
// *production* build, so a NODE_ENV gate would hide the hook from the one
// consumer it exists for.
export function setVirtualKeyboardOverride(value: boolean | null): void {
  override = value;
}

// Call from anything that will later ask `virtualKeyboardVisible()` — at
// setup time, not first-question time: the resize that changes the answer
// precedes the Enter that asks. One window-lifetime listener, shared by
// every caller, never removed.
export function ensureVirtualKeyboardTracking(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  (window as unknown as Record<string, unknown>).__multiblogSetVirtualKeyboard = setVirtualKeyboardOverride;
  const vv = window.visualViewport;
  // No VisualViewport: inset stays 0 and Enter keeps its stock behavior
  // (unless overridden above).
  if (!vv) return;
  measure();
  vv.addEventListener("resize", measure);
}

export function virtualKeyboardVisible(): boolean {
  if (override !== null) return override;
  return inset >= KEYBOARD_MIN_INSET_PX;
}
