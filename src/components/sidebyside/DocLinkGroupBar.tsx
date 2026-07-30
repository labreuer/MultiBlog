"use client";

import type { DocLinkGroupWithLinks } from "@/lib/doc-links-query";
import styles from "./DocLinkGroupBar.module.css";

const NEW_GROUP = "__new__";

type Props = {
  groups: DocLinkGroupWithLinks[];
  leftDocId: string;
  rightDocId: string;
  otherDocLinksCount: number;
  activeGroupId: string | null;
  onlyMine: boolean;
  oneGroupAtATime: boolean;
  onSelectGroup: (groupId: string | null) => void;
  onHideAll: () => void;
  onToggleOnlyMine: (value: boolean) => void;
  onToggleOneGroupAtATime: (value: boolean) => void;
};

// PLAN.md §14h — one entry per group with a link to either doc, prefixed
// ← / → / ↔ for which side(s) it touches; "New Doc Link Group" last. The
// first entry's own label flips between "Doc Link Groups" (nothing active)
// and "Hide all Groups" (something is) — selecting it in the second state
// is a bigger action than a plain deselect (it also hides every group's
// highlights, §14n), so onHideAll is a distinct callback from onSelectGroup.
export default function DocLinkGroupBar({
  groups,
  leftDocId,
  rightDocId,
  otherDocLinksCount,
  activeGroupId,
  onlyMine,
  oneGroupAtATime,
  onSelectGroup,
  onHideAll,
  onToggleOnlyMine,
  onToggleOneGroupAtATime,
}: Props) {
  const leftCount = groups.reduce((sum, g) => sum + g.links.filter((l) => l.docId === leftDocId).length, 0);
  const rightCount = groups.reduce((sum, g) => sum + g.links.filter((l) => l.docId === rightDocId).length, 0);

  function prefixFor(group: DocLinkGroupWithLinks): string {
    const hasLeft = group.links.some((l) => l.docId === leftDocId);
    const hasRight = group.links.some((l) => l.docId === rightDocId);
    if (hasLeft && hasRight) return "↔ ";
    if (hasLeft) return "← ";
    if (hasRight) return "→ ";
    return "";
  }

  return (
    <div className={styles.bar}>
      <select
        aria-label="Doc link groups"
        value={activeGroupId ?? "__none__"}
        onChange={(e) => {
          const value = e.target.value;
          if (value === "__none__") {
            if (activeGroupId !== null) onHideAll();
            return;
          }
          onSelectGroup(value);
        }}
      >
        <option value="__none__">{activeGroupId ? "Hide all Groups" : "Doc Link Groups"}</option>
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {prefixFor(group)}
            {group.name || "(untitled)"}
          </option>
        ))}
        <option value={NEW_GROUP}>New Doc Link Group</option>
      </select>
      <span className={styles.count}>
        ← {leftCount} {"  "} {rightCount} → {otherDocLinksCount > 0 ? `(+${otherDocLinksCount})` : ""}
      </span>
      <label className={styles.checkboxLabel}>
        <input type="checkbox" checked={onlyMine} onChange={(e) => onToggleOnlyMine(e.target.checked)} />
        Show only my Doc Links
      </label>
      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={oneGroupAtATime}
          onChange={(e) => onToggleOneGroupAtATime(e.target.checked)}
        />
        Show one Group at a time
      </label>
    </div>
  );
}

export { NEW_GROUP };
