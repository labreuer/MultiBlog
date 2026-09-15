// Post a *native* trackpad pinch — a magnify gesture — into whatever window is
// under a screen point: a Began, N Changed frames each carrying a
// magnification M, then an Ended, exactly the stream a MacBook trackpad sends.
//
// Why this exists: no public API creates a magnify event, no Playwright engine
// can, and until 2026-09-15 every trackpad-pinch measurement here needed a hand
// on the trackpad (docs/PDF.md §10c). What NSEvent reads a magnify event *from*
// is a CGEvent of type 29 (kCGEventGesture) with private fields, and those were
// found by probing rather than guessing: build a CGEvent, set one candidate
// field, hand it to `[NSEvent eventWithCGEvent:]`, and see which field lands
// in `magnification` and which in `phase` (e2e/MACOS.md has the probe):
//   field 110 = 8        the HID gesture type, zoom
//   field 113 = M        NSEvent.magnification, Apple's per-event delta
//   field 132 = phase    1, 2, 4 → NSEventPhaseBegan, Changed, Ended
// Posted at the HID tap, Safari, Firefox and Chrome all take it as hardware:
// Safari fires `gesture*` events with `isTrusted`, Gecko and Blink their
// ctrl-wheel encodings of M — measured against scripts/macos/magnify-tap.m, which
// logs what the OS actually delivered.
//
//   clang -framework ApplicationServices scripts/macos/native-magnify.c -o /tmp/native-magnify
//   /tmp/native-magnify <x> <y> <M per frame> <frames> [interval ms, default 16]
//
// `x`/`y` are screen points; aim as for native-wheel.c. A real pinch's frames
// are 5–35 ms apart with M around ±0.02 per frame at a comfortable speed, so
// `0.02 20` is a moderate spread of ×1.02^20 = 1.49. The window must be
// frontmost (gestures follow focus, not the pointer): `osascript -e 'tell
// application "Safari" to activate'` first. Needs Accessibility for the host
// app, like native-wheel.c; without it the events post and land nowhere.
//
// C rather than Swift for the reason native-wheel.c gives.
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void post(double x, double y, int phase, double mag) {
  CGEventRef e = CGEventCreate(NULL);
  CGEventSetType(e, (CGEventType)29);
  CGEventSetLocation(e, CGPointMake(x, y));
  CGEventSetIntegerValueField(e, (CGEventField)110, 8);
  CGEventSetDoubleValueField(e, (CGEventField)113, mag);
  CGEventSetIntegerValueField(e, (CGEventField)132, phase);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: %s <x> <y> <M per frame> <frames> [interval ms]\n", argv[0]);
    return 2;
  }
  double x = atof(argv[1]), y = atof(argv[2]), m = atof(argv[3]);
  int n = atoi(argv[4]);
  int ms = argc > 5 ? atoi(argv[5]) : 16;
  post(x, y, 1, 0.0);
  usleep(ms * 1000);
  for (int i = 0; i < n; i++) {
    post(x, y, 2, m);
    usleep(ms * 1000);
  }
  post(x, y, 4, 0.0);
  printf("posted began + %d x %g + ended at (%g,%g), %d ms apart\n", n, m, x, y, ms);
  return 0;
}
