"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { JSONContent } from "@tiptap/react";
import type { DocLinkGroupWithLinks } from "@/lib/doc-links-query";
import type { DocLinkInput } from "@/lib/doc-link-anchor";
import { cascadeDocLinkColor } from "@/lib/doc-link-colors";
import DocColumn from "./DocColumn";
import DocLinkGroupBar, { NEW_GROUP } from "./DocLinkGroupBar";
import DocLinkGroupPanel from "./DocLinkGroupPanel";
import styles from "./SideBySideView.module.css";

export type SideBySideDoc = {
  docId: string;
  initialTitle: string;
  initialBodyJSON: JSONContent;
  staticBody: ReactNode;
};

type Props = {
  left: SideBySideDoc;
  right: SideBySideDoc;
  initialGroups: DocLinkGroupWithLinks[];
  initialOtherDocLinksCount: number;
  userId: string;
  userName: string;
  userColor: string;
};

// PLAN.md §14f/§14h — the page shell: the group bar strip above two
// independently-scrolling columns, each able to switch between read and
// write mode on its own (§14g). Group/link state is owned here rather than
// per-column, because the bar (dropdown, counts, active-group darkening)
// and both columns' highlights all have to agree on the same set — a doc
// link created in one column has to show up in the bar's dropdown, and
// selecting a group in the bar has to darken that group's segments in
// *both* columns at once.
export default function SideBySideView({ left, right, initialGroups, initialOtherDocLinksCount, userId, userName, userColor }: Props) {
  const [groups, setGroups] = useState(initialGroups);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // Display? — per-group opt-out, not persisted, defaulting to shown
  // (§14h: the click-disambiguation case where no group is selected only
  // makes sense if highlights are visible with nothing selected).
  const [hiddenGroupIds, setHiddenGroupIds] = useState<Set<string>>(new Set());
  const [onlyMine, setOnlyMine] = useState(false);

  const isCreatingNew = activeGroupId === NEW_GROUP;
  const activeGroup = isCreatingNew ? null : groups.find((g) => g.id === activeGroupId) ?? null;

  // While "New Doc Link Group" is selected but its panel hasn't saved yet,
  // `activeGroupId` holds the NEW_GROUP sentinel ("__new__") — a real value
  // for the *bar's* dropdown to render, but not a real group id. Each
  // DocColumn below must see `null` instead: it forwards activeGroupId
  // straight into DocLinkPopover's `groupId` on save, and the sentinel
  // would otherwise be sent to createDocLink, which fails with "Group not
  // found" (there's no row with that id). Passing null falls through to
  // the popover's own "no group selected" path, which creates its own new
  // group — the same thing selecting nothing at all does.
  const columnActiveGroupId = isCreatingNew ? null : activeGroupId;

  const docLinksFor = useMemo(
    () => (docId: string): DocLinkInput[] => {
      const out: DocLinkInput[] = [];
      for (const group of groups) {
        if (hiddenGroupIds.has(group.id)) continue;
        for (const link of group.links) {
          if (link.docId !== docId) continue;
          if (onlyMine && link.userId !== userId) continue;
          out.push({
            id: link.id,
            mark: link.mark,
            groupId: group.id,
            color: cascadeDocLinkColor(link.overrideColor, group.overrideColor, link.authorColor),
            mine: link.userId === userId,
            text: link.text,
            overrideColor: link.overrideColor,
          });
        }
      }
      return out;
    },
    [groups, hiddenGroupIds, onlyMine, userId],
  );

  // PLAN.md §14e — the one-shot pulse when a group becomes actively
  // selected, reusing QuoteThreadHeader.jumpToQuote's exact pattern:
  // scroll the first match into view, add "pulse", remove after 1200ms.
  // data-doc-link-group-ids spans both columns, so one querySelectorAll
  // reaches segments in either — the one place this page's shared scope
  // over both docs actually helps.
  useEffect(() => {
    if (!activeGroupId || isCreatingNew) return;
    const targets = document.querySelectorAll<HTMLElement>(`[data-doc-link-group-ids~="${activeGroupId}"]`);
    if (targets.length === 0) return;
    targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
    targets.forEach((el) => el.classList.add("pulse"));
    const timer = window.setTimeout(() => {
      targets.forEach((el) => el.classList.remove("pulse"));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [activeGroupId, isCreatingNew]);

  return (
    <>
      <DocLinkGroupBar
        groups={groups}
        leftDocId={left.docId}
        rightDocId={right.docId}
        otherDocLinksCount={initialOtherDocLinksCount}
        activeGroupId={isCreatingNew ? NEW_GROUP : activeGroupId}
        onlyMine={onlyMine}
        onSelectGroup={setActiveGroupId}
        onHideAll={() => {
          setHiddenGroupIds(new Set(groups.map((g) => g.id)));
          setActiveGroupId(null);
        }}
        onToggleOnlyMine={setOnlyMine}
      />
      {(activeGroup || isCreatingNew) && (
        <DocLinkGroupPanel
          // Forces a remount on every dropdown switch — without this,
          // React reuses the same component instance across groups (same
          // JSX position), and its name/text/overrideColor state (only
          // ever initialized once, from the initial* props) keeps showing
          // whichever group was active before instead of resetting.
          key={activeGroup?.id ?? "new"}
          groupId={activeGroup?.id ?? null}
          initialName={activeGroup?.name ?? null}
          initialText={activeGroup?.text ?? null}
          initialOverrideColor={activeGroup?.overrideColor ?? null}
          visible={activeGroup ? !hiddenGroupIds.has(activeGroup.id) : true}
          onToggleVisible={(visible) => {
            if (!activeGroup) return;
            setHiddenGroupIds((prev) => {
              const next = new Set(prev);
              if (visible) next.delete(activeGroup.id);
              else next.add(activeGroup.id);
              return next;
            });
          }}
          onCreated={(groupId, fields) => {
            setGroups((prev) => [...prev, { id: groupId, ...fields, userId, links: [] }]);
            setActiveGroupId(groupId);
          }}
          onUpdated={(fields) => {
            if (!activeGroup) return;
            setGroups((prev) => prev.map((g) => (g.id === activeGroup.id ? { ...g, ...fields } : g)));
          }}
          onDeleted={() => {
            if (activeGroup) setGroups((prev) => prev.filter((g) => g.id !== activeGroup.id));
            setActiveGroupId(null);
          }}
        />
      )}
      <div className={styles.columns}>
        <DocColumn
          {...left}
          side="left"
          userId={userId}
          userName={userName}
          userColor={userColor}
          docLinks={docLinksFor(left.docId)}
          activeGroupId={columnActiveGroupId}
          onLinkCreated={(link) => appendLinkForDoc(left.docId, link)}
          onLinkUpdated={updateLink}
          onLinkDeleted={deleteLink}
        />
        <DocColumn
          {...right}
          side="right"
          userId={userId}
          userName={userName}
          userColor={userColor}
          docLinks={docLinksFor(right.docId)}
          activeGroupId={columnActiveGroupId}
          onLinkCreated={(link) => appendLinkForDoc(right.docId, link)}
          onLinkUpdated={updateLink}
          onLinkDeleted={deleteLink}
        />
      </div>
    </>
  );

  function appendLinkForDoc(docId: string, link: DocLinkInput) {
    setGroups((prev) => {
      const idx = prev.findIndex((g) => g.id === link.groupId);
      const rawLink = {
        id: link.id,
        docId,
        mark: link.mark,
        text: link.text,
        docLinkGroupId: link.groupId,
        overrideColor: link.overrideColor,
        userId,
        authorColor: userColor,
        createdAt: new Date(),
      };
      if (idx === -1) {
        return [...prev, { id: link.groupId, name: null, text: null, overrideColor: null, userId, links: [rawLink] }];
      }
      const next = [...prev];
      next[idx] = { ...next[idx], links: [...next[idx].links, rawLink] };
      return next;
    });
    if (!activeGroupId) setActiveGroupId(link.groupId);
  }

  // PLAN.md §14j — a link edited or deleted via its click-routing popover.
  // Both search every group rather than taking a groupId, since the
  // caller (LiveDocBody, inside a column) only ever knows the link's own
  // id — the group it belongs to isn't threaded through the edit flow.
  function updateLink(link: DocLinkInput) {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        links: g.links.map((l) => (l.id === link.id ? { ...l, text: link.text, overrideColor: link.overrideColor } : l)),
      })),
    );
  }

  function deleteLink(linkId: string) {
    setGroups((prev) => prev.map((g) => ({ ...g, links: g.links.filter((l) => l.id !== linkId) })));
  }
}
