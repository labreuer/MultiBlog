# Paradigm and discourse models: formal and computational precedents for forkable "embeddings"

Scope: (A) philosophy-of-science models whose unit is a structured whole that evolves, forks and is compared with rivals; (B) built systems for scholarly claims, discourse and perspectives, and what using them showed; (C) any attempt to hold a Kuhnian paradigm or MacIntyrean tradition as a data structure. Excluded because the earlier surveys ([`labeled-viewpoints/notes/argument-and-debate-systems.md`](../../labeled-viewpoints/notes/argument-and-debate-systems.md), [`labeled-viewpoints/notes/academic-research.md`](../../labeled-viewpoints/notes/academic-research.md)) cover them: IBIS/Compendium, Cohere, Kialo, Deliberatorium, Society Library, the PhilPapers survey, Wikidata, Cyc.

Reference key for the user's four embedding features, used throughout: **(1)** whole entities or passages assigned to one or more embeddings; **(2)** relationships between entities assigned to an embedding; **(3)** embeddings fork; **(4)** the revision is recorded on entry, and later revisions can be re-affirmed.

Verification convention: the cited source was opened unless the note says "(search summary)", meaning only a search engine's summary of the page was seen, or "(unverified)".

---

## Key question A: philosophy-of-science models whose unit is a structured, evolving, forkable whole

### Takeaway
Only one tradition gives a formal data structure with the features the user wants: Sneed–Stegmüller–Balzer–Moulines structuralism. Its **theory-net** is a partially ordered set of theory-elements; its **theory-evolution** is a sequence of nets constrained by continuity conditions; its **links** are typed relations between theories. Sneed implemented theory-nets in PROLOG in 1989 to model Lakatosian research programmes. Kuhn called it "the one that best fits with what goes on."

The cognitive models supply the vocabulary for *comparing* two wholes and for grading how deep a divergence runs:
- Thagard's kind/part hierarchies, with nine degrees of change up to "branch jumping" and "tree switching".
- Andersen–Barker–Chen's Barsalou frames, together with Kuhn's no-overlap principle.
- Gärdenfors–Zenker's five kinds of dimensional change.

These cognitive models also back the user's intuition that "synonyms must be structural". In each of them, two concepts are the same when their frames, hierarchy positions or dimensions correspond, not when their labels match.

### Cited Findings

#### A1. Structuralism (Sneed 1971; Stegmüller 1973/1976; Balzer, Moulines & Sneed 1987)

**Citations**
- Balzer, W., Moulines, C. U., & Sneed, J. D. (1987). *An Architectonic for Science: The Structuralist Program*. Dordrecht: Reidel. Its chapters are titled "Theory-Elements" (ch. 2) and "Theory-Nets" (ch. 4). — [Springer ch. "Theory-Nets"](https://link.springer.com/chapter/10.1007/978-94-009-3765-9_4); [Springer ch. "Theory-Elements"](https://link.springer.com/chapter/10.1007/978-94-009-3765-9_2); bibliography in [Lorenzano 2013 (PDF)](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y). I could not open the book itself. The definitions below are quoted from Lorenzano, P. (2013), "The semantic conception and the structuralist view of theories: A critique of Suppe's criticisms," *Studies in History and Philosophy of Science* 44: 600–607, a structuralist's own summary of the program.

**The unit: a theory-element**
- A theory-element's core K is "composed by the ordered classes of potential models, of actual models, of partial potential models, of constraints and of links."
  - "Constraints" are "innertheoretical relationships between the different models of a theory."
  - "Links" are relationships between theories: "different theories are usually interconnected to each other. These intertheoretical relationships are represented by the so-called (intertheoretical) links."
  - — [Lorenzano 2013, SHPS 44, p. 604](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
- **Intended applications (I).** "These phenomena also belong to a theory's identity because otherwise we would not know what the theory is about … They constitute what is called the theory's domain of intended applications, and is symbolized by I. … I is a kind of entity strongly depending on pragmatic and historical factors which, by their very nature, are not formalizable." — [Lorenzano 2013, pp. 604–605](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
- **The empirical claim is phrased as embedding.** A theory's claim is "that a given domain of intended applications may actually be (exactly or approximately) subsumed (or embedded) under the theory's principles (laws, constraints, and links)." The claim is usually "strictly false" for the whole domain but true "for a subclass of intended applications." Elsewhere: "the structures representing the empirical data or phenomena that the theory intends to account for are 'embeddable' into such theoretical models." — [Lorenzano 2013, pp. 603, 605](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)

**Theory-nets and theory-evolutions**
- **Theory-net.** "Usually single theories in the intuitive sense have to be conceived as aggregates of several (sometimes a great number of) theory-elements. These aggregates are called theory-nets." There is "a single fundamental law … 'on the top' of the hierarchy and a vast array of more special laws … Each special law determines a new theory-element." "A theory-net … is a finite set of theory-elements (hierarchically) ordered by the (non-deductive) relation of specialization—which is reflexive, antisymmetric and transitive." What holds the net together is "the common conceptual framework (… potential models), … the common T-theoretical and T-non-theoretical distinction, and … the fact that they are all specializations of the same fundamental law." — [Lorenzano 2013, p. 605](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
- **Theory-evolution.** "A theory in the diachronic sense is not just a theory-net, which keeps existing in the same form through history, but a theory-net that 'evolves.' Such an entity is called a theory-evolution, which is essentially a sequence of theory-nets fulfilling two conditions:
  - at the level of cores, it is required for every new theory-net in the sequence that all its theory-elements are specializations of some theory-elements of the previous theory-net;
  - at the level of intended applications, it is required that the domains of the new theory-net have at least some partial overlapping with the domains of the previous theory-net."
  - — [Lorenzano 2013, p. 605](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)

**Relations between theories, and kinds of change**
- The structuralists also define "theoretization, reduction, (empirical and full) equivalence, as well as (intra- and intertheoretical) approximation," and the "global structure of science (by using the concept of a theory-holon)." — [Lorenzano 2013, p. 605](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
- They distinguish *kinds* of diachronic change: "not just intratheoretical changes … (by means of the concept of a theory-evolution), but also different types of intertheoretical changes, such as crystallization, embedding, and replacement with (partial) incommensurability." Source: Moulines, C. U. (2011), "Cuatro tipos de desarrollo teórico en las ciencias empíricas," *Metatheoria* 1: 11–27. Reduction covers "the case in which there is an embedding of one theory into another (without incommensurability)." — [Lorenzano 2013, pp. 603, 605](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)

**The Kuhn connection**
- **Paradigms formalized.** "Balzer et al. (1987) used the notion of paradigmatic applications to define Kuhnian paradigms and paradigm-guided theory-evolutions. This required the introduction of diachronic theory-nets and the diachronic specialization relation." — (search summary of [Damböck, "Thomas Kuhn and the Structuralist View of Scientific Theories" (PDF)](https://homepage.univie.ac.at/christian.damboeck/texte/kuhn_stegmueller.pdf); the PDF itself returned 503).
- **Kuhn's response.** Kuhn, T. S. (1976), "Theory-change as structure-change: Comments on the Sneed formalism," *Erkenntnis* 10(2): 179–199 — [Crossref DOI 10.1007/bf00204969](https://doi.org/10.1007/bf00204969).
  - He praised the formalism for normal science but doubted reduction could capture revolutions: "I am not confident that any pair of historical theories separated by a revolution will satisfy your reduction relation" (Kuhn to Stegmüller, letter of 1975). — [Lorenzano 2013, p. 603](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
  - Late in life (*The Road Since Structure*, 2000, pp. 318–319): "if you take a dynamic view, you've got to have something that talks about revision of terminology and introduction of new terminology as part of the introduction of a new theory, of a new structure … that's why I would still point back to the Sneed–Stegmüller version as the one that best fits with what goes on. It adapts itself to a historical developmental approach." — quoted in [Lorenzano 2013, p. 603](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)

**Computational implementations**
- **Sneed 1989.** Sneed, J. D. (1989), "Machine Models for the Growth of Knowledge: Theory Nets in Prolog," in *Imre Lakatos and Theories of Scientific Change* (Dordrecht: Springer/Kluwer), pp. 245–268. The editors, Gavroglu, Goudaroulis & Nicolacopoulos, and the series, Boston Studies vol. 111, are from memory (unverified).
  - The paper "sketches one way that scientific knowledge or information might be stored in a digital computer and used to model the problem solving activity of empirical scientists." It proposes computer-modelling "scientific problem solving activities within research programs associated with scientific communities … the kind of scientific activity first described by Imre Lakatos."
  - — [SpringerLink](https://link.springer.com/chapter/10.1007/978-94-009-3025-4_19) (search summary of abstract); pages from [Semantic Scholar record](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1007/978-94-009-3025-4_19).
- **Knowledge-representation framing.** The structuralists framed their catalogue of reconstructions as knowledge representation: Balzer, W., Moulines, C. U., & Sneed, J. D. (eds.) (2000), *Structuralist Knowledge Representation: Paradigmatic Examples*, Amsterdam: Rodopi. — [PhilPapers](https://philpapers.org/rec/BALSKR); [Lorenzano 2013 bibliography](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
- **Bridges to other programmes.**
  - Structuralism to scientometrics: Massey, T. (2014), "Structuralism and Quantitative Science Studies: Exploring First Links," *Erkenntnis* 79: 1493–1503 — [PhilPapers](https://philpapers.org/rec/MASSAQ); metadata via [Semantic Scholar](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1007/s10670-013-9579-4). I could not read the content (Springer paywall).
  - Structuralism to conceptual spaces: Zenker, F. & Gärdenfors, P. (2014), "Modeling Diachronic Changes in Structuralism and in Conceptual Spaces," *Erkenntnis* 79 (Suppl. 8): 1547–1561 — [Crossref DOI 10.1007/s10670-013-9582-9](https://doi.org/10.1007/s10670-013-9582-9).
  - Both appear in the same special issue, introduced by Andreas, H. & Zenker, F., "Basic Concepts of Structuralism," *Erkenntnis* 79: 1367–1372 — [Springer](https://link.springer.com/article/10.1007/s10670-013-9572-y).

#### A2. Thagard, *Conceptual Revolutions* (Princeton UP, 1992)

- **The unit** is a conceptual system: concepts linked by **kind-relations** and **part-relations**, plus rules. It is evaluated by explanatory coherence. Thagard's own list of nine "degrees of conceptual change" (repeated from Thagard 1992 and 1999, p. 150), quoted verbatim:
  1. "Adding a new instance of a concept …"
  2. "Adding a new weak rule …"
  3. "Adding a new strong rule that plays a frequent role in problem solving and explanation …"
  4. "Adding a new part-relation …"
  5. "Adding a new kind-relation …"
  6. "Adding a new concept …"
  7. "Collapsing part of a kind-hierarchy, abandoning a previous distinction, for example, realizing that phthisis and scrofula are the same disease, tuberculosis."
  8. "Reorganizing hierarchies by branch jumping, that is shifting a concept from one branch of a hierarchical tree to another, for example reclassifying tuberculosis as an infectious disease."
  9. "Tree switching, that is, changing the organizing principle of a hierarchical tree, for example classifying diseases in terms of causal agents rather than symptoms."
  - "The most radical kinds of conceptual change involve the last two … as when Darwin reclassified humans as animals and changed the organizational principle of the tree of life to be evolutionary history rather than similarity of features."
  - — [Thagard, "Conceptual Change in the History of Science: Life, Mind, and Disease" (preprint, 2006), for Vosniadou (ed.), *Handbook of Conceptual Change*](http://cogsci.uwaterloo.ca/Articles/conc.change.life.pdf)
- **Where the revolutions sit on that scale.** "All the major scientific revolutions in the natural sciences — Copernicus, Newton, Lavoisier, Darwin, Einstein, quantum theory, and plate tectonics — involved major changes in conceptual organization involving kind and/or part relations (Thagard, 1992)." — [Thagard, "The concept of disease"](http://cogsci.uwaterloo.ca/Articles/Pages/Concept.html) (search summary; the page failed TLS when fetched)
- **Against belief revision.** Thagard argued that belief-revision systems capture only the most conservative changes on his scale, not branch jumping or tree switching. — (search summary of [Belief Revision vs. Conceptual Change in Mathematics, Springer](https://link.springer.com/chapter/10.1007/978-3-642-15223-8_6))
- **Computational implementation (ECHO).** Thagard, P. (1989), "Explanatory coherence," *Behavioral and Brain Sciences* 12(3): 435–467 (with commentary to p. 502).
  - Seven principles define local coherence between propositions. ECHO builds a network in which "coherence and incoherence relations are encoded by excitatory and inhibitory links."
  - It "has been applied to such important scientific cases as Lavoisier's argument for oxygen against the phlogiston theory and Darwin's argument for evolution against creationism."
  - — [Cambridge Core](https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/explanatory-coherence/E05CB61CD64C26138E794BC601CC9D7A); [PDF](https://gwern.net/doc/philosophy/epistemology/1989-thagard.pdf) (search summary)

#### A3. Frames and Kuhn's taxonomic incommensurability (Chen & Barker 2000; Andersen, Barker & Chen 2006)

**Citations**
- Chen, X. & Barker, P. (2000), "Continuity Through Revolutions: A Frame-Based Account of Conceptual Change During Scientific Revolutions," *Philosophy of Science* 67 (Suppl. S3): S208–S223 — [Crossref DOI 10.1086/392820](https://doi.org/10.1086/392820).
- Andersen, H., Barker, P. & Chen, X. (2006), *The Cognitive Structure of Scientific Revolutions*, Cambridge UP — [DOI 10.1017/cbo9780511498404](https://doi.org/10.1017/cbo9780511498404). The Xiang Chen here is **not** Chaomei Chen of CiteSpace (section B).

**The claims**
- Chen & Barker's thesis: "when concepts are represented by frames, the transformation from one taxonomy to another can be achieved in a piecemeal fashion not preconditioned by a crisis stage." — [Cambridge Core abstract](https://www.cambridge.org/core/journals/philosophy-of-science/article/abs/continuity-through-revolutions-a-framebased-account-of-conceptual-change-during-scientific-revolutions/1262C51817AC751853A4028DB3FCFEF7) (search summary)
- **The frame model** (reviewer George Botterill, *NDPR*): a frame is "a hierarchy of nodes" with attributes at the first level permitting "a range of values at a second level, with possible recursion."
- **Incommensurability softened.** ABC hold that incommensurability is "partial rather than total; that it does not 'happen instantaneously'; that it does not 'guarantee communication failure.'"
- **Anomalies.** Anomalies are "conceptually intractable until the frame is re-structured."
- **Case studies.** The Copernican revolution: they argue Copernican and Ptolemaic astronomy "shared much the same conceptual structure" until Kepler. Also the South American screamer as a taxonomic anomaly, and radioactivity.
- **The reviewer's objection.** ABC are "selling themselves short" by keeping the word "incommensurability."
- — [Botterill, NDPR review](https://ndpr.nd.edu/reviews/the-cognitive-structure-of-scientific-revolutions/)

**Frames used to compare two rival theories**
- Votsis, I. & Schurz, G. (2012), "A frame-theoretic analysis of two rival conceptions of heat," *Studies in History and Philosophy of Science* 43(1): 105–114.
  - They use frames to test "to what extent certain theoretical claims made by the outdated caloric theory of heat … have survived into the theory that superseded it, i.e. the kinetic theory of heat."
  - Frames are "a recursive system of attributes"; "value-attribute constraints" restrict attributes to sub-concepts.
  - Conclusion: the survival "lend[s] credence to structural realism."
  - — [author PDF](https://votsis.org/PDF/Votsis_Schurz_A_Frame-Theoretic_Analysis_of_Two_Rival_Conceptions_of_Heat.pdf)
- Related: Schurz & Votsis, "Reconstructing Scientific Theory Change by Means of Frames" (Springer, 2014 volume) — [Springer](https://link.springer.com/chapter/10.1007/978-3-319-01541-5_4). Kornmesser, "A frame-based approach for theoretical concepts," *Synthese* — [Springer](https://link.springer.com/article/10.1007/s11229-015-0750-0). Neither was opened.

#### A4. Kuhn's late lexicon / taxonomy work (*The Road Since Structure*, 2000)

- **The no-overlap principle.** "The no-overlap principle precludes cross-classification of objects into different kinds within a theory's taxonomy … no two kind terms may overlap in their referents unless they are related as species to genus" (Kuhn 2000 [1991], 92). Revolutions "change the structural relations between pre-existing kind terms, breaking the no-overlap principle" (Kuhn 2000, 92–96).
- **Kind terms are learned together.** Kind terms are "used to state laws and theories and must be learned *together* through experience" (Kuhn 2000 [1993], 230).
- **Local incommensurability.** Kuhn insisted his incommensurability had always been "local": it "restricts conceptual change to a few, typically interconnected concepts" (Hoyningen-Huene 1993, 213, 219).
- — [SEP, "The Incommensurability of Scientific Theories"](https://plato.stanford.edu/entries/incommensurability/)
- **Taxonomy and lexical network.** "A field of science is governed by a taxonomy, which divides its subject matter into kinds. Associated with a taxonomy is a lexical network—a network of related terms." After significant change, "the terms of the new and old taxonomies will not be inter-translatable."
- **Why the taxonomies cannot be merged.** "If two categories have members in common then one must be fully included within the other; otherwise they are disjoint." This prevents "an all-encompassing taxonomy that incorporates both the original and the changed taxonomies." Hacking adds that "distinct lexicons covering overlapping subject matters cannot be merged", which gives the speciation analogy for specialties.
- **The disciplinary matrix (1969 Postscript)** comprises "(a) symbolic generalizations … (b) beliefs about which objects and phenomena … exist … (c) values … and (d) exemplary problems." — [IEP, "Scientific Change" (Andersen & Hepburn)](https://iep.utm.edu/scientific-change/)
- — [SEP, "Thomas Kuhn"](https://plato.stanford.edu/entries/thomas-kuhn/)

#### A5. Conceptual spaces (Gärdenfors & Zenker)

- Gärdenfors, P. & Zenker, F. (2013), "Theory change as dimensional change: conceptual spaces applied to the dynamics of empirical theories," *Synthese* 190(6): 1039–1058 (online 2011) — [Springer](https://link.springer.com/article/10.1007/s11229-011-0060-0); [PhilPapers](https://philpapers.org/rec/GRDTCA).
  - Five types of change: "(1) addition or deletion of special laws, (2) change in scale or metric, (3) change in the importance of dimensions, (4) change in the separability of dimensions, and (5) addition or deletion of dimensions."
  - "Only the most extreme type—replacement of dimensions—comes close to a revolution."
  - Case study: Newtonian mechanics to special relativity.
  - (Search summary of the PhilPapers abstract.)
- Zenker & Gärdenfors (2014), *Erkenntnis* 79 S8: 1547–1561, compares diachronic modelling in structuralism and in conceptual spaces — [Crossref](https://doi.org/10.1007/s10670-013-9582-9).
- Masterton, G., Zenker, F. & Gärdenfors, P. (2017), "Using conceptual spaces to exhibit conceptual continuity through scientific theory change," *European Journal for Philosophy of Science* 7: 127–150 — [Springer](https://link.springer.com/article/10.1007/s13194-016-0149-x).
- Zenker, F. & Gärdenfors, P. (eds.) (2015), *Applications of Conceptual Spaces: The Case for Geometric Knowledge Representation*, Synthese Library 359 (the title is "Applications of…", not "Applying…") — [Springer](https://link.springer.com/book/10.1007/978-3-319-15021-5).

#### A6. Lakatos, Laudan, Fleck, MacIntyre: units defined by commitments and communities

**Lakatos**
- A research programme has "central theses that are deemed irrefutable—or, at least, refutation-resistant—by methodological fiat" (the hard core), and a "protective belt of auxiliary hypotheses."
- "The negative heuristic of the programme forbids us to direct the *modus tollens* at this 'hard core'"; the positive heuristic is "a partially articulated set of suggestions or hints on how to change, develop the 'refutable variants'."
- Programmes are progressive or degenerating, and rival programmes coexist. — [SEP, "Imre Lakatos"](https://plato.stanford.edu/entries/lakatos/)

**Laudan**, *Progress and Its Problems* (1977)
- A research tradition is "a set of general assumptions about the entities and processes in a given domain and about the appropriate methods to be used for investigating the problems and constructing the theories in that domain."
- Unlike Lakatos, change within a tradition "might also involve changes to its most basic core elements": "absolute time and space were seen as part of the unrejectable core of Newtonian physics in the eighteenth century, they were no longer seen as such a century later."
- Success is "overall problem solving effectiveness (not all problems are empirical ones)."
- — [IEP, "Scientific Change" (Hanne Andersen & Brian Hepburn)](https://iep.utm.edu/scientific-change/). The page number (usually cited as p. 81) is unverified.

**Fleck** (*Entstehung und Entwicklung einer wissenschaftlichen Tatsache*, 1935; English *Genesis and Development of a Scientific Fact*, U. Chicago Press 1979, tr. Bradley & Trenn, foreword by Kuhn)
- A thought collective is "a community of persons mutually exchanging ideas or maintaining intellectual interaction."
- A thought style is "readiness for directed perception, with corresponding mental and objective assimilation of what has been so perceived, characterized by specific problems of interest, by judgments which the thought collective considers evident and by methods which are applied as a means of cognition."
- Collectives split into esoteric and exoteric circles.
- Scientific literature comes in three forms: **journal science**, **handbook/vademecum science** (which consolidates knowledge for newcomers) and popular science.
- Individuals belong to several collectives at once. Style change is collective and "nobody intended" it.
- Fleck already held thought styles incommensurable (1939).
- — [SEP, "Ludwik Fleck"](https://plato.stanford.edu/entries/fleck/)

**MacIntyre**
- MacIntyre, A. (1977), "Epistemological Crises, Dramatic Narrative and the Philosophy of Science," *The Monist* 60(4): 453–472. It addresses Kuhn and Lakatos, and argues that a tradition's rationality shows in its ability to write a true narrative of its own crisis — [PDCnet](https://www.pdcnet.org/monist/content/monist_1977_0060_0004_0453_0472); [OUP](https://academic.oup.com/monist/article-abstract/60/4/453/990730).
- A paper on academia.edu compares MacIntyre's tradition-constituted enquiry with Laudan's research traditions; both "accept that progress consists in better problem solving" — [academia.edu](https://www.academia.edu/6712444/MacIntyres_Tradition_Costituted_Enquiries_and_Laudans_Research_Traditions) (search summary; author unverified).

### Inferences

**Mapping each model to features (1)–(4)** (my synthesis from the findings above):

| Model | Structured unit | How two units relate | (1) members | (2) relations inside | (3) fork | (4) revision / re-affirm |
|---|---|---|---|---|---|---|
| Structuralism | theory-element ⟨K, I⟩; theory-net = poset under specialization; theory-evolution = sequence of nets | specialization; links; reduction, equivalence, approximation; theory-holon; crystallization, embedding, replacement | intended applications **I**, partly given by paradigmatic exemplars; the empirical claim holds only for a *subclass* of I | constraints (between models of one theory) and links (between theories) are part of the core itself | two specializations of one basic element are sibling branches; so are two evolutions sharing an early net | evolution requires each new element to specialize an old one and I to overlap the old I. That is an explicit continuity test between successive versions |
| Thagard | conceptual system: kind-/part-hierarchies + rules + coherence | nine graded kinds of difference; ECHO scores rival sets | instances and concepts | kind-links, part-links, explanatory links | branch jumping / tree switching as the deep divergences | degrees 1–6 are cumulative edits; 7–9 are reorganizations |
| ABC / frames | frame = attribute–value hierarchy + constraints; kind taxonomy under no-overlap | frames compared attribute by attribute; a no-overlap violation marks incommensurability | exemplars and kinds | constraints between attributes | a new taxonomy re-partitions kinds | change is "piecemeal", "not preconditioned by a crisis stage" |
| Gärdenfors–Zenker | conceptual space: dimensions with metrics, weights, separability; laws as regions | five graded kinds of dimensional change | objects as points | laws as regions | re-weighting vs. adding or removing dimensions | only dimension replacement is revolutionary |
| Lakatos | hard core + belt + heuristics | rival programmes, judged progressive or degenerating | theories in the belt | heuristic guidance | a new core means a new programme | the belt is revised freely; the core never is |
| Laudan | research tradition: ontology + methodology, with many theories | rival or grafted traditions | the family of theories | ontological and methodological commitments | a core member can leave while identity persists | identity survives change even to the core |
| Fleck | thought collective + thought style | incommensurable styles; circles | people and texts | "judgments which the collective considers evident" | styles mutate without anyone intending it | journal science → vademecum science |

**Three structuralist precedents map closely onto the embedding design.**
- *Intended applications* (I) are a curated, historically contingent, non-formalizable set of real systems that a theory "is about." That is the user's feature (1) almost exactly: documents or passages assigned by people, not by a rule.
- The empirical claim holding only for a *subclass* of I mirrors an embedding in which some assigned passages "fit" and others are merely claimed.
- The theory-evolution continuity conditions (every new element specializes an old one; the new I overlaps the old I) are a formal ancestor of feature (4): re-affirming that a later revision still fits.

**Naming collision.** Structuralism already uses "embedding" as a technical term, twice: data models "embedded" in theoretical models (the empirical claim), and "embedding" as one of Moulines's kinds of intertheoretical change (one theory placed within another). Machine learning also uses "embedding" for vectors. The user's term is defensible but will collide with both for anyone who knows either field.

**Support for "synonyms must be structural".** All four cognitive/formal models make identity structural. Frames compare attribute lists and constraints, Thagard locates a concept by its kind and part links, Gärdenfors locates it by its dimensions, and structuralism fixes a theory's terms by the potential models they occur in. Kuhn's no-overlap principle adds a hard constraint: two taxonomies whose kinds overlap without nesting *cannot* be merged into one taxonomy. That is an argument, not just a heuristic, for keeping embeddings as separate containers joined by partial translation rather than folding them into one tag hierarchy.

**The "peel away" then "pull together" dynamic has three precedents:**
- Chen & Barker's "piecemeal" frame change "not preconditioned by a crisis stage."
- Thagard's cumulative degrees 1–6 preceding reorganizations 7–9.
- Fleck's journal science (tentative, scattered) consolidating into vademecum science.

Kuhn's "local incommensurability" ("a few, typically interconnected concepts") suggests that the divergences which eventually pull together are the interconnected ones. A system could surface candidate "pulling together" by detecting links among the scattered divergent passages.

**The Lakatos/Laudan split is a design choice about embedding identity.**
- *Lakatos:* an embedding has a pinned core that cannot be revised without becoming a fork.
- *Laudan:* identity persists through changes to anything, including core members.

The user's re-affirmation feature (4) fits Laudan better. Adding a Lakatos-style "core" flag on some members could make forks meaningful: changing a core member forces a fork.

**Fleck's multiple membership matches feature (1) in the plural.** An entity in several embeddings corresponds to one person belonging to several thought collectives, whose conflicts stay "latent" while the collectives are distant.

### Gaps
- I did not open *An Architectonic for Science* or Stegmüller 1976. The structuralist definitions come from Lorenzano 2013, a sympathetic secondary source. BMS's formal definition of "paradigm" via paradigmatic applications is known only from a search summary of Damböck's paper; the PDF returned 503.
- Sneed 1989: only the abstract (via search summary) was seen. I could not determine what the PROLOG program represented, how large it was, or whether it was ever used beyond the paper.
- No later running software implementing theory-nets was found. The 2000 *Structuralist Knowledge Representation* volume appears to be reconstructions on paper, not a database (inferred from its title and description; not opened).
- Massey 2014 (structuralism ↔ scientometrics) and Zenker & Gärdenfors 2014 (structuralism ↔ conceptual spaces): only metadata was verified; I have not read the content.
- The ABC book was characterized only through Botterill's review and the Chen & Barker 2000 abstract summary. The book's explicit frame notation, its treatment of no-overlap inside frames, and whether the nuclear-fission chapter exists were not verified.
- Gärdenfors & Zenker's five types come from a search summary of the PhilPapers abstract; PhilPapers returned 403. No computational implementation of conceptual-space theory change for scholarly corpora was found.
- Laudan: the definition is quoted via IEP; the page number in *Progress and Its Problems* is unverified. Laudan's own account of how traditions "integrate" or graft (relevant to "pull together") was not found in an accessible source.
- MacIntyre: I found no formal or computational model of a MacIntyrean tradition.

---

## Key question B: built systems for scholarly discourse, claims and perspectives, and what their use showed

### Takeaway
The built systems fall into two camps.

- **Authoring systems:** ScholOnto/ClaiMaker, SWAN, micropublications, nanopublications, ORKG. They model *claims and typed relations between claims* very well, and several add lineage, similarity classes and versioning. None makes "school of thought" a first-class, forkable container. ClaiMaker's authors named modelling "school of thought" as future work. Their successor study *derived* "viewpoint clusters" by network clustering, as an analysis output rather than something users author.
- **Discovery systems:** CiteSpace and network-module work on Wikipedia. They detect paradigm-like clusters and turning points from citation or link structure, but give them no semantics.

What use showed is mostly sociotechnical. A 2024 review reports that ScholOnto, SWAN (Alzforum) and micropublications (Domeo) "are no longer active and the impact of these deployments has not been empirically evaluated." ORKG, the only large survivor, has about 4,200 comparisons against about 68,000 papers. Its quality has been assessed on only six comparisons.

### Cited Findings

#### B1. ScholOnto → ClaiMaker (Open University KMi, 2000–2004)

**Citations**
- Buckingham Shum, S., Motta, E. & Domingue, J. (2000), "ScholOnto: an ontology-based digital library server for research documents and discourse," *International Journal on Digital Libraries* 3(3): 237–248 — [Springer](https://link.springer.com/article/10.1007/s007990000034); metadata via [OU archive](https://research-archive.stem.open.ac.uk/scholonto/).

**The project**
- It ran 2001–2004, funded by EPSRC. Its goal was "to build and deploy a prototype infrastructure for making scholarly claims about the significance of research documents."
- Tools: ClaiMaker (server and form interface), ClaiMapper (visual, "based on the Compendium visual hypertext system"), ClaimFinder (query visualisation) and ClaimSpotter (text filtering). It "led subsequently to the Cohere web annotation platform."
- — [OU ScholOnto archive](https://research-archive.stem.open.ac.uk/scholonto/)

**The data model**, from Mancini, C. & Buckingham Shum, S. (2006), "Modelling discourse in contested domains: A semiotic and cognitive framework," *IJHCS* 64(11): 1154–1171 — [KMi preprint KMI-06-14](https://kmi.open.ac.uk/publications/pdf/kmi-06-14.pdf); [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1071581906001091)
- **Two-level claims.** A user associates "documents with concepts (primary claim)," then makes "connections between these concepts (secondary claim) to create a semantic triple … there is no formally defined concept class hierarchy (although one might 'plug in' a domain taxonomy …)."
- **Link taxonomy.** Six base relation classes: General; Problem-related; Supports/Challenges; Taxonomic; Similarity; Causal. Each has "dialect" labels (e.g. *proves, refutes, is-evidence-for, agrees-with, disagrees-with, is-inconsistent-with, part-of, subclass-of, is-similar-to, is-analogous-to, predicts, causes*) and a **polarity**. The design principle: "all scholarly fields make use of the base relational categories, but the 'dialect' of the field … varies across discipline … [the dialect] can be modified without affecting computational services that operate on the base relational classes."
- **Several readings of one source.** The paper's worked example has three users attach three different concepts to the *same* paper (two nearly synonymous, one opposed): "all three concepts are compatible with the source, but … the third one … express[es] a quite different perspective on the same source."
- **Terms differ across communities.** "The concept of 'ontology' means one thing to a philosopher and something rather different to [a] semantic web researcher … 'system' tends to mean one thing to computer scientists, something broader to a systems analyst, and something different again to a systems theorist." Majority use gives a concept class's "primary signified" within a community; uses at a community's borders are "secondary signifieds."
- **Against a single consensus model.** The paper argues against tools where "there is only one narrative or worldview worth keeping: the final ontology." "Supporting discourse is about supporting the construction of different perspectives on a domain, and not simply allowing the representation of any one of these perspectives … perspectives may change and multiply."
- **Services.** "Lineage" and "descendants" follow paths of positive causal or similarity links (e.g. *improves-on*, *uses/applies/is-enabled-by*) to show "how it evolved" or "what new ideas evolved from it." "Perspective analysis" contrasts clusters joined by positive vs. negative additive relations.
- **School of thought left as future work.** "A key part of our future work is … investigating the modelling of complex constructs such as 'school of thought' in order to assist in extracting potentially significant patterns from the claims network. Preliminary results … Benn, et al. (2005)."

**Evaluations**
- Uren, V., Buckingham Shum, S., Bachler, M. & Li, G. (2006), "Sensemaking tools for understanding research literatures: Design, implementation and user evaluation," *IJHCS* 64(5): 420–445 — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1071581905001709); metadata via [Semantic Scholar](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1016/j.ijhcs.2005.09.004). It reports a case study of ClaiMapper, ClaiMaker and ClaimFinder. The findings could not be accessed (403).
- Buckingham Shum, S., Uren, V., Li, G., Sereno, B. & Mancini, C. (2007), "Modeling naturalistic argumentation in research literatures: Representation and interaction design issues," *International Journal of Intelligent Systems* 22(1): 17–47 — [Crossref DOI 10.1002/int.20188](https://doi.org/10.1002/int.20188) (not opened).

#### B2. Viewpoint clusters derived from a debate graph (Benn, Buckingham Shum, Domingue & Mancini)

**Citations**
- Benn, N., Buckingham Shum, S., Domingue, J. & Mancini, C., "Designing the Ontological Foundations for Knowledge Domain Analysis Technology: An Interim Report," KMi Tech. Report KMI-08-02 — [KMi PDF](https://kmi.open.ac.uk/publications/pdf/kmi-08-02.pdf).
- Conference version: "Ontological Foundations for Scholarly Debate Mapping Technology," COMMA 2008, Toulouse — [ORO](https://oro.open.ac.uk/11939) (PDF returned 403).
- Earlier: Benn, Buckingham Shum & Domingue (2005), "Integrating Scholarly Argumentation, Texts and Community: Towards an Ontology and Services," CMNA workshop at IJCAI'05 (cited in Mancini & Buckingham Shum 2006; not opened).

**What it does**
- It merges four scholarly ontologies (Bibster, ESKIMO, CS AKTIVE SPACE, ClaiMaker) and adds Issue, Proposition and Argument classes, related by **supports** and **disputes**, building on Robert Horn's "Can computers think?" debate maps and Yoshimi's "logic of debate."
- **Method.** Inference rules project the multi-link debate onto a single "+ADDITIVE" (rhetorical-agreement) link type. Common support for X, common dispute of X, and "disputing a disputer" (undercutting) all yield +ADDITIVE. Bibliometric clustering (Netdraw) then runs over that graph.
- **Abortion case study.** The algorithm offered 2 to 25 clusters and chose five by goodness-of-fit. "The results are translated back into the knowledge base where each of the clusters … is captured as a **ViewpointCluster** instance." The system then computes "the persons who are associated with each cluster and the clusters … opposing each other. Two clusters are regarded as opposing if at least half of the viewpoints in one cluster have a 'disputes' relation with the viewpoints in the other."
- **Stated limit:** "the goal of this type of analysis is typically not to find the definitive clustering arrangement, but rather to detect interesting phenomena that will motivate more focussed investigation on the part of the analyst."
- — [KMI-08-02](https://kmi.open.ac.uk/publications/pdf/kmi-08-02.pdf)

#### B3. SWAN (Semantic Web Applications in Neuromedicine)

- Ciccarese, P., Wu, E., Wong, G., Ocana, M., Kinoshita, J., Ruttenberg, A. & Clark, T. (2008), "The SWAN biomedical discourse ontology," *Journal of Biomedical Informatics* 41(5): 739–751 — [PubMed](https://pubmed.ncbi.nlm.nih.gov/18583197/).
- W3C Interest Group Note, 20 Oct 2009, ed. Ciccarese — [W3C](https://www.w3.org/TR/hcls-swan/).
- **Aim.** A "community-curated, distributed knowledge base of Theory, Evidence, and Discussion" designed "to represent and foreground both harmonizing and contradictory assertions within the total community discourse." — (search summary of [hcklab SWAN page](https://www.hcklab.org/swan-project.html) / W3C)
- **Deployment.** AlzSWAN, with the Alzforum community: "curators typically read carefully a scientific article, usually representing a hypothesis on AD, and produce a linear representation of the embedded scientific discourse: claims, hypotheses and questions." — (search summary)
- **Classes and relations.** The W3C note defines ResearchStatement, Hypothesis, Claim, ResearchQuestion and Comment. Its relations include supportive vs. refuting evidence citation, agreement/disagreement, *alternativeTo*, *motivatedBy*, *inResponseTo* and *relevantTo*, plus authoring and versioning metadata (later factored out as the PAV ontology). — [W3C](https://www.w3.org/TR/hcls-swan/) (fetched through a summarizer; the exact property spellings are not confirmed character-for-character)
- **Limits, as the micropublications paper saw them.** SWAN "models a principal statement, or 'hypothesis', with supporting statements, or 'claims', from the same publication only," cites whole publications as backing ("leaving the reader to determine precisely where in the cited document a backing statement actually resides"), and cannot "build claim networks of arbitrary depth." — [Clark, Ciccarese & Goble 2014 preprint](https://arxiv.org/abs/1305.3506)

#### B4. Micropublications (Clark, Ciccarese & Goble 2014)

- Clark, T., Ciccarese, P. N. & Goble, C. A. (2014), "Micropublications: a semantic model for claims, evidence, arguments and annotations in biomedical communications," *Journal of Biomedical Semantics* 5: 28 — [Crossref DOI 10.1186/2041-1480-5-28](https://doi.org/10.1186/2041-1480-5-28); [arXiv 1305.3506](https://arxiv.org/abs/1305.3506).
- **Minimal to maximal.** "The minimal form of a micropublication is a statement with its attribution. The maximal form is a statement with its complete supporting argument, consisting of all relevant evidence, interpretations, discussion and challenges brought forward in support of or opposition to it."
- **Claim lineages.** "Claim Lineages are chains of citing/cited Claims." Claim network analysis serves "to determine the origin of, and compare evidence for, individual and contrasting claims."
- **Similarity groups: structural synonymy for claims.** "Using Similarity groups, a set of Claims may be defined as having 'sufficient' closeness in meaning to a representative exemplar, or **holotype** Claim … to allow normalization of diverse sets of statements with essentially the same meaning … without combinatorial explosion." Members are "equivalents"; the model "allows similar Claims to be normalized to a common natural language representation, without dropping necessary qualifiers and hedging." Holotypes are chosen from the backing statement, set as an "annotator's version," or found by text-similarity search "in separate claim lineages."
- **Rival interpretations.** "Scientific discourse often involves disagreement on the correct interpretation or theoretical model for existing evidence … Support/attack relationships exist in the literature for alternative interpretations, hypotheses and models." These are modelled as "bipolar claim-evidence networks."
- **Lineage.** It grew out of SWAN via the Domeo annotation toolkit and the Annotation Ontology.
- — [arXiv preprint](https://arxiv.org/abs/1305.3506)

#### B5. Nanopublications

- **Structure.** "A nanopublication consists of an assertion, the provenance of the assertion … and the provenance of the whole nanopublication (called 'publication info')," tied together by a head graph. — [Nanopublication Guidelines (working draft)](https://nanopub.net/guidelines/working_draft/)
- **Versioning.** "New versions of a nanopublication can be declared with the npx:supersedes property"; once published "a nanopublication cannot be deleted or 'unpublished,' but only marked retracted or superseded." Trusty URIs make them immutable and verifiable. Sources: Kuhn, T. et al. (2016), "Decentralized provenance-aware publishing with nanopublications," *PeerJ CS* 2:e78; Kuhn et al. (2021), "Semantic micro-contributions with decentralized nanopublication services," *PeerJ CS* 7:e387 — [PeerJ cs-78](https://peerj.com/articles/cs-78/); [PMC7959648](https://pmc.ncbi.nlm.nih.gov/articles/PMC7959648/) (search summary; PeerJ returned 403).
- **Field study.** Bucur, C.-I., Kuhn, T., Ceolin, D. & van Ossenbruggen, J., "Nanopublication-based semantic publishing and reviewing: a field study with formalization papers." "Formalization papers" "contribute a novel formalization of a previously published claim." Submissions, reviews, responses and decisions were all nanopublications. 15 submissions from 18 authors completed the cycle; authors reported "high levels of interest and confidence" and found it "not very difficult." — [arXiv 2203.01608](https://arxiv.org/abs/2203.01608) (published in *PeerJ CS* 2023; journal details unverified)
- **Critique.** "Nanopublications models only the indicated statement." — [Clark et al. 2014](https://arxiv.org/abs/1305.3506)

#### B6. Open Research Knowledge Graph (ORKG) and its comparisons

- **The system.** Jaradeh, M. Y., Oelen, A., Farfar, K. E., Prinz, M., D'Souza, J., Kismihók, G., Stocker, M. & Auer, S. (2019), "Open Research Knowledge Graph: Next Generation Infrastructure for Semantic Scholarly Knowledge," *K-CAP 2019* — [ACM DOI 10.1145/3360901.3364435](https://dl.acm.org/doi/10.1145/3360901.3364435); [arXiv](https://arxiv.org/abs/1901.10816). First user evaluation, with conference participants: "users were intrigued by the novelty." — abstract via [Semantic Scholar](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145/3360901.3364435)
- **Comparisons.** Oelen, A., Jaradeh, M. Y., Stocker, M. & Auer, S. (2020), "Generate FAIR Literature Surveys with Scholarly Knowledge Graphs," *JCDL 2020* — [arXiv 2006.01747](https://arxiv.org/abs/2006.01747).
  - The method has four steps: "(a) finding similar contributions, (b) aligning contribution descriptions, (c) visualizing and finally (d) publishing the comparison."
  - Comparisons are of **research contributions** ("the addressed problem, utilized materials, employed methods and yielded results"), not whole papers, and are published FAIR with DOIs.
  - Evaluation used "data extracted from published review articles."
  - Earlier: Oelen et al., "Comparing Research Contributions in a Scholarly Knowledge Graph" (SciKnow 2019) — [Semantic Scholar](https://www.semanticscholar.org/paper/Comparing-Research-Contributions-in-a-Scholarly-Oelen-Jaradeh/5a89b67bdd84ba533b354bd838563a30bb429446).
- **SmartReviews.** These bundle prose, comparisons and data-driven figures into "living" review articles. On publishing, the state is frozen; "new versions … are linked in provenance chains." — [arXiv 2111.15342](https://arxiv.org/abs/2111.15342) (search summary)
- **Quality.** D'Souza, J., Hussein, H., Evans, J., Vogt, L., Karras, O., Ilangovan, V., Lorenz, A.-L. & Auer, S. (2024), "Quality Assessment of Research Comparisons in the Open Research Knowledge Graph: A Case Study," *JLIS.it* 15(1).
  - ORKG "has attracted a community of more than 1,000 users," but "the curated data has not been subject to an in-depth quality assessment so far."
  - Experts assessed **six** comparisons on three criteria: semantic modelling; maturity (completeness, syntactic representation, identifier stability, linkability); and usefulness to expert and lay users.
  - — [JLIS.it](https://www.jlis.it/index.php/jlis/article/view/547)
- **Live counts, 2026-09-22.** 68,469 papers; 101,895 contributions; **4,241 comparisons**, with 2,423 published comparison versions; 247 SmartReviews, with 212 published versions; 726 research fields; 45 observatories; 5,822 contributors; 85,279 "Rosetta Stone statements." — [ORKG statistics API](https://orkg.org/api/statistics/content-types/comparison-count) (and sibling endpoints under `/api/statistics/`)

#### B7. Why the discourse-graph systems faded

- Chan, J., Akamatsu, M., Vargas, D., Kawerau, L. & Gartner, M. (2024), "Steps Towards an Infrastructure for Scholarly Synthesis," arXiv 2407.20666 (cs.HC; the venue is not stated in the preprint).
  - They group micropublications, SEPIO and nanopublications as "discourse graphs."
  - On earlier deployments: "the ScholOnto model was supporting remote PhD mentoring and distributed collaborations; SWAN was integrated into the successful Alzforum online research community …; and the micropublication model was integrated into the Domeo scientist network. However, for a variety of reasons, these nascent infrastructures are no longer active, and the impact of these deployments has not been empirically evaluated … there is some consensus that these problems center on the 'human' side of the infrastructure such as tools and incentives for authors."
  - Their own 3-year field deployment (a Roam Research discourse-graph extension) is built on **incremental formalization** (Shipman & Marshall 1999, "Formality Considered Harmful"): "users enter information in a mostly informal fashion, and then formalize only later."
  - — [arXiv 2407.20666](https://arxiv.org/abs/2407.20666)

#### B8. Discovery rather than authoring: CiteSpace and network-module "paradigms"

- **Turning points.** Chen, C. (2004), "Searching for intellectual turning points: Progressive knowledge domain visualization," *PNAS* 101 (Suppl. 1): 5303–5310.
  - The method "derives a sequence of cocitation networks from a series of equal-length time interval slices," merges them, and looks for "intellectually significant articles … based on their visually salient features."
  - It was applied to "the superstring field in theoretical physics, focusing on the search of articles that triggered two superstring revolutions."
  - — [PubMed](https://pubmed.ncbi.nlm.nih.gov/14724295/); [PNAS](https://www.pnas.org/doi/abs/10.1073/pnas.0307513100) (search summary)
- **CiteSpace II.** Chen, C. (2006), "CiteSpace II: Detecting and visualizing emerging trends and transient patterns in scientific literature," *JASIST* 57(3): 359–377 — [Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1002/asi.20317); metadata via [Semantic Scholar](https://api.semanticscholar.org/graph/v1/paper/DOI:10.1002/asi.20317).
- **Structural holes.** Chen, C., Chen, Y., Horowitz, M., Hou, H., Liu, Z. & Pellegrino, D. (2009), "Towards an explanatory and computational theory of scientific discovery," *Journal of Informetrics* 3: 191–209: "connecting otherwise disparate patches of knowledge is a valuable mechanism of creative thinking in general and transformative scientific discovery in particular." — [arXiv 0904.1439](https://arxiv.org/abs/0904.1439)
- **Signals CiteSpace uses** (search summaries, not verified against Chen's text): "Transformative links are novel connections between distinct clusters, whereas incremental links are within-cluster connections." High betweenness centrality marks potential transformative work, "especially when it is observed with" a citation burst. Kuhn's stages (normal science, crisis, paradigm shift) informed the design. — [Chen 2011 JASIST preprint, "Predictive Effects of Structural Variation on Citation Counts"](http://cluster.ischool.drexel.edu/~cchen/papers/2011/chen2011jasist_preprint.pdf) (search summary)
- **Paradigms as network modules.** Ju, H., Zhou, D., Blevins, A. S., Lydon-Staley, D. M., Kaplan, J., Tuma, J. R. & Bassett, D. S. (2020), "The network structure of scientific revolutions," preprint (arXiv 2010.08381; OSF DOI 10.31235/osf.io/tga9c).
  - They "formulate knowledge as growing networks of [Wikipedia] articles and their hyperlinked inter-relations" and "operationalize paradigms as network modules to reveal a temporal signature in structural stability."
  - Concept networks "grow not by expanding from their core but rather by creating and filling knowledge gaps."
  - — [arXiv](https://arxiv.org/abs/2010.08381)
- Benn et al. (B2) explicitly frame their work as bridging "Bibliometrics" tools (CiteSeer, CiteSpace) and ontology-based "Knowledge Management" tools. Mancini & Buckingham Shum note that co-citation links "have no semantics." — [KMI-08-02](https://kmi.open.ac.uk/publications/pdf/kmi-08-02.pdf); [KMI-06-14](https://kmi.open.ac.uk/publications/pdf/kmi-06-14.pdf)

#### B9. Systems that label content by theory or school

- **ConTraSt.** Yaron, I., Melloni, L., Pitts, M. & Mudrik, L. (2022), "The ConTraSt database for analysing and comparing empirical studies of consciousness theories," *Nature Human Behaviour* 6 (April 2022) — [Nature](https://www.nature.com/articles/s41562-021-01284-5).
  - It classifies **412 experiments** by which of **four leading theories** of consciousness they bear on.
  - It found that support for a specific theory "can be predicted solely from methodological choices, irrespective of findings," and that "most studies interpret their findings post hoc." — (search summary; pages unverified)
  - This is the clearest built instance of *passages or claims tagged by rival school*. The schools are a fixed list.
- **InPhO.** The Indiana Philosophy Ontology.
  - Niepert, M., Buckner, C., Murdock, J. & Allen, C. (2009), "InPhO: A System for Collaboratively Populating and Extending a Dynamic Ontology," *TCDL Bulletin* 5(1) — [JCDL Bulletin](https://bulletin.jcdl.org/Bulletin/v5n1/Niepert/niepert.html).
  - Buckner, C., Niepert, M. & Allen, C. (2011), "From encyclopedia to ontology: toward dynamic representation of the discipline of philosophy," *Synthese* 182: 205–233 — [Springer](https://link.springer.com/article/10.1007/s11229-009-9659-9).
  - It is a "dynamic computational ontology for the discipline of philosophy" serving the SEP: persons, documents, organizations, and "most importantly, philosophical ideas" in a taxonomy, with thinker-influence relations.
  - Experts score "the relatedness of two ideas … or the influence one philosopher has on another on a five point scale." Answer-set programming builds the taxonomy and "takes into account the user's levels of expertise … when resolving feedback inconsistencies." — [JCDL Bulletin](https://bulletin.jcdl.org/Bulletin/v5n1/Niepert/niepert.html)

### Inferences

**No system found makes "school / paradigm / embedding" a first-class, user-authored, forkable container over claims, relations and passages.** The pieces exist separately:
- claims and typed relations: ClaiMaker, SWAN, micropublications;
- versioned immutable units with supersession: nanopublications, ORKG published versions;
- contribution-level selection into a named, citable set: ORKG comparisons;
- similarity classes as structural synonymy: micropublication holotypes;
- clusters of viewpoints derived from relations: Benn's ViewpointCluster.

The user's embedding would combine an ORKG-comparison-like container, holding parts of documents (feature 1), with ClaiMaker-style typed relations *assigned to the container* (feature 2), nanopub-style immutable version pins (feature 4) and fork lineage (feature 3). Fork lineage is the one piece no discourse system here offers.

**ORKG comparisons are the closest built analogue of a single embedding snapshot.**
- A comparison is a curated, named, DOI-bearing selection of *contributions* (parts of papers) plus a chosen set of aligned properties.
- Published versions are frozen and chained.

**What they lack against the embedding design:**
- relations *between* contributions scoped to the comparison;
- forking;
- per-member revision pins with re-affirmation, since the frozen unit is the whole comparison.

The low ratio (about 4,200 comparisons to about 68,000 papers) and the six-comparison quality study suggest that curation at this grain is expensive even with institutional backing.

**Two kinds of relation that an embedding needs to keep separate:**
- Micropublication **holotypes** are a built precedent for "names are not synonyms; synonyms must be structural." Equivalence is asserted between *claims in different lineages* by curators, not inferred from shared words.
- ClaiMaker's split between community-specific "dialect" labels and shared base relation classes is a precedent for letting each embedding name its relations in its own vocabulary while still being comparable across embeddings.

**The Benn projection rule is a ready-made algorithm for "pull together."** It works as follows:
- Map supports / common-support / common-dispute / undercut to agreement.
- Cluster.
- Mark clusters as opposing when at least half their members dispute each other.

A system could use it to *suggest* candidate embeddings, or to show that three scattered divergent passages cohere, without making the clusters authoritative. The authors themselves treat the output as a prompt for the analyst, not a result.

**What the discovery tools can and cannot do.** CiteSpace and Ju et al. show that paradigm-like modules and turning points can be *detected* from link structure alone. But they have no semantics. A co-citation cluster is not a school until someone names what it holds in common. This is the division of labour Benn et al. proposed: bibliometric detection, then ontological interpretation.

**The adoption record argues for incremental formalization.** Chan et al. report the "human side" (tools, incentives) as the bottleneck, and ClaiMaker's move from forms to ClaiMapper's drawing canvas points the same way. So the design should let a person place a passage in an embedding cheaply first, and add typed relations and re-affirmations later. The formal structure should not be required up front.

**InPhO is the counter-model.** It reconciles expert disagreement into *one* taxonomy, weighted by expertise. That is exactly what an embedding design refuses. It shows the cost Kuhn's no-overlap argument predicts: a single merged taxonomy must drop one side's distinctions.

### Gaps
- Uren et al. 2006 (the ClaiMaker/ClaiMapper user evaluation): the full text was inaccessible (403), so its specific findings are not in these notes. Likewise the 2007 *IJIS* paper.
- SWAN's exact property names and its versioning model were seen only through a summarizing fetch. Alzforum usage figures, such as how many hypotheses and claims were curated, were not found.
- Nanopublication supersede/retract semantics come from a search summary of PeerJ CS papers; PeerJ returned 403. Bucur et al.'s journal details are unverified.
- ORKG: no study was found of *how* comparisons are used (reads, citations of comparison DOIs, forks or derivations of comparisons). The live counts are a snapshot taken on 2026-09-22.
- CiteSpace II's own abstract and Chen's explicit statements linking CiteSpace to Kuhn were not read in the original; PNAS and Wiley returned 403.
- ConTraSt page numbers and its data model (how an experiment is linked to a theory, and whether "challenges" is recorded) are unverified.
- The COMMA 2008 version of Benn et al. was not opened. Whether "school of thought" modelling was ever completed in Benn's PhD is unknown.

---

## Key question C: Kuhnian paradigms or MacIntyrean traditions as data structures in a knowledge base

### Takeaway
There are only three direct precedents, and none is a maintained knowledge base with authored, evolving schools:
- **Structuralism's formal definition of a Kuhnian paradigm** as paradigmatic applications plus paradigm-guided theory-evolution (Balzer, Moulines & Sneed 1987), with Sneed's 1989 PROLOG theory-nets for Lakatosian programmes. This is set-theoretic, and computational once.
- **Benn et al.'s `ViewpointCluster` class** (2008), derived by clustering.
- **Ju et al.'s "paradigms as network modules"** over Wikipedia (2020), which is discovery only.

I found no formal or computational representation of a MacIntyrean tradition.

### Cited Findings
- **Structuralist paradigms.** "Balzer et al. (1987) used the notion of paradigmatic applications to define Kuhnian paradigms and paradigm-guided theory-evolutions. This required the introduction of diachronic theory-nets and the diachronic specialization relation." — [Damböck PDF](https://homepage.univie.ac.at/christian.damboeck/texte/kuhn_stegmueller.pdf) (search summary)
- **Kuhn on the structuralist version.** He judged it "best fits" a historical, developmental view because it can represent "revision of terminology and introduction of new terminology as part of the introduction of a new theory" (Kuhn 2000, pp. 318–319). — [Lorenzano 2013](https://ri.conicet.gov.ar/bitstream/handle/11336/88249/CONICET_Digital_Nro.b0fd1bdd-1178-4d99-9670-e8910b55f747_A.pdf?sequence=2&isAllowed=y)
- **Sneed 1989.** It stores theory-nets in PROLOG to model "scientific problem solving activities within research programs associated with scientific communities." — [SpringerLink](https://link.springer.com/chapter/10.1007/978-94-009-3025-4_19) (search summary)
- **ViewpointCluster.** "Each of the clusters detected in the network is captured as a ViewpointCluster instance," with associated persons and opposing clusters computed from it. — [KMI-08-02](https://kmi.open.ac.uk/publications/pdf/kmi-08-02.pdf)
- **Ju et al.** "We operationalize paradigms as network modules." — [arXiv 2010.08381](https://arxiv.org/abs/2010.08381)
- **Nothing on MacIntyre.** A targeted search for a computational model, formalization or ontology of MacIntyre's rival traditions returned only philosophical commentary. The closest bridge is the conceptual comparison with Laudan. — [academia.edu comparison paper](https://www.academia.edu/6712444/MacIntyres_Tradition_Costituted_Enquiries_and_Laudans_Research_Traditions) (search summary)
- A generic search ("Kuhnian paradigm" ontology / OWL / knowledge graph / schools of thought) returned nothing relevant (my own search; no citable source).

### Inferences
- **A structuralist reading of the embedding design:**
  - An embedding's seed members correspond to **paradigmatic applications**.
  - The later members it accretes correspond to the rest of the intended applications.
  - Its fork graph corresponds to diachronic specialization.

  That gives a principled test for "is this still the same school?": the evolution conditions, where every new element specializes an old one and the domains of application overlap. The first condition could be relaxed, per Laudan, where a core commitment changes without a change of identity.
- **MacIntyre's epistemological crisis supplies a feature none of the systems has.** A tradition's rationality shows in its ability to write a narrative of its own crisis and of how the rival's problems are solved in its own terms. The analogue is a *narrative document attached to a fork or merge event*: the account of why the embedding peeled away or pulled together. Structurally this is an ordinary document related to the fork, so it fits features (1) and (2) with no new machinery. This is an inference; no source proposes it.
- **Detection and authoring have never been joined.** The only machine-derived "school" objects (ViewpointCluster, network modules, co-citation clusters) are snapshots with no identity across time. The only formal diachronic identity for a school (the structuralist theory-evolution) has no running system. Keeping user-authored identity and version pins, and using clustering only as suggestions, would join the two. No precedent was found for doing both.

### Gaps
- BMS 1987's actual formal definition of "paradigm" and of paradigm-guided theory-evolution was not read in the original.
- The Sneed 1989 PROLOG implementation's contents are unknown; I found no later reuse or open code.
- I found no knowledge base, ontology or data model of MacIntyrean traditions, and no ontology class for "Kuhnian paradigm" in scholarly-communication ontologies (SWAN, micropublications, ORKG, nanopub templates), beyond Benn's ViewpointCluster. This is a negative result from limited searching, not proof of absence.
