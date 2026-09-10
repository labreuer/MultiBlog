# Multi-anchoring: what the literature says

A survey of multi-target linking and anchoring — hypertext systems research, the W3C Web
Annotation standardization record, knowledge representation, NLP/DH annotation tooling, and
the HCI literature on formalization — commissioned 2026-08-26, before starting PLAN.md §20's
PR 2, to answer two questions about its multi-part anchor design:

1. An annotation or tag assignment targeting several parts via a flat set of anchor rows
   (`part_order` and nothing else) — when other people do this, do they generally want more
   structure than a raw set of links?
2. Does adding a string description of "why this link" quickly turn out to be inadequate?

Short answers: **(1) only when the parts play different roles — and then always; (2) yes for
anything computational, but the heavyweight alternative fails too, and the field's landing
point is a small controlled vocabulary plus optional free text.** The long answers follow,
then the verdict for PR 2.

## The vocabulary

What this idea is called, for future searching: **n-ary links** and **multi-ended links**
(hypertext research), **fat links** / **multi-tailed** / **one-to-many links**, **extended
links** with **locators, arcs, roles** (XLink), **specifiers** with directions (Dexter),
**independent links / ilinks** with **anchor roles** (HyTime), **associations + bindings**
(FOHM), **multi-target annotation** and the **multiplicity constructs** `Choice` /
`Composite` / `List` (Web Annotation), **discontinuous / discontiguous annotation** and
**fragments** (brat, CATMA, NLP corpora), `<join>` (TEI), **n-ary relations**,
**reification**, and **qualified statements** (semantic web, Wikidata), **association class**
/ **associative entity** (UML/ER), **linked vs. convergent premises** (argumentation theory).

## Finding 1: there are two constructs, and the known mistake is conflating them

Everything surveyed sorts into one of two shapes:

**(a) Aggregation** — one logical selection that happens to be in pieces. Every tool that
handles this uses an owner plus an ordered list of parts, with **no per-part structure at
all**:

- [brat](https://brat.nlplab.org/standoff.html)'s discontinuous annotations are
  semicolon-separated offset pairs under one annotation id.
- [CATMA](https://catma.de/how-to/tutorials/manual-annotation/)'s annotation is "a type (its
  Tag) and one or more references to possibly non-adjacent text segments."
- TEI's [`<join>`](https://tei-c.org/release/doc/tei-p5-doc/en/html/SA.html) points at
  discontiguous elements. It carries one extra thing — `result`, *what the parts virtually
  form* — which in §20's terms is the owner row's kind (annotation vs. tag assignment).
- A PDF highlight annotation is one annotation with many QuadPoints.

Nobody in this family has per-part roles, per-part descriptions, or inter-part links.

**(b) Relation** — parts playing *different* roles. Every system that survived contact with
users added per-endpoint typing, without exception:

- [Dexter](https://mprove.de/visionreality/text/2.2.2_dexter.html)'s link specifiers each
  carry a direction (FROM / TO / BIDIRECT / NONE); HyTime ilinks carry anchor roles.
- [XLink extended links](https://www.w3.org/TR/xlink11/) give every locator a `role` and
  every arc an `arcrole` — URIs, not strings.
- [FOHM](https://www.researchgate.net/publication/221267399_FOHM_A_Fundamental_Open_Hypertext_Model_for_Investigating_Interoperability_between_Hypertext_Domains)'s
  bindings carry direction/shape feature vectors.
- [brat events](https://brat.nlplab.org/configuration.html) are `role:ref-ID` pairs from a
  configured schema — and brat keeps fragments (construct a) and events (construct b) as
  **separate primitives** sharing the span layer.
- The [W3C n-ary relations pattern](https://www.w3.org/TR/swbp-n-aryRelations/) is a
  relation-instance node with one named property per participant; Wikidata statements grew
  [qualifiers](https://en.wikibooks.org/wiki/SPARQL/WIKIDATA_Qualifiers,_References_and_Ranks)
  because bare triples couldn't carry role/time context.
- [Pundit](https://ceur-ws.org/Vol-912/paper4.pdf), the DH tool closest to this project's
  domain (typed relations between text fragments across documents), uses a customizable
  **controlled vocabulary of predicates**;
  [Recogito](https://hh2025f.amason.sites.carleton.edu/blog/interactive-annotations-with-recogito-tutorial/)'s
  relations are labeled connections.
- Argumentation theory is the sharpest statement of why: [Freeman's linked-vs-convergent
  distinction](https://link.springer.com/chapter/10.1007/978-94-007-0357-5_5) — premises
  jointly forming one unit vs. independently supporting a conclusion — is structure a flat
  set *cannot* express, and it changes what the aggregate means.

The test separating the two: **are the parts interchangeable under one "why"?** A
discontiguous quote's parts are. The moment the annotation's body would need to say "the
first passage…, whereas the second…", it's construct (b), and the record says a flat set
fails there.

This repo already respects the split without naming it: `doc_link_group` is the symmetric
aggregation ("these passages correspond"), and §20i's "doc_link ≈ anchor **plus role/color**"
acknowledges that parts with per-part meaning are a different row shape.

## Finding 2: severally-vs-jointly is the documented trap

The sharpest transferable lesson. The [Web Annotation Data
Model](https://www.w3.org/TR/annotation-model/) allows multiple targets, and the REC's
semantics is **distributive**: "each Body applies independently to each of the Targets." The
collective reading — all targets required together for the annotation to make sense — was
supposed to be `oa:Composite` (unordered) and `oa:List` (ordered), and both were **dropped
from the final REC** into an appendix "for future consideration" — not because the model was
hard ("practically identical to Choice") but because no UI could convey the distinction to
users. So the flagship multi-target standard shipped able to express only one of the two
meanings, and DH implementers have complained since. A whole [W3C wiki
page](https://www.w3.org/annotation/wiki/Expressing_Role_in_Multi-Body_Annotations) on
expressing per-body/per-target roles considered five mechanisms — all typed, none a free-text
description — and reached no consensus.

The lesson is not "build Composite"; it is **don't inherit the ambiguity — state which
reading each consumer family means**, which costs sentences, not schema. A system that fixes
the meaning globally per family escapes the problem that killed Composite/List, which was
asking a per-annotation UI to elicit the distinction.

## Finding 3: the structure people add first is the one §20 already has

The recurring failure in the wild is links with **no grouping node**: bare RDF triples needed
reification and eventually RDF-star; bare backlinks in PKM tools spawned a cottage industry
of typed-link plugins. The first structure every tradition adds is a **reified relation
instance** — the SWBP pattern's relation node, Wikidata's statement, UML's association class,
brat's event id. In §20's schema that node already exists: the owner row
(`tag_assignment`, `annotation`) carrying who/when/body *is* the n-ary relation instance.
"A raw set of links" undersells the design — it is hub-and-spokes, not a bag of edges. What
the parts lack is only the *second* thing traditions add — per-endpoint roles — and for
construct (a), no one adds it.

Deployment history also favors narrow scope. XLink extended links — the web's one attempt at
*generic* n-ary linking — were never implemented by browsers and survive only in
[XBRL](http://www.xbrl.org/Specification/xbrl-recommendation-2003-12-31+corrected-errata-2008-07-02.htm)
and similar niches; simple links won. Even pure aggregation UI is demand-limited:
Hypothes.is's data model has allowed multiple targets for a decade, and the [feature request
for discontiguous selection](https://github.com/hypothesis/vision/issues/220) still sits
unimplemented awaiting "compelling use cases." Building the two specific constructs this
project has drivers for (mark-splits, PDF quads, multi-part capture) rather than a general
link model is the side of that history that shipped.

## Finding 4: free-text "why", and the failure on both sides

- **Strings fail computation.** Every system that needed to filter, render, traverse, or
  validate by link-kind moved to a vocabulary: XLink's roles are URIs; Web Annotation uses a
  fixed SKOS vocabulary of ~13 [motivations/purposes](https://www.w3.org/TR/annotation-model/)
  (`tagging`, `commenting`, `linking`, …); Wikidata qualifiers are typed properties; brat
  roles come from a schema. Free text can't be queried and immediately forks into synonyms
  and case variants — precisely the argument the tag system itself embodies: a controlled
  vocabulary with a `lower(name)` unique index instead of free-text tags.
- **But heavy typing fails humans.**
  [Trigg's Textnet](https://www.semanticscholar.org/paper/TEXTNET:-a-network-based-approach-to-text-handling-Trigg-Weiser/5956f84b05e25de97c0f11266f7ba51f369448bf)
  offered 80+ scholarly link types; no such taxonomy achieved use.
  [Aquanet](https://dl.acm.org/doi/10.1145/122974.123000)'s users, given typed n-ary
  relations as the central primitive, used far fewer explicit relations than anticipated and
  conveyed structure spatially instead — its successors VIKI/VKB [dropped visible links
  entirely](https://dl.acm.org/doi/10.1145/208344.208350). Shipman & Marshall's ["Formality
  Considered Harmful"](https://people.engr.tamu.edu/shipman/formality-paper/harmful.html) is
  the canonical analysis: users resist premature explicit structure (cognitive overhead,
  evolving understanding, tacit knowledge), and the cure is **incremental formalization** —
  capture informally, formalize when a feature pays for it.
  [CiTO](https://jcheminf.biomedcentral.com/articles/10.1186/s13321-020-00448-1)'s near-zero
  authoring uptake for typed citations is the modern replication.
- So a *mandatory* per-part role or description field would be the worst of both:
  unqueryable if free, unfilled if formal. An annotation's ydoc body already is the free-text
  "why" for the whole act — the Web Annotation body/target split exactly — and the literature
  says that is where the "why" belongs until something computes on it.

## Verdict for PR 2

The nervousness aims at a real hazard, but the hazard is **construct (b) sneaking in through
construct (a)'s door**, not the flat parts themselves. For what PR 2 ships — discontiguous
selection within one container, distributive tags — the flat ordered set under a reified
owner is not a simplification of what the field does; it *is* what the field does,
unanimously. Where designs went wrong was (1) leaving jointly-vs-severally unstated (W3C's
scar), and (2) stretching aggregation to carry relations instead of adding a role-bearing
construct (brat keeps them separate primitives for this reason).

Recommendations recorded at survey time — **deliberately not yet folded into PLAN.md §20**;
they are on file here for when the question next arises:

1. **State the parts' semantics per family** (annotation multi-part = collective, one remark
   about the ensemble; tag parts = distributive, the term applies to each part, grouped
   only as one act for undo and attribution), and state what `part_order` means.
2. **Name the upgrade and its trigger, §20i-style**: the first request whose meaning
   distinguishes parts — "definition here, usage there," "compare this with that," a body
   addressing "the second quote" — gets a nullable `part_role` from a small vocabulary (one
   additive column per anchor table, no backfill; null = plain part). True *relational*
   annotation — a typed link between two selections à la Pundit — is a new consumer family
   on the anchor envelope, which §20a's supertype-pivot triggers already anticipate; never an
   overload of multi-part.
3. **A free-text per-part description is rejected on the record above**, so any future
   discussion starts from the literature instead of re-running it.

## Sources

- [Web Annotation Data Model (W3C REC, 2017)](https://www.w3.org/TR/annotation-model/)
- [Sanderson et al., Designing the W3C Open Annotation Data Model](https://arxiv.org/pdf/1304.6709)
- [W3C wiki: Expressing Role in Multi-Body Annotations](https://www.w3.org/annotation/wiki/Expressing_Role_in_Multi-Body_Annotations)
- [XML Linking Language (XLink) 1.1](https://www.w3.org/TR/xlink11/)
- [The Dexter Hypertext Reference Model (overview)](https://mprove.de/visionreality/text/2.2.2_dexter.html)
- [Millard et al., FOHM: A Fundamental Open Hypertext Model](https://www.researchgate.net/publication/221267399_FOHM_A_Fundamental_Open_Hypertext_Model_for_Investigating_Interoperability_between_Hypertext_Domains)
- [DeRose, Expanding the Notion of Links (Hypertext '89)](https://dl.acm.org/doi/10.1145/74224.74245)
- [Trigg & Weiser, TEXTNET: a network-based approach to text handling](https://www.semanticscholar.org/paper/TEXTNET:-a-network-based-approach-to-text-handling-Trigg-Weiser/5956f84b05e25de97c0f11266f7ba51f369448bf)
- [Marshall et al., Aquanet: a hypertext tool to hold your knowledge in place](https://dl.acm.org/doi/10.1145/122974.123000)
- [Marshall & Shipman, Spatial hypertext: designing for change](https://dl.acm.org/doi/10.1145/208344.208350)
- [Shipman & Marshall, Formality Considered Harmful](https://people.engr.tamu.edu/shipman/formality-paper/harmful.html)
- [W3C SWBP: Defining N-ary Relations on the Semantic Web](https://www.w3.org/TR/swbp-n-aryRelations/)
- [Wikidata qualifiers, references and ranks](https://en.wikibooks.org/wiki/SPARQL/WIKIDATA_Qualifiers,_References_and_Ranks)
- [brat standoff format](https://brat.nlplab.org/standoff.html) · [brat configuration](https://brat.nlplab.org/configuration.html)
- [CATMA: manual annotation](https://catma.de/how-to/tutorials/manual-annotation/)
- [TEI P5 §17: Linking, Segmentation, and Alignment](https://tei-c.org/release/doc/tei-p5-doc/en/html/SA.html)
- [Grassi et al., Pundit: Semantically Structured Annotations](https://ceur-ws.org/Vol-912/paper4.pdf)
- [Recogito relations (tutorial)](https://hh2025f.amason.sites.carleton.edu/blog/interactive-annotations-with-recogito-tutorial/)
- [Hypothes.is issue #220: annotate non-continuous sequences](https://github.com/hypothesis/vision/issues/220)
- [Freeman, The Linked-Convergent Distinction](https://link.springer.com/chapter/10.1007/978-94-007-0357-5_5)
- [Willighagen et al., Adoption of the Citation Typing Ontology by the Journal of Cheminformatics](https://jcheminf.biomedcentral.com/articles/10.1186/s13321-020-00448-1)
- [XBRL 2.1 (XLink's surviving niche)](http://www.xbrl.org/Specification/xbrl-recommendation-2003-12-31+corrected-errata-2008-07-02.htm)
