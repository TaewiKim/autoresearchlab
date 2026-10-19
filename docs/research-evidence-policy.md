# Research evidence and model usage

Research model API calls are restricted to exactly `gpt-5.6-luna` through
`drivers/analysis/research_llm.py`. Other models/providers, endpoint overrides,
redirects and automatic model fallback are rejected. Research subprocesses remove
generic provider credentials; the helper receives only the scoped OpenAI key.
Codex CLI uses ChatGPT authentication and retains task-based Luna/Terra/Sol/Astra
routing. These controls affect ResearchLab subprocesses, not other applications
or account-wide permissions. They are not a network sandbox against arbitrary
code deliberately retrieving credentials elsewhere.

The model router records its selected model, reasoning effort, selection reason
and permitted fallbacks in each role plan. Routine extraction/digests start with
Luna, structured work uses Terra, deeper analysis uses Sol, and comparative
hypothesis synthesis or decisive adjudication can use Astra. This is a routing
policy, not a measured claim of optimal token cost or scientific quality.
The model families are documented in the official
[OpenAI model catalog](https://developers.openai.com/api/docs/models/all).
Explicit model pins have no automatic fallback. An explicit task-complexity
assessment overrides incidental words in the evidence payload. Context limits,
timeouts and invalid schema configuration do not automatically upgrade models;
context is compacted or the runtime error is repaired first. Repeated malformed
model responses can trigger a bounded tier upgrade. Deterministic drivers do not
consume a model route.

Follow-ups retain the decision digest and named source references rather than
repeating complete graphs and earlier outputs. Abstract reviews are reused only
when the objective and original abstract are unchanged; quality eligibility is
reevaluated. Actual token savings and hypothesis merit require a subsequent
research evaluation and are not inferred from these controls.

Literature retrieval is a candidate collection step. It does not establish that
a paper is evidence. Before inclusion, Scout reads the full abstract and records
the research task, method and outcome links to the objective, exact supporting
passages, limitations, reviewer identity and review date. Reviews bind to the
objective and abstract hashes. Missing abstracts, uncertain relevance and missing
reviews remain outside the evidence corpus.

After direct relevance is established, a paper must qualify for at least one
of these distinct tracks:

- Recent frontier: publication within three years. Low citation counts are
  expected for new work; recency alone does not demonstrate impact or validity.
- Established impact: at least 100 sourced citations, a sourced field-normalized
  citation percentile of 90 or higher, or a verified Q1 venue metric with its
  source, venue and metric year. A journal name alone is insufficient.

The thresholds are selection policy, not measured guarantees of scientific
quality. Unknown citation counts or venue metrics remain unknown. Preprints
remain labeled as preprints. Review methodology and study limitations still
matter after a paper passes screening.

The search driver writes the candidate queue and review contract. Scout creates
the review JSON and finalizes the same retrieval directory without re-searching:

```text
python drivers/literature/search.py --finalize-review-dir <lane-directory> --reviews-file <review-file>
```

Only accepted papers enter synthesis, graphs and hypothesis evidence. Pending,
excluded and quarantined candidates stay in separate audit artifacts. There is
no minimum-count padding or fallback to the raw corpus. Cached judgments must
match the current objective, abstract and policy. Insufficient coverage remains
`insufficient_corpus`; it cannot support a confident claim that prior art is absent.

The harness assigns each literature Scout a durable `search_agent_contract`
containing the current research problem, named hypotheses and relevant field
facets. The Scout authors each inquiry after reading earlier results and keeps a
`search-agent-journal.json` with questions, query revisions, source provenance,
full-abstract decisions, and links from accepted papers to hypotheses. Closest
prior art, genuine backward/forward citation inquiries and adversarial searches
are required. A citation edge or a cross-field connection is not evidence of
relevance; an applicable method transfer must change the proposed procedure,
analysis, experiment or measurement.

Each inquiry is persisted as it runs:

```text
python drivers/literature/search.py --query "<agent-authored inquiry>" --output-dir <lane> --role-plan-file <plan>
python drivers/literature/search.py --import-candidates-file <primary-source-batch.json> --output-dir <lane> --role-plan-file <plan>
```

The optional import batch has `query`, `sources`, and `papers` fields. It admits
no evidence by itself. Both paths merge candidates, preserve previous reviews,
and append retrieval receipts. A changed objective requires a new lane. Abstract
review binds to the objective, original abstract and policy, so adding a search
provider or passing a day does not spend tokens rereading unchanged material;
quality metadata and recency are still reevaluated.

Each retrieval receipt distinguishes new candidate IDs, changed abstracts and
newly accepted evidence. Duplicate results do not count as new progress. The
agent uses these observations and remaining decision gaps to choose its next
query, citation branch or source. A `running`, `pending_review` or budget-ended
journal cannot become decision-ready merely by filling the evidence checklist:
completion also requires the agent's explicit, reasoned search termination.

Finalization validates the journal through the same JavaScript contract used by
Chronicle and Gate. Screened papers remain available while missing inquiry
types, facets, unreviewed claim citations or unanswered decision questions block
search completion. A gap-specific Codex Scout followup resumes the saved source
lane instead of repeating the entire corpus search. Hypotheses and experimental
results are produced by the harness agents; maintenance of the harness does not
require manually selecting research findings or injecting a lead hypothesis.

For a run authorized to send only public scholarly queries and paper IDs, set
`RESEARCHLAB_LITERATURE_NETWORK_POLICY=approved-scholarly-metadata-v1` together
with `RESEARCHLAB_CODEX_NETWORK_DOMAINS` containing only approved hosts from
`api.openalex.org,api.crossref.org,api.semanticscholar.org,api.opencitations.net,export.arxiv.org,arxiv.org,ar5iv.labs.arxiv.org,api.github.com,huggingface.co`
(the same list as `SCHOLARLY_NETWORK_DOMAINS` in `native/researchlab-harness/src/runtime/codex_policy.rs`;
`tests/literature_scholarly_allowlist_test.py` keeps them in step).
The Codex launch uses a named permission profile extending workspace protection
and an enabled network proxy with exact domain rules. It does not grant general
outbound access. Keep `RESEARCHLAB_CODEX_APPROVAL_POLICY=on-request`.

Lanes that provision environments (role `engineer`, or the actions
`capability_provisioning_followup` and `simulation_data_generation_followup`)
may instead run under `researchlab_open_source_assets`: the scholarly hosts
plus the package registries, code hosts and model stores in
`OPEN_SOURCE_ASSET_DOMAINS` (same file). Set `RESEARCHLAB_OPEN_SOURCE_ASSETS=1`
to admit all of them, or `RESEARCHLAB_CODEX_ASSET_NETWORK_DOMAINS` to name a
subset (each host must be an approved scholarly or asset host). The profile's
mode is `full`, because git over HTTPS needs POST;
`RESEARCHLAB_CODEX_ASSET_NETWORK_MODE=limited` restricts it to GET/HEAD/OPTIONS.
Without either setting engineers keep the scholarly profile. Scouts, analysts,
lab-runners, gatekeepers and directors always do. `invocation.json` and
`process.json` record `permission_profile`, `network_mode` and
`network_domains` for every lane.

The literature HTTP path permits GET metadata requests and validated redirects,
rejects custom headers and unapproved endpoints/options, strips contact email
parameters, and upgrades the legacy arXiv export URL to HTTPS. Public search
terms and paper IDs are the only user-derived request content allowed; local
source files, documents, credentials and artifacts must stay out of requests.
The built-in multi-source search uses OpenAlex, Crossref, arXiv and Semantic
Scholar (keyword search, title match, record and citation-graph lookups; the
optional `RESEARCHLAB_S2_API_KEY` is the single header this policy allows, and
only to api.semanticscholar.org: a credential for an approved service carries
nothing of this machine's, while the anonymous pool's 429s were this cycle's
most common literature failure). `search.py --title "<title>"` (also `--arxiv-id`, `--doi`)
resolves a known paper through all four into the same abstract-review queue as
a keyword probe; screening and quality tracks are unchanged. Under this
policy, dataset-discovery Scouts use scholarly evaluation/feasibility evidence
and the local snapshot instead of contacting other dataset registries or
downloading data. Failed provider calls are retried after repair and never
cached as proof of an empty literature corpus.

Deep reading (`search.py --fulltext <arXiv id>`) fetches a paper's full text
by arXiv ID only -- `arxiv.org/html/<id>`, then `ar5iv.labs.arxiv.org/html/<id>`,
then `arxiv.org/pdf/<id>` -- and caches it under
`.research-lab/literature/fulltext/<id>/` with the source URL and the SHA-256 of
the extracted text. Asset resolution (`search.py --resolve-assets <arXiv id>`)
reads repository metadata from `api.github.com` (repository record, README,
top-level listing, default-branch head, and a repository search by title or
arXiv ID) and model/dataset records from `huggingface.co/api`. It never clones,
downloads a file or runs code. An optional `RESEARCHLAB_GITHUB_TOKEN` is sent
only outside this policy, like `RESEARCHLAB_S2_API_KEY`; under it GitHub's
anonymous budget (60 requests/hour) applies and a refused lookup is recorded as
such, never as "no code exists".

Native data follow-ups are also converted to Codex literature agents under
this policy; stale external dataset-driver contracts fail before execution.
The legacy Node/curl metadata verifier is blocked even when explicitly enabled
in an old launcher, because its redirects are not checked by the approved
transport. Existing sourced metadata stays intact, and additional verification
is recorded as pending. CLI startup errors keep their runtime failure cause
instead of being reported as a lack of relevant literature.

On restart, same-objective adaptive Scout plans with saved candidates or a
search journal retain their agent-authored inquiries and hypotheses. An
incremental `result.json` never releases a worker slot: explicit terminal
`final-status.json` is required, and a live launcher reserves its slot even
before the child writes `run-state.json`. This keeps a configured concurrency
of one effective while abstract review is in progress.

Windows sandbox setup failures stop the entire cycle. A canceled or incomplete
setup helper (including `orchestrator_helper_incomplete` and Windows error 1223)
is an environment failure, not a retryable search failure. The native process
watchdog stops its own child tree, saves a shared pause marker and the
`RUNTIME_SETUP_BLOCKED` termination code, and prevents compact-context retries,
Chronicle continuations and later lane dispatch. JavaScript recovery preserves
the failed lane's artifacts and honors the same marker. An explicit resume is
required after the environment conflict has been resolved.

Scoped Windows launches also inspect the existing sandbox setup marker before
starting a child. The scholarly profile explicitly uses loopback proxy ports
3128 and 8081 with local binding disabled. Missing, unreadable or incompatible
setup state, or unavailable proxy ports, blocks launch rather than invoking
setup as a diagnostic or allowing a known port fallback. The check does not
edit global configuration, sandbox accounts, firewall rules or setup markers.
It cannot guarantee that another application or a CLI file helper will not
change shared sandbox state after launch; a passing check is not an end-to-end
validation. Runtime validation must not automatically relaunch a cycle that
was stopped because of repeated setup approval prompts.

`RESEARCHLAB_RESEARCH_SCOPE=planning-only` additionally omits initial LabRunners
and rejects their scheduled and direct execution. It keeps Codex Analyst lanes
available to prepare a later experiment plan.
