"use client";

import { useEffect, useState } from "react";
import { useDocPresence } from "./doc-presence-context";
import styles from "./AnnotationPresenceIndicator.module.css";

type Peer = { clientId: number; name: string; color: string };

type AnnotationEditingState = { annotationId: string; name: string; color: string };

// PLAN.md §13i — the discovery half of presence: every reader on the doc
// (DocReadingBody's own awareness, exposed via DocPresenceProvider) sees
// everyone else's LiveAnnotationComposer publish "I'm writing an
// annotation" into it. Not per-annotation (a brand-new one has nowhere to
// anchor an indicator to yet — no list entry exists until it's posted),
// just an ambient "who's composing right now" line — simpler than a
// pulsing marker on exact anchored text, and still answers the actual
// question ("is anyone else writing a comment right now").
export default function AnnotationPresenceIndicator() {
  const { awareness } = useDocPresence();
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    if (!awareness) return;

    const update = () => {
      const next: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const editing = (state as { annotationEditing?: AnnotationEditingState }).annotationEditing;
        if (editing) next.push({ clientId, name: editing.name, color: editing.color });
      });
      setPeers(next);
    };

    update();
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [awareness]);

  if (peers.length === 0) {
    return null;
  }

  return (
    <div className={styles.wrapper}>
      {peers.map((peer) => (
        <p key={peer.clientId} className={styles.line}>
          <span className={styles.dot} style={{ backgroundColor: peer.color }} />
          {peer.name} is writing an annotation…
        </p>
      ))}
    </div>
  );
}
