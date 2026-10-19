# Data Fetcher — 2026-04-28

## Why this is needed now

v22 (the first overnight cycle after the WHO-classifier strip) confirmed
that **promotion=0 is structural, not a domain-vocabulary issue**. The
chronicle / lab-director / analyst / lab-runner pipeline runs to
completion; chronicle correctly emits a domain-correct hypothesis
("higher urban green-space density predicts lower summer LST"); but
every hypothesis stalls at promotion-readiness ≤ 48 / 100 because:

- `support_basis` ends up `["literature"]` only (no `"data"` evidence)
- `evidence_counts.data == 0`
- promotion gate `mixedEvidence = data && literature` never trips

The root cause traced from v22's lab-runner-01 result.json:

```
dataset_root: .research-lab/datasets/who/csv      ← legacy WHO panel
row_count: 0, country_count: 0, blueprints_total: 0
hypothesis-results.json: []
overall_status: "no-blueprints"
```

The data-scout (`drivers/data/data_scout_browser.py`) discovers
candidate URLs via DataCite + DDG and verifies access, but **never
materializes any file on disk**. Lab-runner's
`engine.rs::choose_dataset_bundle_path` then falls back to the only
bundle present (`.research-lab/datasets/who/csv`). For an urban
green-space hypothesis, the WHO health panel matches zero variables,
so 0 rows survive filtering and 0 blueprints fire.

→ The cycle has working **discovery** and working **analysis**, but the
"materialize and stage" hop is missing.

## Current state

```
[chronicle/lab-director] ── emits dataset descriptions in data-graph
                              (LLM text, not files)
                                      │
                                      ▼
[data_scout_browser.py]   ── discovers DataCite + DDG candidates,
                              verifies access, appends nodes
                              ────────────────  ❌ stops here  ────────────────
                                      │
                              (no actual files reach disk)
                                      │
                                      ▼
[engine.rs::choose_dataset_bundle_path]
                              ── falls back to legacy WHO bundle
                                      │
                                      ▼
[lab-runner / python_stats.py]
                              ── analyzes WHO panel against
                                  domain-mismatched hypothesis
                                  → 0 rows, 0 blueprints, 0 evidence
```

## Goal

Close the gap between scout-discovered candidates and lab-runner's
input expectations. After this PR, an urban / climate / social science
prompt that lands on tabular DataCite-registered data should produce:

- one or more cycle-scoped bundles under
  `.research-lab/datasets/<cycle_id>/<dataset_slug>/{raw,csv,manifest.json}`
- lab-director's `role_plan.dataset_root` populated with one of those
  bundles (selected by hypothesis-variable matching)
- python_stats running blueprints against the fetched bundle and
  emitting non-empty `hypothesis-results.json`
- hypothesis-ledger entries with `support_basis: ["literature","data"]`
  and at least some hypotheses crossing the promotion gate

## Scope — Phase 1 (this revision)

**Tabular formats only.** Raster / GeoTIFF / NetCDF / HDF5 / vector
spatial data are explicitly out of scope; they require domain-specific
pipelines (rasterio, xarray, Earth Engine) that are not justifiable
in this PR. Raster handling is Phase 2.

Supported formats this PR:

- `.csv`, `.tsv` (direct)
- `.xlsx` (pandas + openpyxl)
- `.parquet` (pandas + pyarrow)
- `.json` (when payload is a 1-d list of records → pandas json_normalize)
- `.zip` (recurse — accept any of the above inside)

Anything else: record metadata only, mark `fetch_status:
"skipped_unsupported"`, do not block the cycle.

## Approach

### A. Provider adapter layer

A new module `drivers/data/dataset_fetcher.py` exposes one entry point:

```python
def fetch_dataset(candidate: dict, target_dir: Path) -> dict:
    """Pull files for a discovered dataset candidate into target_dir,
    returning a manifest entry. Returns None if format unsupported.
    Never raises — all failures degrade to manifest-level status fields.
    """
```

Internally dispatches by DOI prefix / publisher / host name to one of:

| adapter | DOI prefix / domain | API |
|---|---|---|
| `_fetch_zenodo` | `10.5281/zenodo.X` | `GET https://zenodo.org/api/records/<id>` → `files[].links.self` |
| `_fetch_figshare` | `10.6084/m9.figshare.X` | `GET https://api.figshare.com/v2/articles/<id>/files` → `download_url` |
| `_fetch_dataverse` | `10.7910/...`, `10.5072/...` | `GET <host>/api/datasets/:persistentId/?persistentId=<doi>` → `latestVersion.files[].dataFile.id` → `<host>/api/access/datafile/<id>` |
| `_fetch_mendeley` | `10.17632/X.Y` | landing page parse → file API |
| `_fetch_envidat` | `10.16904/envidat.X` | CKAN API at envidat.ch/api/3/action/package_show |
| `_fetch_osf` | `10.17605/osf.io/X` | `GET https://api.osf.io/v2/nodes/<id>/files/osfstorage/` |
| `_fetch_generic_doi` | otherwise | landing page Playwright → look for `<a href="*.csv|*.zip|*.xlsx">`, follow first match |

Each adapter:
1. parses provider-specific id from candidate.url / accession
2. requests the file list via API
3. filters to supported tabular extensions
4. downloads each file (HTTPS, configurable cap; defaults: ≤ 200 MB
   per file, ≤ 600 MB total per dataset, 5 min timeout)
5. saves to `<target_dir>/raw/<original_filename>`
6. returns a list of raw file paths + format hints

### B. Normalizer

`_normalize_to_tidy(raw_path: Path, target_csv_dir: Path) ->
list[dict]` returns one or more manifest-shaped entries (one per CSV
emitted):

- `.csv` / `.tsv`: read with pandas (auto-detect delimiter), write
  back to `target_csv_dir/<slug>.csv`
- `.xlsx`: each sheet → its own CSV, named `<filename>__<sheet>.csv`
- `.parquet`: read → CSV
- `.json`: try pandas `json_normalize`; if result is purely scalar /
  nested record-of-records, skip and mark `unsupported_json_shape`
- `.zip`: extract to temp, recurse on each contained file
- otherwise: skip with `unsupported_format`

Each emitted CSV produces a manifest entry of shape:

```json
{
  "name": "<derived_slug>",
  "kind": "indicator",
  "csv_path": "<absolute path>",
  "raw_path": "<source raw file>",
  "row_count": <int>,
  "columns": ["col1", "col2", ...],
  "format_hint": "csv|tsv|xlsx-sheet|parquet|json-normalize",
  "source_url": "<original download URL>",
  "fetch_status": "fetched"
}
```

The format intentionally **does not enforce a long-form schema**
(the WHO bundle's `Id,SpatialDim,TimeDim,Value` shape is one specific
schema). Lab-director / analyst handles arbitrary column layouts via
the existing handoff `column_mapping` mechanism.

### C. Bundle layout

For each fetched candidate:

```
.research-lab/datasets/<cycle_id>/<dataset_slug>/
  manifest.json   ← list of normalized CSVs (shape above) + dataset-level metadata
  csv/            ← normalized CSVs
  raw/            ← downloaded originals (preserved for traceability)
```

`<dataset_slug>` derived from the candidate's primary accession (DOI
or repository id), slugified.

### D. Scout integration

Extend `data_scout_browser.py::main()`:

After existing discover + verify + dedupe, before
`_append_dataset_nodes`:

1. For each `cand` with `access_status == "open"` AND DOI accession:
   - call `fetch_dataset(cand, .../<cycle_id>/<slug>/)`
   - on success: attach manifest entries + `bundle_path` to
     `cand.metadata`, fold into a per-cycle `bundle_index.json`
2. `_append_dataset_nodes` records `metadata.bundle_path`,
   `metadata.fetch_status`, `metadata.csv_files` on each graph node
3. Emit `<cycle_id>-data-bundles.json` listing all materialized
   bundles (so lab-director's planner sees them)

### E. Rust harness updates

- **`engine.rs::choose_dataset_bundle_path`** —
  cycle-scoped scan first: glob
  `.research-lab/datasets/<cycle_id>/*/manifest.json` and prefer those
  over the global `.research-lab/datasets/<bundle>` fallback. If no
  cycle-scoped bundle exists, keep current default behaviour but emit
  a `dataset_fallback_to_legacy` warning on the lane payload.
- **`labdirector/mod.rs::latest_dataset_selection`** — read
  `<cycle_id>-data-bundles.json` and surface every fetched bundle (not
  just one) into the role_plan's
  `planner_metadata.candidate_datasets`. The lab-director / analyst
  prompt picks among them; the chosen one's path becomes
  `role_plan.dataset_root`.
- **labdirector policy.rs** — task_markdown for analyst gets a
  `pick_dataset_for_hypothesis` directive: read
  `candidate_datasets[].columns`, match against `hypothesis.x_variable`
  / `hypothesis.y_variable`, declare the chosen `dataset_root` and
  `column_mapping` in the handoff.

## Implementation plan

Concrete tasks, in dependency order:

1. **`dataset_fetcher.py`** — provider adapter module + normalizer
   (~700 LOC, 6 adapters + tests).
2. **scout integration** — wire `fetch_dataset` after verify in
   `data_scout_browser.py`; emit per-cycle `data-bundles.json` (~150 LOC).
3. **Rust harness updates** — `choose_dataset_bundle_path` cycle-aware,
   `latest_dataset_selection` cycle-aware, policy.rs analyst directive
   (~120 LOC across 3 files).
4. **Smoke + unit tests**:
   - per-adapter mock test: feed a fake API response, assert correct
     download URL + manifest entry shape (Python `unittest`).
   - normalizer fixtures: minimal `.csv`, `.xlsx`, `.parquet`,
     `.json`, `.zip` → assert manifest entries (Python `unittest`).
   - integration smoke (no Codex): synthesize a candidate dict
     pointing to a small Zenodo CSV; run `fetch_dataset` end-to-end;
     assert bundle on disk + manifest correct.
5. **Live cycle smoke** (after #1-4 land): tabular-friendly prompt
   ("How does household electricity consumption relate to outdoor
   temperature across European cities?") to v23. Confirm:
   - at least 1 fetched bundle under
     `.research-lab/datasets/cycle-v23-.../`
   - lab-runner's `dataset_root` references that bundle
   - python_stats emits non-empty `hypothesis-results.json`
   - hypothesis-ledger has at least one entry with
     `support_basis = ["literature","data"]`

## Verification plan

### Unit

- **per-adapter** (mock `urllib.urlopen`):
  - Zenodo: parse record id from `10.5281/zenodo.123` → request URL
    correct → `files[]` list parsed → returns matching paths
  - Figshare, Dataverse, Mendeley, EnviDat, OSF: same pattern
  - Generic DOI: Playwright mock returns landing HTML with one
    `.csv` link → adapter follows it
- **normalizer**:
  - `.csv` round-trip preserves row count + columns
  - `.xlsx` with 2 sheets → 2 CSV manifests
  - `.parquet` → CSV with same row_count
  - `.json` array-of-records → CSV; nested object → skipped
  - `.zip` containing `data.csv` + `notes.txt` → 1 manifest (CSV only)
  - unsupported `.docx` → returns `[]` with status

### Integration (no Codex)

- Build a fake candidate dict pointing to a small public Zenodo CSV
  (e.g., a known stable test dataset). Run `fetch_dataset` end-to-end.
  Assert:
  - file in `<target>/raw/`
  - normalized CSV in `<target>/csv/`
  - `manifest.json` shape valid
  - row_count > 0

### Live cycle (with Codex)

- Run v23 with the tabular-friendly prompt above. After chronicle +
  scout + lab-director land:
  - `.research-lab/datasets/cycle-v23-*/` exists with at least one
    bundle
  - `data-bundles.json` lists ≥ 1 entry
- After analyst:
  - `role_plan.dataset_root` for lab-runner is one of the fetched
    paths (not WHO)
  - lab-runner's `tidy.csv` row_count > 0
- After cycle tail:
  - hypothesis-ledger `promoted_count` OR
    `provisionally_promoted_count` ≥ 1, OR
  - hypothesis-ledger entries show `support_basis: ["literature","data"]`
    even if not yet promoted (the "missing data evidence" blocker is
    cleared)

If neither promotion nor mixed support_basis materializes, that
indicates a downstream blocker beyond Phase 1 (likely the
column-matching → blueprint-generation step). That would justify a
Phase 1.5 follow-up rather than relying on Phase 2.

## Out of scope (Phase 2+)

- **Raster / spatial fetcher**: GeoTIFF (Landsat C2 STAC), NetCDF,
  HDF5, OSM Overpass vectors. Would need rasterio / xarray /
  geopandas and per-format spatial-aggregation policies (zonal stats,
  reprojection, etc.).
- **Codex-agent adapter generator**: when a format isn't supported,
  spawn an LLM that writes a custom Python adapter for it and
  executes it. Useful for one-off domain shapes but high cost +
  security review.
- **Automatic variable mapping**: hypothesis says
  `x_variable: "green_space_density"`; bundle has columns like
  `["pct_canopy_2020","city_id"]`. Phase 1 leaves this to lab-director
  / analyst LLM judgment via `column_mapping`. Phase 2 could add a
  semantic embedding match.

## Risks & open questions

1. **DataCite landing pages without API**: many publishers (e.g.,
   institutional repositories) have neither a documented API nor a
   download link discoverable from the landing HTML. The generic
   Playwright adapter is a best-effort fallback; expect a meaningful
   tail of `fetch_status: "no_download_link_found"`.
2. **File-size cap**: 200 MB per file may be too low for some
   real-world climate/population datasets but raising it costs disk
   + time. Default conservative; surface as configurable arg on the
   scout CLI (`--max-fetch-bytes`).
3. **Fetched bundle directory growth**: each cycle creates new
   bundles. No cleanup yet. Acceptable for now (CI / dev environments
   are ephemeral); add a TTL pruner in a later PR if needed.
4. **License / TOS compliance**: DataCite-registered data is
   typically published under an explicit license, but a generic
   Playwright fetch could hit a paywall or robots.txt-restricted
   resource. Phase 1 only follows links that the discovered DOI
   metadata explicitly classifies as `accessRights: open`.
5. **Promotion gate may still not trip**: even with `data` evidence
   added to `support_basis`, the structural prereqs include
   `support_count >= 3`, `roleDiversity >= 2`, `latest_status ==
   "robust"`. The first cycle of fetched-data evidence may only get
   to `claim_candidate` / `contending`, not `provisionally_promoted`.
   The verification plan deliberately accepts this — closing the
   "no data evidence" blocker is the goal; full promotion may need
   one more cycle of incremental evidence.

## Critical files modified by this revision

- **NEW**: `researchlab/drivers/data/dataset_fetcher.py`
- **MODIFIED**: `researchlab/drivers/data/data_scout_browser.py`
- **MODIFIED**: `researchlab/native/researchlab-harness/src/runtime/engine.rs`
  (`choose_dataset_bundle_path`)
- **MODIFIED**: `researchlab/native/researchlab-harness/src/labdirector/mod.rs`
  (`latest_dataset_selection`)
- **MODIFIED**: `researchlab/native/researchlab-harness/src/labdirector/policy.rs`
  (analyst task markdown)
- **MODIFIED**: `researchlab/package.json` (add openpyxl + pyarrow to
  Python deps doctor probe)
- **NEW TESTS**: `researchlab/tests/dataset_fetcher.test.js`
  (or `tests/dataset_fetcher_test.py` if Python-side easier)

## Decisions (locked-in 2026-04-28)

1. **Provider adapter set** — proposal taken as-is: Zenodo +
   Figshare + Dataverse + Mendeley + EnviDat + OSF + generic DOI
   fallback. Other repositories (PANGAEA, ICPSR, UCI, Kaggle) deferred
   to a follow-up; their generic DOI fallback path may catch some of
   them anyway.
2. **Bundle namespacing** — proposal taken as-is: cycle-scoped at
   `.research-lab/datasets/<cycle_id>/<dataset_slug>/`. Re-use across
   cycles via registry left for follow-up.
3. **Python dependency policy** — confirmed:
   - Add `pandas` + `pyarrow` + `openpyxl` to the project's Python
     venv as base. The doctor probe (`bootstrap`) is responsible for
     ensuring they are present.
   - **Allow analyst to install additional packages on demand**:
     when an analyst-emitted blueprint needs an extra package
     (e.g., `scikit-learn`, `statsmodels`, `geopandas`), the
     blueprint declares it via a `pip_install_packages: ["pkg",...]`
     field. The python_stats driver pip-installs into the same venv
     before running the blueprint. Safety constraints:
     - PyPI source only (`pip install <name>`, no `pip install
       git+...` / no `--index-url` overrides)
     - Package name allow-pattern: `^[a-zA-Z][a-zA-Z0-9_\-\.]*(==[\w\.\-]+)?$`
     - Hard cap of 6 added packages per blueprint; further requests
       are rejected with a manifest entry rather than installed
     - Each install logged into `result.json::pip_installs[]` so
       chronicle can surface the dependency drift
   - This change applies to the python_stats blueprint executor
     specifically — not to the harness or scout.
4. **Verification prompt** — confirmed: use **engineering and
   medical** domains (not social-science). Both have heavy tabular
   data on DataCite-registered repositories.

   Two candidate v23 prompts (one engineering, one medical) — pick
   one for the first run, hold the other for v24:
   - **Engineering**: "How does fiber orientation affect tensile
     strength and stiffness in additively-manufactured carbon-fiber
     composites? Identify open datasets and produce one falsifiable
     comparison across at least two manufacturing processes."
   - **Medical**: "Which routinely measured admission blood
     biomarkers most strongly predict 30-day all-cause readmission
     in adult heart-failure patients? Identify open datasets and
     produce one falsifiable comparison across at least two
     hospital cohorts or registries."

   Recommendation: run the **medical** prompt first — DataCite
   coverage of openly-released clinical CSV datasets (MIMIC
   derivative tables, eICU subsets, observational registries) is
   denser than for materials-science benchmarks, so the fetcher
   path will get better tabular hit-rate for the first smoke.
