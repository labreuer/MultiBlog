Back up the DB with HEAD's hash in the filename. Then come up with a plan for side-by-side docs, located at /sidebyside/[id]+[id] or if the router doesn't like that, propose something.

We will add two tables:

* doc_link_group
	* id
	* name
	* text
	* override_color
	* user_id
	* created_at
	* updated_at
	* deleted_at
* doc_link
	* id
	* doc_id
	* mark_id
	* mark
	* text
	* doc_link_group_id
	* override_color
	* user_id
	* created_at
	* updated_at
	* deleted_at

The reason for both mark_id and mark is to allow inline or external marks. The text field in both cases is user-entered and can be null. doc_link_group.name is also nullable

Now for the side-by-side docs:

* no settings panes
* either side can be switched between read and write, depending on permissions
* clicking a title takes you to the editor for that doc if permissions permit, otherwise the view
* in edit view, shorten the title field by the width of a button titled "Doc Links" on its right
	* that button switches that doc from edit view to read-only view (so one can add doc_links)

* include a drop-down above the middle of the two docs:
	* the items:
		* first entry starts out with "Doc Link Groups"
		* with one entry for every doc_link_group which has a doc_link to one of the docs, showing its name
		* prepend "← " if there are only doc_links to the left doc
		* prepend "→ " if there are only doc_links to to the right doc
		* prepend "↔ " if there are doc_links to both docs
		* include "New Doc Link Group" as the last item
		* once another item is selected, change the first entry to "Hide all Groups"
	* when an item is selected, show a collapsible window with editable name, text, and override_color
* display a count of doc_links with this format: "← N  M → (+Y)"
	* N doc links to the left
	* M doc links to the right
	* Y doc links to other docs
* include a checkbox not persisted to the DB called "Display?" which displays or hides the corresponding doc_link highlights (via decoration marks)
* when an doc_link_group is actively selected, darken the corresponding highlighted sections and pulse them, like with navigating to quoted text from comments on posts
* debounced save
* delete button
* "Show only my Doc Links" button

Selecting text in the read view pops up an option to create a new doc_link:

* with optional text
* associated with a doc_link_group
	* if one is selected in the drop-down note this
	* if none is selected, note that a new Doc Link Group will be created, and pop open the display for it
* with override color
* save button
* cancel button if new
* delete button if editing existing
* offset from the right-bottom limit of the selection by 0.5em both directions
* create decoration marks on save, colored by author, superseded by doc_link_group.override_color, superseded by doc_link.override_color
* debounced save if already saved at least once

Using decoration marks only for now, show them if they're valid and otherwise hide them, in both the edit & read views.

When clicking an already-doc_link-marked bit of text:

* if there is only one doc_link, open the pop-up for it
* if there are multiple doc_links:
	* if a doc_link_group is selected and there is only one matching doc_link, open the pop-up for it
	* if a doc_link_group is selected and there are multiple matching doc_links, provide a selection between them
	* if no doc_link_group is selected, present a choice of which one, along with what text it selects (max 50 chars either side)

Identify any gaps in the above plan. Then, after getting whatever feedback from me is required, add a section §14 to PLAN.md.








Opus 5 Extra's questions & answers
----------------------------------
"In edit view, shorten the title field by the width of a button titled 'Doc Links' on its right" — what does that button do?

switches that doc from edit view to read-only view (so one can add doc_links)

A doc_link's anchor is stored as offsets+text in the DB, not as a mark Yjs moves for you. When the doc is edited and the stored range no longer matches, what should happen?

Re-find and persist (Recommended)

On the side-by-side page, text selection has to mean *something*. On /doc/[slug] it currently means "new annotation". What happens to annotations here?

neither annotation highlights nor text are shown in this view

Nothing in the spec says how a user reaches /sidebyside/a+b. What entry point should Phase 1 ship?

"Compare with…" on a doc
----------------------------------



/sidebyside/a+a must redirect to /doc/a. Two columns on the same doc would build two
distinct Y.Docs sharing one documentName, so attachIndexeddb (ref-counted per Y.Doc,
a WeakMap) would create two IndexeddbPersistence instances against the same IndexedDB
database — exactly the y-indexeddb#25 shape CLAUDE.md warns about, where each instance
re-persists what the other wrote. A redirect is the cheap correct fix.