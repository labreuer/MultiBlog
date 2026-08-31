// docs/ANCHORED_LINKS.md — the one signal between "a draft part was added or
// removed" (a popover, on either reading surface) and the tray that shows
// the draft. A module-scope listener set — the render-listener pattern
// PdfAnnotationSurface already uses — rather than React context, because
// the two ends live in different trees: on the PDF page the popover is
// inside the ssr:false island and the tray is the page's own sibling.
// The server row is the state; this only says "go ask again".

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe. */
export function onAnchoredLinkChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAnchoredLinkChanged(): void {
  for (const listener of listeners) listener();
}
