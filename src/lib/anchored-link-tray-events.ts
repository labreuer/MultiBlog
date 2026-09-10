// docs/ANCHORED_LINKS.md — the one signal between "the open link changed"
// (a part added from a popover on either reading surface; a minted link
// reopened from an Edit button) and everything that shows it: the tray, the
// surfaces' in-progress paint, every Edit affordance (open-link-store.ts is
// the reader side). A module-scope listener set — the render-listener pattern
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
