# Scout Literature Search Guidelines

> Renamed from `scout_pubmed_guidelines.md`. The eight rules below are
> source-agnostic; only the worked example is drawn from one database, and a
> filename naming one source is the same mistake the rules exist to prevent.

Guidance for constructing literature-search queries (PubMed, OpenAlex, Crossref) that actually retrieve the papers we want, rather than keyword collisions that drift into an adjacent sub-field. These rules are enforced both by the Python driver (`drivers/literature/search.py::build_literature_query`) and by the JS seed-query builder (`src/agents/shared/frontier_discovery.js`), and are documented here for future Codex-driven scout lanes that assemble their own queries.

All three sources share the same token-collision problem that motivated this doc; the driver now applies source-specific query rewriting:

| Source | `build_literature_query` behavior |
|---|---|
| `pubmed` | Full boolean + parenthesised OR-expansion (e.g. `("The Cancer Genome Atlas" OR TCGA)`), supports `[pm:raw]` bypass and PubMed field tags |
| `openalex` | Single quoted full-name expansion (e.g. `"The Cancer Genome Atlas"`), phrase quoting, `[oa:raw]` bypass |
| `crossref` | Same as OpenAlex — quoted full names + phrase anchors, `[cr:raw]` bypass |
| any | `[raw]` prefix bypasses all rewriting |

---

## Why this exists

PubMed's ESearch treats its `term` argument as a keyword-matched expression. Bare tokens are matched against every field (title, abstract, author, MeSH, affiliation), which makes short ambiguous tokens silently drift into adjacent sub-fields:

- `geo` → **geographic** papers, not Gene Expression Omnibus
- `equity` → public-health equity, even when the prompt is about genetic variance
- `systematic review global estimates` → WHO-style coverage papers, regardless of the seed topic

The earlier revision of the literature driver paired abbreviated repository tokens with WHO/public-health modifiers (`equity gradient`, `health system capacity`, `vaccination coverage mortality mechanism`) as universal expansion scenarios. That produced 30-paper pulls entirely about vaccine coverage even when the user prompt was `"Analyze open omics data..."`. This document describes the replacement conventions.

---

## Rule 1 — Expand repository abbreviations

Open-data repositories share names with common English words. Always expand bare abbreviations before hitting PubMed so the search matches papers that actually cite the repository:

| Abbrev | Expansion used by `build_pubmed_query()` |
|---|---|
| GEO | `("Gene Expression Omnibus" OR "GEO dataset" OR "GEO accession")` |
| TCGA | `("The Cancer Genome Atlas" OR TCGA)` |
| GTEx | `("Genotype-Tissue Expression" OR GTEx)` |
| ArrayExpress | `("ArrayExpress" OR "Expression Atlas")` |
| ENCODE | `("ENCODE Project" OR "Encyclopedia of DNA Elements" OR ENCODE)` |
| CPTAC | `("Clinical Proteomic Tumor Analysis Consortium" OR CPTAC)` |
| DepMap | `("Cancer Dependency Map" OR DepMap OR "Achilles project")` |
| CCLE | `("Cancer Cell Line Encyclopedia" OR CCLE)` |
| Recount | `("recount3" OR "Recount" OR "recount2")` |
| UK Biobank | `"UK Biobank"` |
| Human Cell Atlas | `"Human Cell Atlas"` |

Codex-driven scout lanes that assemble their own queries should follow the same pattern: when the prompt mentions a repository abbreviation, the query must include the phrase-form full name or both forms joined by `OR`.

## Rule 2 — Quote multi-word phrases

PubMed's default operator on space-separated tokens is `AND`, applied across all fields. `differential expression` becomes `differential[All] AND expression[All]`, which matches any paper that mentions both words. Wrapping multi-word phrases in quotes (`"differential expression"`) forces phrase matching inside a single field.

The Python driver auto-quotes these anchors (`PHRASE_ANCHORS` in `search.py`):

```
"differential expression"     "pathway enrichment"      "gene set enrichment"
"single-cell" / "single cell"  "survival analysis"      "mendelian randomization"
"diff-in-diff"                "event study"              "instrumental variable"
"synthetic control"           "mixed effects"            "meta-analysis"
"systematic review"           "cohort study"             "case-control"
```

If a Codex scout adds new methodology phrases, they should be added to this list (or quoted inline). Do not pass multi-word methodology terms as bare tokens.

## Rule 3 — Build queries as `{domain anchor} × {methodology anchor}`

Avoid pairing a repository abbreviation with a generic modifier like "systematic review" or "multi-country". Those pairings produce vocabulary collisions. Instead:

```
{repo}   × {outcome}       e.g., TCGA × "survival analysis"
{repo}   × {study_design}  e.g., "UK Biobank" × "mendelian randomization"
{library}× {outcome}       e.g., scanpy × "cell-state transition"
{design} × {outcome}       e.g., "event study" × "disease progression"
```

The JS builder (`frontierQueries` in `frontier_discovery.js`) generates 12 queries max from the cross-product of the anchors it extracts from the prompt. Anchors fall into four categories:

- **Repositories**: GEO, ArrayExpress, TCGA, GTEx, Recount, ENCODE, CPTAC, DepMap, CCLE, UK Biobank, Human Cell Atlas, 1000 Genomes, ImmPort
- **Libraries**: scanpy, anndata, pyDESeq2, DESeq2, limma, gseapy, lifelines, scikit-survival, statsmodels, linearmodels, econml, dowhy
- **Study designs**: within-subject change, event study, diff-in-diff, instrumental variable, mendelian randomization, synthetic control, paired pre/post, cohort, case-control
- **Outcomes**: differential expression, pathway activity, cell-state transition, survival, disease progression, treatment response, hazard, mortality, incidence, prevalence

## Rule 4 — Strip pipeline-internal jargon from queries

Terms like "rival explanation variable families", "causal structure competing exposures", "competing primary families", and "rival DAG identification strategy" are internal to ResearchLab's role-plan schema. They are not useful PubMed terms and dilute the signal. The driver's `build_pubmed_query()` helper regex-deletes them before ESearch; if a Codex scout constructs its own queries, it must not include them.

Also strip:
- `multi-country` (rarely matches omics papers; biases toward ecological studies)
- `n=..., p<...` style inline statistics
- The pipeline's own cycle/lane IDs

## Rule 5 — Use field tags when confidence is high

PubMed supports field-scoped tags like `[MeSH Terms]`, `[Title/Abstract]`, `[Author]`. When a query anchor is known to be a MeSH heading (e.g., "Gene Expression Profiling", "Neoplasms"), tag it:

```
"Gene Expression Profiling"[MeSH Terms] AND "survival analysis"[Title/Abstract]
```

Field tagging drops recall but raises precision. Use it when the seed anchor is precise (canonical MeSH term); skip it when the anchor is exploratory vocabulary.

Queries that should bypass all of the above (for advanced scout plans that want to hand-build a PubMed expression) can be prefixed with the literal `[pm:raw]` and `build_pubmed_query` will pass the remainder through unchanged.

## Rule 6 — Cap query length at 2,048 characters

PubMed silently truncates or rejects long query URLs. The driver caps each query at 2,048 characters. If the assembled query is longer, drop the least-specific anchor and re-emit.

## Rule 7 — Short seeds, then expand from hits

The JS builder emits **short** seed queries (one repo + one methodology anchor each). The Python driver runs those seeds, ranks terms in the returned papers, and expands the search with title-derived topics combined with a small set of **methodology** modifiers (`EXPANSION_SCENARIOS` in `search.py`):

```
mechanism            moderator analysis    heterogeneity        sensitivity analysis
causal identification benchmark comparison  reproducibility      confounding
```

These replaced the earlier WHO/public-health modifiers (`equity gradient`, `zero-dose`, `health system capacity`). They're intentionally domain-neutral so the expansion step does not bias the retrieval toward any single sub-field.

## Rule 8 — Respect `design_constraints.jsonl`

Before proposing new queries, consult `.research-lab/state/design_constraints.jsonl`. Each row encodes a lesson from a prior cycle's failure (e.g., "observational ecological panel retrieval exhausted; require a design_shift before retrying"). Do not re-submit a query pattern that an existing constraint has flagged as exhausted unless the prompt explicitly asks for continuity.

---

## Worked example — "Analyze open omics data..."

Raw user prompt anchor extraction:
```
repositories: [GEO, ArrayExpress, TCGA, GTEx, Recount, ENCODE, CPTAC, DepMap, CCLE]
libraries:    [scanpy, anndata, pyDESeq2, limma, gseapy, lifelines, scikit-survival, scanorama, scrublet]
designs:      [within-subject change, event study, diff-in-diff, instrumental variable, mendelian randomization, synthetic control]
outcomes:     [gene expression, pathway activity, cell-state transition, disease progression, survival, response rate]
```

JS builder emits (first 8 of 12):
```
1. GEO gene expression
2. GEO pathway activity
3. GEO cell-state transition
4. ArrayExpress gene expression
5. ArrayExpress pathway activity
6. TCGA gene expression
7. TCGA pathway activity
8. GEO within-subject change
```

Python driver rewrites each before ESearch, e.g. query #1:
```
raw:    GEO gene expression
output: ("Gene Expression Omnibus" OR "GEO dataset" OR "GEO accession") gene expression
```

Which returns 30 **omics** papers instead of 30 vaccine-coverage papers. That is the entire point of these guidelines.
