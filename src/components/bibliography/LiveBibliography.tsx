"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { citationBibliography, type Bibliography } from "@/lib/entity-chips/kinds/citation-bibliography";
import { entityChipKey } from "@/lib/entity-chips/node";
import { chipsIn } from "@/lib/entity-chips/renderings";
import type { ChipRendering } from "@/lib/entity-chips/types";
import BibliographyList from "./Bibliography";
import styles from "./Bibliography.module.css";

// docs/CITATIONS.md, "The bibliography" — a live editor's bibliography,
// following its citations as they are added, edited and removed, and its
// chip inputs as a style changes or a work's record arrives.

const EMPTY: Bibliography = { form: "short", items: [] };

// The chip plugin makes a new renderings map whenever a chip or the inputs
// change, and keeps it through any other edit (node.ts), so it keys the
// bibliography: typing recomputes nothing.
const computed = new WeakMap<Map<string, ChipRendering>, Bibliography>();

function bibliographyOf(editor: Editor | null): Bibliography {
  if (!editor || editor.isDestroyed) return EMPTY;
  const plugin = entityChipKey.getState(editor.state);
  if (!plugin) return EMPTY;
  let bibliography = computed.get(plugin.byIid);
  if (!bibliography) {
    bibliography = citationBibliography(chipsIn(editor.state.doc), plugin.inputs.styles, plugin.inputs.context);
    computed.set(plugin.byIid, bibliography);
  }
  return bibliography;
}

/**
 * `editor`'s bibliography, where this is rendered or, given `host`, at the
 * end of that element: the doc editor's scrolling box, so the list scrolls
 * with the text rather than taking room beneath it. `download` is the
 * selection a download icon beside the heading names (`doc=<id>`).
 */
export default function LiveBibliography({ editor, host, download }: { editor: Editor | null; host?: HTMLElement | null; download?: string }) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!editor) return () => {};
      editor.on("transaction", notify);
      return () => {
        editor.off("transaction", notify);
      };
    },
    [editor],
  );
  const bibliography = useSyncExternalStore(
    subscribe,
    () => bibliographyOf(editor),
    () => EMPTY,
  );

  const container = useMemo(() => {
    if (!host) return null;
    const element = document.createElement("div");
    element.className = styles.inEditor;
    return element;
  }, [host]);
  useEffect(() => {
    if (!host || !container) return;
    host.append(container);
    return () => container.remove();
  }, [host, container]);

  const list = <BibliographyList bibliography={bibliography} download={download} />;
  if (host === undefined) return list;
  return container ? createPortal(list, container) : null;
}
