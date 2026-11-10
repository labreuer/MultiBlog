"use client";

import { useRef, useState, type DragEvent } from "react";

// Files dropped on an element, for a box that reads them as text
// (docs/CITATIONS.md, "The import box"). Only a drag that carries files is
// taken: a drag of selected text is left to the browser, so it still lands in
// a textarea where it is dropped. A drag that carries files always has its
// default prevented, even while `enabled` is false, since the browser's
// default is to open the file in place of the page.

/** Whether a drag carries files, as opposed to text or a link. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

export function useFileDrop(onFiles: (files: File[]) => void, enabled: boolean, onEnter?: () => void) {
  const [over, setOver] = useState(false);
  // dragenter and dragleave fire for each child the drag crosses, so the
  // element is left only when as many leaves as enters have come.
  const depth = useRef(0);
  const handlers = {
    onDragEnter(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      if (enabled) {
        setOver(true);
        onEnter?.();
      }
    },
    onDragOver(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    },
    onDragLeave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setOver(false);
      if (enabled) onFiles([...event.dataTransfer.files]);
    },
  };
  return { over: over && enabled, handlers };
}
