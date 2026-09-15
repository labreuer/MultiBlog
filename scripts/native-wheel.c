// Post one *native* scroll-wheel event into whatever window is under a screen
// point — a real mouse notch as far as the browser is concerned, with
// `isTrusted` set and the engine's own unit conversion applied.
//
// Why this exists: Playwright's `mouse.wheel` is pixel-mode in all three of its
// engines, its Firefox included, so no run of the suite ever delivers Gecko's
// *line*-mode notch or exercises its read-order shim (docs/PDF.md §10c).
// cliclick has no wheel verb. What is left is CoreGraphics itself:
// `CGEventCreateScrollWheelEvent` with line units is exactly what a mouse
// produces, posted at the HID tap so Firefox, Safari and Chrome all take it as
// hardware. Measured 2026-09-14 against Firefox 155.0.1 on macOS 14.8.9 —
// e2e/MACOS.md has the recipe and the numbers.
//
// C rather than Swift on purpose: on that machine `swiftc` refuses its own
// SDK ("this SDK is not supported by the compiler", a 6.0.3.1.5 vs 6.0.3.1.10
// toolchain skew that Command Line Tools ships with), while clang is fine.
//
//   clang -framework ApplicationServices scripts/native-wheel.c -o /tmp/native-wheel
//   /tmp/native-wheel <x> <y> <line|pixel> <delta> [ctrl|meta|none]
//
// `x`/`y` are screen points (CSS px at any Retina factor). Aim from the page:
// Firefox exposes `mozInnerScreenX/Y` directly; elsewhere use the window
// bounds + `innerHeight` formula in e2e/MACOS.md. `delta > 0` scrolls *up* —
// CoreGraphics' sign, so the page sees a negative `deltaY`, i.e. a zoom-in
// notch. The modifier is set on the event's own flags, which is what Gecko
// reads for `ctrlKey`/`metaKey`; no key is held in the OS.
//
// Needs Accessibility for the host app (System Settings → Privacy & Security),
// the same grant cliclick needs. Without it the events post and land nowhere.
//
// What it cannot do: a trackpad *pinch*. That is a magnify gesture, not a
// wheel — Firefox turns it into a ctrl-wheel of `-100 * log(1 + magnification)`
// in pixel mode, and no public CGEvent creates one. A `pixel` event with
// `ctrl` here is a two-finger scroll with ctrl held, which the app's `readWheel`
// classifies the same way but is not the same evidence for feel.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: native-wheel <x> <y> <line|pixel> <delta> [ctrl|meta|none]\n");
    return 2;
  }
  CGPoint point = CGPointMake(atof(argv[1]), atof(argv[2]));
  CGScrollEventUnit units = strcmp(argv[3], "pixel") == 0 ? kCGScrollEventUnitPixel : kCGScrollEventUnitLine;
  int32_t delta = (int32_t)atoi(argv[4]);
  const char *modifier = argc >= 6 ? argv[5] : "none";
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);

  // Put the pointer there first: the wheel goes to the window under it, and a
  // window that has not seen the pointer arrive drops the first event (the
  // same "move, wait, then act" rule as cliclick's).
  CGEventRef move = CGEventCreateMouseEvent(source, kCGEventMouseMoved, point, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, move);
  CFRelease(move);
  usleep(250000);

  CGEventRef wheel = CGEventCreateScrollWheelEvent(source, units, 1, delta);
  if (!wheel) {
    fprintf(stderr, "could not create scroll event\n");
    return 1;
  }
  CGEventSetLocation(wheel, point);
  if (strcmp(modifier, "ctrl") == 0) CGEventSetFlags(wheel, kCGEventFlagMaskControl);
  else if (strcmp(modifier, "meta") == 0) CGEventSetFlags(wheel, kCGEventFlagMaskCommand);
  else CGEventSetFlags(wheel, 0);
  CGEventPost(kCGHIDEventTap, wheel);
  CFRelease(wheel);
  CFRelease(source);
  usleep(100000);
  printf("posted %s %d at %.0f,%.0f modifier=%s\n", argv[3], delta, point.x, point.y, modifier);
  return 0;
}
