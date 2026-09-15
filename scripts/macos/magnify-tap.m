// Log every trackpad magnify event as the OS hands it to applications: one JSON
// line per event with NSEvent's `magnification`, `phase` and `timestamp`.
//
// Why this exists: the three engines each turn Apple's per-event magnification
// M into something different (docs/PDF.md §10c), and the only way to know what
// a page's number *means* is to see M itself beside it. A listen-only CGEvent
// tap at the session level sees the same events the frontmost app does, and
// `[NSEvent eventWithCGEvent:]` reads them exactly as AppKit would. It also
// verifies what scripts/macos/native-magnify.c posted actually went out.
//
//   clang -ObjC -framework AppKit -framework CoreGraphics scripts/macos/magnify-tap.m -o /tmp/magnify-tap
//   /tmp/magnify-tap > tap.jsonl        # Ctrl+C to stop
//
// `timestamp` is seconds since boot (`NSEvent.timestamp`); a page's clock is
// `performance.timeOrigin` + `performance.now()`. e2e/MACOS.md has the way to
// line the two up. `phase` is NSEventPhase: 1 began, 4 changed, 8 ended. Type
// 29 lines are the umbrella `NSEventTypeGesture` events that accompany a real
// pinch and carry no magnification. Needs Accessibility for the host app, or
// `CGEventTapCreate` returns NULL.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

static CFMachPortRef gTap;

static CGEventRef callback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *info) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    CGEventTapEnable(gTap, true);
    return event;
  }
  NSEvent *e = [NSEvent eventWithCGEvent:event];
  if (e && (e.type == NSEventTypeMagnify || e.type == NSEventTypeGesture)) {
    double mag = e.type == NSEventTypeMagnify ? e.magnification : 0;
    printf("{\"t\":%.4f,\"type\":%lu,\"phase\":%lu,\"magnification\":%.9f}\n",
           e.timestamp, (unsigned long)e.type, (unsigned long)e.phase, mag);
    fflush(stdout);
  }
  return event;
}

int main(void) {
  CGEventMask mask = CGEventMaskBit(NSEventTypeMagnify) | CGEventMaskBit(NSEventTypeGesture);
  gTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, callback, NULL);
  if (!gTap) {
    fprintf(stderr, "tap failed: is Accessibility granted to the host app?\n");
    return 1;
  }
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(NULL, gTap, 0);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(gTap, true);
  fprintf(stderr, "listening\n");
  CFRunLoopRun();
  return 0;
}
