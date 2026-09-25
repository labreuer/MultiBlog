# Research

Literature and prior-art surveys, commissioned before design work to find out what others have
built and what happened to it. Each one is a **dated snapshot**: it records what was found at
the time, and it is not edited to track what became true later. Corrections are logged in the
study's card rather than hidden by rewriting.

## Layout

A study that is a single document is one file here (`multi-anchoring.md`, `tables.md`).

A study with supporting material is a folder, inside a project folder when several studies
share a topic (`multiwiki/`). The names inside a study folder are fixed:

| | |
|---|---|
| `README.md` | The card: the question (the prompt, verbatim), date, method, what it builds on, status with a log of corrections, and anything relevant that isn't committed. |
| `report.md` | The synthesized report. |
| `notes/` | The researcher notes the report was written from. |
| `sources/` | External material we are free to commit, such as an exported chat. |
| `overview.md` | The requester's own summary and thoughts, when there are any. |
| `discussion.md` | Conclusions reached in conversation after the report, when there are any. |

Names are kebab-case, with no spaces. Material we may not redistribute, such as a book's PDF,
is recorded in the card by edition and never committed.

The deep-research skill writes `reports/<Title>.md` and `research_notes/<Title>/` into its
working directory. Move them into a study folder afterwards, and fix any paths the notes use to
refer to each other or to earlier studies.
