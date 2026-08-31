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
  // Show one Group at a time — restricts both columns' highlights to
  // whichever group is active, rather than layering Display?/"Show only my
  // Doc Links" on top of every group at once.
  const [oneGroupAtATime, setOneGroupAtATime] = useState(false);

  const isCreatingNew = activeGroupId === NEW_GROUP;
  const activeGroup = isCreatingNew ? null : groups.find((g) => g.id === activeGroupId) ?? null;

  // While "New Group" is selected but its panel hasn't saved yet,
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
        // An unsaved "New Group" draft has no links of its own —
        // restricting to it means restricting to nothing, not falling back
        // to showing every group.
        if (oneGroupAtATime && activeGroupId && (isCreatingNew || group.id !== activeGroupId)) continue;
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
    [groups, hiddenGroupIds, onlyMine, userId, oneGroupAtATime, activeGroupId, isCreatingNew],
  );

  // How many groups actually have something on screen right now — the same
  // filter docLinksFor applies, collapsed to a count rather than a link
  // list. Drives the pulse guard just below: with only one group visible,
  // there is nothing for the pulse to distinguish it from.
  const visibleGroupCount = groups.filter((group) => {
    if (hiddenGroupIds.has(group.id)) return false;
    if (oneGroupAtATime && activeGroupId && (isCreatingNew || group.id !== activeGroupId)) return false;
    return group.links.length > 0;
  }).length;

  // PLAN.md §14e — the one-shot pulse when a group becomes actively
  // selected, reusing QuoteThreadHeader.jumpToQuote's exact pattern:
  // scroll the first match into view, add "pulse", remove after 1200ms.
  // data-doc-link-group-ids spans both columns, so one querySelectorAll
  // reaches segments in either — the one place this page's shared scope
  // over both docs actually helps. Skipped when only one group is visible
  // (including whenever Show one Group at a time is on) — the darkened
  // segments are already unambiguous, so scrolling and pulsing to them adds
  // motion without disambiguating anything.
  useEffect(() => {
    if (!activeGroupId || isCreatingNew || visibleGroupCount <= 1) return;
    const targets = document.querySelectorAll<HTMLElement>(`[data-doc-link-group-ids~="${activeGroupId}"]`);
    if (targets.length === 0) return;
    targets[0].scrollIntoView({ behavior: "smooth", block: "center" });
    targets.forEach((el) => el.classList.add("pulse"));
    const timer = window.setTimeout(() => {
      targets.forEach((el) => el.classList.remove("pulse"));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [activeGroupId, isCreatingNew, visibleGroupCount]);

  return (
    <>
      <DocLinkGroupBar
        groups={groups}
        leftDocId={left.docId}
        rightDocId={right.docId}
        otherDocLinksCount={initialOtherDocLinksCount}
        activeGroupId={isCreatingNew ? NEW_GROUP : activeGroupId}
        onlyMine={onlyMine}
        oneGroupAtATime={oneGroupAtATime}
        onSelectGroup={selectGroup}
        onHideAll={() => {
          setHiddenGroupIds(new Set(groups.map((g) => g.id)));
          setActiveGroupId(null);
        }}
        onToggleOnlyMine={setOnlyMine}
        onToggleOneGroupAtATime={setOneGroupAtATime}
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
          userColor={userColor}
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
          onColorPreview={(overrideColor) => {
            if (!activeGroup) return;
            previewGroupColor(activeGroup.id, overrideColor);
          }}
          onDeleted={() => {
            if (activeGroup) setGroups((prev) => prev.filter((g) => g.id !== activeGroup.id));
            setActiveGroupId(null);
          }}
        />
      )}
      {/* data-popover-bounds — the rect a doc-link popover is kept inside
          (popoverBoundsElement, src/lib/popover-placement.ts). Marked with an
          attribute rather than threaded down as a prop through DocColumn:
          SideBySideDocBody has no business knowing this page's layout, only that
          *some* ancestor may constrain it, and /doc/[slug] marks nothing at
          all and correctly falls back to the viewport. */}
      <div className={styles.columns} data-popover-bounds>
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
          onLinkColorPreview={previewLinkColor}
          onLinkClicked={(groupId) => selectGroup(groupId)}
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
          onLinkColorPreview={previewLinkColor}
          onLinkClicked={(groupId) => selectGroup(groupId)}
        />
      </div>
    </>
  );

  // Shared by the bar's dropdown and a doc link's click-routing (below) —
  // both mean "make this the active group," including un-hiding it if
  // Display? had previously turned it off (§14h: opening a panel and
  // darkening a group in the bar while its segments stay hidden reads as
  // broken rather than as "you already hid this").
  function selectGroup(id: string | null) {
    setActiveGroupId(id);
    if (id && id !== NEW_GROUP) {
      setHiddenGroupIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

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
    // isCreatingNew counts as "nothing selected" here even though the
    // sentinel is truthy: columnActiveGroupId sent null to the popover, so
    // createDocLink built a brand-new group rather than filling the unsaved
    // draft the panel is showing. Following it makes the panel describe the
    // group that actually got created — §14i's "the new group becomes
    // activeGroupId, and its panel opens" — instead of leaving a stale
    // empty draft open beside a group it has nothing to do with.
    if (!activeGroupId || isCreatingNew) setActiveGroupId(link.groupId);
  }

  // PLAN.md §14j — a link edited or deleted via its click-routing popover.
  // Both search every group rather than taking a groupId, since the
  // caller (SideBySideDocBody, inside a column) only ever knows the link's own
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

  // Live-preview channels: paint the new color into both columns' highlights
  // immediately, ahead of the debounced/on-Save persistence that will
  // eventually confirm (or, on error, silently fail to confirm) it. Cheap to
  // call speculatively — a failed save just leaves the preview slightly
  // wrong until the next real update, the same staleness docLinksFor already
  // tolerates between saves.
  function previewGroupColor(groupId: string, overrideColor: string | null) {
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, overrideColor } : g)));
  }

  function previewLinkColor(linkId: string, overrideColor: string | null) {
    setGroups((prev) =>
      prev.map((g) => ({ ...g, links: g.links.map((l) => (l.id === linkId ? { ...l, overrideColor } : l)) })),
    );
  }
}
