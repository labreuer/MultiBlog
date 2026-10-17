import type { MouseEvent as ReactMouseEvent } from "react";

// "Outside the surface", for the popovers that close on a mousedown outside
// one. Outside means outside the surface's React tree, not merely its DOM:
// an editor inside a popover portals parts of itself to <body> (LinkBubble,
// LinkControls' popover, QuoteControls, DocRefMenu — `position: fixed`, clear
// of every clipping ancestor), and a DOM `contains` test calls a click on one
// of those outside, which closed an annotation composer the moment its own
// link bubble's "Remove link" was clicked.
//
// React's synthetic events bubble along the component tree, through portals,
// so a capture handler on the surface's root sees every mousedown that began
// anywhere the surface rendered. The caller puts `markMouseDownInside` on the
// same element its container ref points at, and its document listener asks
// `isMouseDownOutside`. React dispatches capture handlers from a capture-phase
// listener on its root, which runs before any bubble-phase listener on
// `document`, so the mark is always in place by the time a listener looks.
//
// The mark is the event itself, keyed by the element that saw it, rather than
// a flag to reset: a mousedown no listener was there to consume — the one that
// starts a drag-select, before any popover is open — would otherwise leave the
// flag set to excuse the next real outside click. Keying by element lets every
// listener on one container (SideBySideDocBody has two) share one handler.
const insideEvents = new WeakMap<Element, Event>();

export function markMouseDownInside(event: ReactMouseEvent<HTMLElement>) {
  insideEvents.set(event.currentTarget, event.nativeEvent);
}

// False when there is no container to be outside of, as every call site's
// own check was.
export function isMouseDownOutside(event: MouseEvent, container: HTMLElement | null): boolean {
  if (!container) return false;
  if (insideEvents.get(container) === event) return false;
  return !container.contains(event.target as Node);
}
