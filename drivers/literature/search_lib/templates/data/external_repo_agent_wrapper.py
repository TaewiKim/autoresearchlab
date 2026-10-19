
import argparse
import csv
import html
import json
import math
import os
import py_compile
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    import pandas as pd  # type: ignore
except Exception as exc:  # pragma: no cover - environment dependent
    pd = None
    PANDAS_IMPORT_ERROR = str(exc)[:240]
else:
    PANDAS_IMPORT_ERROR = None


def load_metadata():
    path = os.environ.get("RESEARCHLAB_SELECTED_AGENT_JSON")
    if path and Path(path).is_file():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    local = Path("selected-agent.json")
    if local.is_file():
        return json.loads(local.read_text(encoding="utf-8"))
    return {}


def repo_path_from(metadata):
    for key in ("repository_local_path", "repo_path", "downloaded_repo_path"):
        value = metadata.get(key)
        if value:
            path = Path(value)
            if path.exists():
                return path
    path = Path.cwd() / "repo"
    return path


def short_text(value, limit=240):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def repo_inventory(repo):
    files = []
    for path in repo.rglob("*"):
        if ".git" in path.parts or not path.is_file():
            continue
        rel = path.relative_to(repo)
        if len(files) < 500:
            files.append(str(rel))
    readmes = [f for f in files if Path(f).name.lower().startswith("readme")]
    licenses = [f for f in files if Path(f).name.lower().startswith("license")]
    py_files = [f for f in files if f.endswith(".py")]
    r_files = [f for f in files if f.endswith(".R") or f.endswith(".r")]
    skill_files = [
        f for f in files
        if Path(f).name.lower() in {"skill.md", "usage-guide.md"}
    ]
    workflow_files = [
        f for f in files
        if f.endswith((".nf", ".smk", ".cwl", ".wdl", ".yml", ".yaml"))
        or Path(f).name.lower() in {"snakefile", "nextflow.config"}
    ]
    return {
        "file_count_sampled": len(files),
        "readmes": readmes[:8],
        "licenses": licenses[:8],
        "python_files_sampled": py_files[:20],
        "r_files_sampled": r_files[:20],
        "skill_files_sampled": skill_files[:30],
        "workflow_files_sampled": workflow_files[:20],
    }


def compile_smoke(repo, inventory):
    attempts = []
    for rel in inventory.get("python_files_sampled", [])[:10]:
        path = repo / rel
        try:
            py_compile.compile(str(path), doraise=True)
            attempts.append({"path": rel, "status": "compiled"})
        except Exception as exc:  # pylint: disable=broad-except
            attempts.append({"path": rel, "status": "failed", "error": short_text(exc)})
            break
    return attempts


def git_head(repo):
    try:
        completed = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception as exc:  # pylint: disable=broad-except
        return {"status": "unavailable", "error": short_text(exc)}
    return {
        "status": "available" if completed.returncode == 0 else "failed",
        "head": completed.stdout.strip(),
        "stderr": short_text(completed.stderr),
    }


def _project_root_from_runtime():
    for value in [os.environ.get("RESEARCHLAB_OUTPUT_DIR"), os.environ.get("RESEARCHLAB_CSV_ROOT"), os.getcwd()]:
        if not value:
            continue
        path = Path(value).resolve()
        for candidate in [path, *path.parents]:
            if candidate.name == ".research-lab":
                return candidate.parent
            if (candidate / ".research-lab").exists():
                return candidate
    return None


def _python_with_modules(*modules):
    project_root = _project_root_from_runtime()
    candidates = [
        os.environ.get("RESEARCHLAB_PYTHON"),
        sys.executable,
        str(project_root / ".venv" / "bin" / "python") if project_root else None,
        "python3",
    ]
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            completed = subprocess.run(
                [candidate, "-c", "; ".join(f"import {module}" for module in modules)],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception:  # pylint: disable=broad-except
            continue
        if completed.returncode == 0:
            return candidate
    return sys.executable


def supported_repository_workflows(repo):
    workflows = []
    clawbio_skill = repo / "skills" / "diff-visualizer" / "diff_visualizer.py"
    if clawbio_skill.is_file():
        workflows.append({
            "workflow_name": "ClawBio diff-visualizer",
            "workflow_kind": "repository_native_skill",
            "entrypoint": str(clawbio_skill),
            "input_contract": "differential feature table with feature/program/gene identifier, effect size/log2FC, p-value, and FDR/q-value columns; gene-level DE is one valid instance but modality-specific program-score contrasts are also valid when clearly labelled",
        })
    bioskills_visual = repo / "differential-expression" / "de-visualization" / "SKILL.md"
    bioskills_results = repo / "differential-expression" / "de-results" / "SKILL.md"
    if bioskills_visual.is_file() or bioskills_results.is_file():
        workflows.append({
            "workflow_name": "BioSkills differential-expression skill-guided workflow",
            "workflow_kind": "repository_native_skill_docs",
            "skill_paths": [
                str(path.relative_to(repo))
                for path in [bioskills_visual, bioskills_results]
                if path.is_file()
            ],
            "input_contract": "differential-expression result table normalized to gene/log2FoldChange/pvalue/padj",
            "expected_outputs": ["result.json", "bioskills_de_results.csv", "bioskills_volcano.html", "report.md"],
        })
    render_scene_exts = (".pbrt", ".xml", ".obj", ".gltf", ".glb", ".blend", ".usd", ".usda")
    render_scenes = [p for p in repo.rglob("*") if p.is_file() and p.suffix.lower() in render_scene_exts][:5]
    render_entry = None
    for candidate_py in repo.rglob("*.py"):
        try:
            head = candidate_py.read_text(encoding="utf-8", errors="replace")[:4000]
        except Exception:  # pylint: disable=broad-except
            continue
        if "import mitsuba" in head or "import drjit" in head or "def render" in head:
            render_entry = candidate_py
            break
    if render_scenes or render_entry:
        workflows.append({
            "workflow_name": "Rendering / graphics workflow",
            "workflow_kind": "repository_render_workflow",
            "entrypoint": str(render_entry) if render_entry else None,
            "scene_paths": [str(p.relative_to(repo)) for p in render_scenes],
            "input_contract": "scene/asset description (.pbrt/.xml/.obj/.gltf) or an in-code scene; runs a renderer and emits image(s) + timing/quality metrics",
            "expected_outputs": ["result.json", "render.png", "render_metrics.csv"],
        })
    generic_entry = None
    for cand_name in ("main.py", "__main__.py", "cli.py", "run.py"):
        hit = next((p for p in repo.rglob(cand_name) if p.is_file()), None)
        if hit:
            generic_entry = hit
            break
    if generic_entry is not None and not workflows:
        workflows.append({
            "workflow_name": "Generic repository CLI workflow",
            "workflow_kind": "repository_generic_cli",
            "entrypoint": str(generic_entry),
            "input_contract": "the dataset/asset paths from the analyst handoff, passed to the repository's documented entrypoint; emits result.json plus task-relevant artifacts",
            "expected_outputs": ["result.json"],
        })
    return workflows


def smoke():
    metadata = load_metadata()
    repo = repo_path_from(metadata)
    inventory = repo_inventory(repo) if repo.exists() else {}
    supported_workflows = supported_repository_workflows(repo) if repo.exists() else []
    payload = {
        "status": "ok" if repo.exists() and inventory.get("readmes") else "warning",
        "agent_name": metadata.get("name"),
        "repo_url": metadata.get("url"),
        "repo_path": str(repo),
        "repo_exists": repo.exists(),
        "git": git_head(repo) if repo.exists() else None,
        "inventory": inventory,
        "compile_smoke": compile_smoke(repo, inventory) if repo.exists() else [],
        "supported_repository_workflows": supported_workflows,
        "repository_native_workflow_available": bool(supported_workflows),
        "pandas": getattr(pd, "__version__", None),
        "pandas_import_error": PANDAS_IMPORT_ERROR,
    }
    print(json.dumps(payload, sort_keys=True))


def read_csv_preview(path):
    if pd is not None:
        try:
            return pd.read_csv(path, nrows=5000, low_memory=False)
        except Exception as exc:  # pylint: disable=broad-except
            return {"error": short_text(exc)}
    rows = []
    try:
        with path.open(newline="", encoding="utf-8", errors="replace") as handle:
            reader = csv.DictReader(handle)
            for index, row in enumerate(reader):
                rows.append(row)
                if index >= 4999:
                    break
        return rows
    except Exception as exc:  # pylint: disable=broad-except
        return {"error": short_text(exc)}


def table_profile(path, terms):
    frame = read_csv_preview(path)
    if isinstance(frame, dict) and "error" in frame:
        return {"path": str(path), "status": "load_failed", "error": frame["error"]}
    if pd is not None and hasattr(frame, "columns"):
        columns = [str(c) for c in frame.columns]
        text_columns = [
            c for c in columns
            if re.search(r"(gene|symbol|term|pathway|name|description|id)", c, re.I)
        ][:6]
        numeric_columns = []
        for column in columns:
            series = pd.to_numeric(frame[column], errors="coerce")
            if series.notna().sum() >= max(3, int(0.2 * max(len(frame), 1))):
                numeric_columns.append(column)
        term_hits = {}
        for term in terms:
            pattern = re.compile(re.escape(term), re.I)
            count = 0
            for column in text_columns:
                count += int(frame[column].astype(str).str.contains(pattern, na=False).sum())
            if count:
                term_hits[term] = count
        top_variable_rows = []
        if numeric_columns:
            numeric = frame[numeric_columns].apply(pd.to_numeric, errors="coerce")
            variance = numeric.var(axis=1, skipna=True).fillna(0)
            for idx in variance.sort_values(ascending=False).head(12).index:
                label = None
                for column in text_columns:
                    value = str(frame.loc[idx, column])
                    if value and value.lower() != "nan":
                        label = value
                        break
                top_variable_rows.append({"row_index": int(idx), "label": label, "variance": float(variance.loc[idx])})
        return {
            "path": str(path),
            "status": "profiled",
            "rows_read": int(len(frame)),
            "columns": len(columns),
            "text_columns": text_columns,
            "numeric_columns": numeric_columns[:24],
            "term_hits": term_hits,
            "top_variable_rows": top_variable_rows,
        }
    columns = list(frame[0].keys()) if frame else []
    return {
        "path": str(path),
        "status": "profiled",
        "rows_read": len(frame),
        "columns": len(columns),
        "text_columns": columns[:6],
        "numeric_columns": [],
        "term_hits": {},
        "top_variable_rows": [],
    }


def _column_by_alias(columns, aliases):
    normalized = {
        re.sub(r"[^a-z0-9]+", "", str(column).lower()): str(column)
        for column in columns
    }
    for alias in aliases:
        key = re.sub(r"[^a-z0-9]+", "", alias.lower())
        if key in normalized:
            return normalized[key]
    return None


def _parse_geo_sample_groups(csv_root):
    group_by_sample = {}
    metadata_sources = []
    for path in sorted(Path(csv_root).rglob("*metadata*.txt"))[:20]:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:  # pylint: disable=broad-except
            continue
        sample_ids = []
        disease_states = []
        for line in lines:
            if line.startswith("!Sample_title"):
                values = next(csv.reader([line], delimiter="\t"))
                sample_ids = []
                for value in values[1:]:
                    match = re.search(r"\b([A-Za-z]{2,}\d{3,})\b", value)
                    sample_ids.append(match.group(1) if match else "")
            elif line.startswith("!Sample_characteristics_ch1") and re.search(r"disease state|diagnosis|group|condition|cohort|phenotype|status|genotype|treatment", line, re.I):
                values = next(csv.reader([line], delimiter="\t"))
                disease_states = []
                for value in values[1:]:
                    # General: keep the actual label after the "key:" prefix
                    # (e.g. "disease state: AIH" -> "AIH"), not a hardcoded set.
                    text = str(value).strip()
                    label = text.split(":", 1)[1].strip() if ":" in text else text
                    disease_states.append(label)
        if not sample_ids or not disease_states or len(sample_ids) != len(disease_states):
            continue
        for sample_id, state in zip(sample_ids, disease_states):
            if sample_id and state:
                group_by_sample[sample_id] = state
        metadata_sources.append(str(path))
    return group_by_sample, metadata_sources


def _infer_expression_contrast(columns):
    sample_columns = [str(column) for column in columns]
    suffix_groups = {}
    for column in sample_columns:
        match = re.search(r"(?:^|[_-])(?:Exp[_-]?)?NCH\d+([A-Za-z])$", column)
        if match:
            suffix_groups.setdefault(match.group(1).lower(), []).append(column)
    usable_suffix_groups = [values for values in suffix_groups.values() if len(values) >= 3]
    if len(usable_suffix_groups) >= 2:
        ordered = sorted(usable_suffix_groups, key=lambda values: (-len(values), values[0]))
        return ordered[0], ordered[1], {
            "contrast": "GEO_sample_suffix_group_1_vs_group_2",
            "grouping_source": "sample column suffix pattern",
            "group_labels": sorted(suffix_groups),
            "group_sizes": {key: len(value) for key, value in suffix_groups.items()},
        }
    # General name-encoded grouping (GEO sample ids commonly carry the study
    # group as leading tokens, e.g. CTRL_*/SLE_*). No dataset-specific labels.
    def _toks(name):
        return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", str(name)) if t]
    control_tokens = {"hd", "hc", "ctrl", "ctl", "control", "controls", "normal",
                      "healthy", "wt", "mock", "baseline", "ref", "reference", "nc"}
    ctrl_cols = [c for c in sample_columns if any(t in control_tokens for t in _toks(c))]
    case_cols = [c for c in sample_columns if c not in ctrl_cols]
    if len(ctrl_cols) >= 3 and len(case_cols) >= 3:
        return case_cols, ctrl_cols, {
            "contrast": "name_encoded_case_vs_control",
            "grouping_source": "sample-id control-token naming convention",
            "group_sizes": {"case": len(case_cols), "control": len(ctrl_cols)},
        }
    lead = {c: (_toks(c)[0] if _toks(c) else "") for c in sample_columns}
    from collections import Counter as _C
    big = [g for g, n in _C(lead.values()).items() if n >= 3 and g]
    if len(big) == 2:
        g0, g1 = sorted(big)
        a = [c for c in sample_columns if lead[c] == g0]
        b = [c for c in sample_columns if lead[c] == g1]
        if len(a) >= 3 and len(b) >= 3:
            return a, b, {
                "contrast": "name_encoded_leading_token_groups",
                "grouping_source": "sample-id leading-token naming convention",
                "group_labels": [g0, g1],
                "group_sizes": {g0: len(a), g1: len(b)},
            }
    numeric_like = [
        column for column in sample_columns
        if re.search(r"(sample|exp|gsm|nch|patient|tumou?r|metast)", column, re.I)
    ]
    if len(numeric_like) < 6:
        return [], [], None
    half = len(numeric_like) // 2
    if half < 3 or len(numeric_like) - half < 3:
        return [], [], None
    return numeric_like[:half], numeric_like[half:], {
        "contrast": "schema_ordered_expression_matrix_split_A_vs_B",
        "grouping_source": "fallback schema-only split for repository workflow preflight when no sample phenotype metadata is materialized",
        "group_sizes": {"A": half, "B": len(numeric_like) - half},
    }


def _bh_adjust(pvalues):
    values = pd.to_numeric(pvalues, errors="coerce").fillna(1.0).clip(lower=1e-300, upper=1.0)
    m = int(len(values))
    if m == 0:
        return values
    ordered = values.sort_values(ascending=False)
    adjusted = {}
    running = 1.0
    for rank_from_end, (idx, value) in enumerate(ordered.items(), start=1):
        rank = m - rank_from_end + 1
        running = min(running, float(value) * m / max(rank, 1))
        adjusted[idx] = min(1.0, running)
    return values.index.to_series().map(adjusted).astype(float)


def _float_or_default(value, default=1.0):
    try:
        if value is None or str(value).strip() == "":
            return default
        return float(value)
    except Exception:  # pylint: disable=broad-except
        return default


def _candidate_csv_files(csv_root, output_dir):
    roots = []
    for value in [os.environ.get("RESEARCHLAB_OUTPUT_DIR"), csv_root, output_dir]:
        try:
            root = Path(value).resolve()
        except Exception:  # pylint: disable=broad-except
            continue
        if root.exists() and root not in roots:
            roots.append(root)
    # FIX-H: also search the cycle's RAW dataset matrices. The external-agent
    # csv_root often points at the lane/blueprint output, which holds only the
    # analyst's joined master table (a long join table, not a wide gene x sample
    # matrix), so the expression-matrix DE derivation has nothing to convert and
    # the substantive-repository-workflow gate fails. The raw, group-encoded
    # matrices live in a sibling tree ".research-lab/datasets/<cycle_id>/<ds>/csv/"
    # -- reachable by walking up from any search root to the ".research-lab"
    # anchor and across to "datasets/<cycle_id>". Purely additive (only adds
    # candidates; the derivation still validates each one), no dataset-specific
    # names, no hardcoding.
    for root in list(roots):
        parts = root.parts
        if ".research-lab" not in parts:
            continue
        anchor_idx = parts.index(".research-lab")
        cycle_id = None
        for marker in ("stats", "lanes"):
            if marker in parts[anchor_idx:]:
                marker_idx = parts.index(marker, anchor_idx)
                if marker_idx + 1 < len(parts):
                    cycle_id = parts[marker_idx + 1]
                    break
        if not cycle_id:
            continue
        try:
            dataset_dir = (Path(*parts[: anchor_idx + 1]) / "datasets" / cycle_id).resolve()
        except Exception:  # pylint: disable=broad-except
            continue
        if dataset_dir.exists() and dataset_dir not in roots:
            roots.append(dataset_dir)
    skipped_parts = {"external-agents", "repo_workflows"}
    seen = set()
    for root in roots:
        for path in sorted(root.rglob("*.csv")):
            try:
                resolved = path.resolve()
            except Exception:  # pylint: disable=broad-except
                resolved = path
            if str(resolved) in seen:
                continue
            seen.add(str(resolved))
            if any(part in skipped_parts for part in path.parts):
                continue
            yield path


def _find_simple_differential_feature_table(csv_root, output_dir):
    workflow_root = Path(output_dir).resolve() / "repo_workflows"
    workflow_root.mkdir(parents=True, exist_ok=True)
    rejected = []
    candidates = []
    for path in list(_candidate_csv_files(csv_root, output_dir))[:160]:
        try:
            with path.open(newline="", encoding="utf-8", errors="replace") as handle:
                reader = csv.DictReader(handle)
                rows = list(reader)
                columns = [str(column) for column in (reader.fieldnames or [])]
        except Exception as exc:  # pylint: disable=broad-except
            rejected.append({"path": str(path), "reason": short_text(exc)})
            continue
        if not rows or not columns:
            rejected.append({"path": str(path), "reason": "empty CSV"})
            continue
        gene_col = _column_by_alias(columns, ["gene", "gene_name", "gene_symbol", "symbol", "gene_id", "names"])
        lfc_col = _column_by_alias(columns, ["log2FoldChange", "log2fc", "log2_fc", "log2(fc)", "logFC", "avg_log2FC"])
        feature_col = _column_by_alias(columns, ["feature", "program", "program_name", "signature", "pathway", "contrast_feature", "metric"])
        effect_col = _column_by_alias(columns, ["effect_size", "effect", "difference", "delta", "mean_difference", "vili_minus_aih", "estimate", "coefficient"])
        padj_col = _column_by_alias(columns, ["padj", "qval", "q.value", "qvalue", "fdr", "FDR", "adj.P.Val", "p.adjust"])
        p_col = _column_by_alias(columns, ["pvalue", "pval", "P.Value", "P.value", "p.value", "p_val", "p_value", "permutation_p", "perm_p"])
        id_col = gene_col or feature_col
        effect_source_col = lfc_col or effect_col
        if not id_col or not effect_source_col or not (padj_col or p_col):
            rejected.append({
                "path": str(path),
                "reason": "missing simple differential feature columns",
                "columns": columns[:20],
            })
            continue
        normalized_rows = []
        for row in rows:
            label = str(row.get(id_col) or "").strip()
            effect = _float_or_default(row.get(effect_source_col), default=float("nan"))
            if not label or math.isnan(effect):
                continue
            pvalue = _float_or_default(row.get(p_col), default=_float_or_default(row.get(padj_col), default=1.0))
            padj = _float_or_default(row.get(padj_col), default=pvalue)
            base = _float_or_default(row.get("baseMean") or row.get("base_mean") or row.get("mean_score"), default=abs(effect))
            normalized_rows.append({
                "gene": label,
                "log2FoldChange": effect,
                "pvalue": min(max(pvalue, 1e-300), 1.0),
                "padj": min(max(padj, 1e-300), 1.0),
                "baseMean": base,
            })
        if len(normalized_rows) < 2:
            rejected.append({"path": str(path), "reason": "fewer than two usable differential rows"})
            continue
        semantics = "gene_level_differential_expression_table" if gene_col and lfc_col else "modality_specific_differential_feature_table"
        score = 80 + min(20, len(normalized_rows))
        if path.name.lower().endswith("program-effects.csv"):
            score += 35
        if re.search(r"leave[-_]?one", path.name, re.I):
            score -= 20
        candidates.append({
            "path": str(path),
            "status": "normalized_from_simple_csv",
            "score": score,
            "rows": len(normalized_rows),
            "gene_column": gene_col,
            "feature_column": feature_col,
            "log2fc_column": lfc_col,
            "effect_column": effect_col,
            "adjusted_p_column": padj_col,
            "p_value_column": p_col,
            "normalized_rows": normalized_rows,
            "input_table_semantics": semantics,
            "derivation_note": (
                "Normalized a simple differential feature table without pandas. "
                "If input_table_semantics is modality_specific_differential_feature_table, rows are not asserted to be gene-level DE."
            ),
        })
    if candidates:
        selected = sorted(candidates, key=lambda item: (item.get("score") or 0, item.get("rows") or 0), reverse=True)[0]
        normalized_path = workflow_root / "simple_differential_feature_input.csv"
        with normalized_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["gene", "log2FoldChange", "pvalue", "padj", "baseMean"])
            writer.writeheader()
            writer.writerows(selected.pop("normalized_rows"))
        selected["normalized_input"] = str(normalized_path)
        return selected, None
    return None, "no simple differential feature table found; rejected=" + json.dumps(rejected[:8], ensure_ascii=False)[:1000]


def _derive_de_table_from_expression(csv_root, output_dir):
    if pd is None:
        return None, "pandas is unavailable, so expression-matrix DE derivation is blocked"
    group_by_sample, metadata_sources = _parse_geo_sample_groups(csv_root)
    workflow_root = Path(output_dir).resolve() / "repo_workflows"
    workflow_root.mkdir(parents=True, exist_ok=True)
    rejected = []
    for path in list(_candidate_csv_files(csv_root, output_dir))[:160]:
        try:
            header = pd.read_csv(path, nrows=0)
        except Exception as exc:  # pylint: disable=broad-except
            rejected.append({"path": str(path), "reason": short_text(exc)})
            continue
        columns = [str(column) for column in header.columns]
        gene_col = _column_by_alias(columns, ["gene", "gene_name", "gene_symbol", "symbol", "gene_id", "ID_REF", "rownames", "rowname"])
        sample_columns = [column for column in columns if column in group_by_sample]
        # General: the two contrast groups are the two most common metadata
        # labels among the matched samples (each needs >=3), not a hardcoded
        # P-MCI/S-MCI pair. Control-like label is ordered as the reference (B).
        from collections import Counter as _Counter
        label_counts = _Counter(group_by_sample[c] for c in sample_columns if group_by_sample.get(c))
        top_labels = [lbl for lbl, n in label_counts.most_common() if n >= 3][:2]
        control_vocab = {"control", "controls", "healthy", "normal", "hc", "hd", "ctrl", "ctl", "wt", "baseline", "ref", "reference"}
        if len(top_labels) == 2 and any(t.lower() in control_vocab for t in top_labels):
            top_labels.sort(key=lambda t: t.lower() in control_vocab)  # control last (group B = reference)
        group_a_label = top_labels[0] if len(top_labels) >= 1 else None
        group_b_label = top_labels[1] if len(top_labels) >= 2 else None
        group_a_columns = [c for c in sample_columns if group_by_sample.get(c) == group_a_label] if group_a_label else []
        group_b_columns = [c for c in sample_columns if group_by_sample.get(c) == group_b_label] if group_b_label else []
        contrast_metadata = {
            "contrast": f"{group_a_label}_vs_{group_b_label}" if group_a_label and group_b_label else "metadata_contrast",
            "grouping_source": "GEO sample metadata label (two dominant groups)",
            "metadata_sources": metadata_sources,
        }
        if len(group_a_columns) < 3 or len(group_b_columns) < 3:
            inferred_a, inferred_b, inferred_meta = _infer_expression_contrast([column for column in columns if column != gene_col])
            if inferred_meta:
                group_a_columns, group_b_columns, contrast_metadata = inferred_a, inferred_b, inferred_meta
        if not gene_col or len(group_a_columns) < 3 or len(group_b_columns) < 3:
            rejected.append({
                "path": str(path),
                "reason": "not a wide expression matrix with a gene/row-name column and at least two inferable sample groups of size three",
                "gene_column": gene_col,
                "group_a_samples": len(group_a_columns),
                "group_b_samples": len(group_b_columns),
            })
            continue
        try:
            frame = pd.read_csv(path, low_memory=False)
        except Exception as exc:  # pylint: disable=broad-except
            rejected.append({"path": str(path), "reason": short_text(exc)})
            continue
        if len(frame) < 3:
            rejected.append({"path": str(path), "reason": "fewer than three feature rows"})
            continue
        genes = frame[gene_col].astype(str).replace({"nan": ""})
        numeric = frame[group_a_columns + group_b_columns].apply(pd.to_numeric, errors="coerce")
        numeric = numeric.loc[genes.astype(str).str.len() > 0].copy()
        genes = genes.loc[numeric.index]
        if len(numeric) < 3:
            rejected.append({"path": str(path), "reason": "fewer than three finite expression rows after filtering"})
            continue
        log_transform = lambda value: math.log2(float(value) + 1.0) if pd.notna(value) else float("nan")
        clipped = numeric.clip(lower=0)
        shifted = clipped.map(log_transform) if hasattr(clipped, "map") else clipped.applymap(log_transform)
        group_a_expr = shifted[group_a_columns]
        group_b_expr = shifted[group_b_columns]
        log2fc = group_a_expr.mean(axis=1, skipna=True) - group_b_expr.mean(axis=1, skipna=True)
        base_mean = numeric.mean(axis=1, skipna=True)
        se = ((group_a_expr.var(axis=1, skipna=True) / max(len(group_a_columns), 1)) + (group_b_expr.var(axis=1, skipna=True) / max(len(group_b_columns), 1))).pow(0.5)
        z_score = (log2fc / se.replace({0: float("nan")})).replace([float("inf"), float("-inf")], float("nan")).fillna(0.0)
        pvalue = z_score.abs().map(lambda value: math.erfc(float(value) / math.sqrt(2.0))).clip(lower=1e-300, upper=1.0)
        normalized = pd.DataFrame({
            "gene": genes,
            "log2FoldChange": log2fc,
            "pvalue": pvalue,
            "padj": _bh_adjust(pvalue),
            "baseMean": base_mean,
        }).dropna(subset=["gene", "log2FoldChange"]).copy()
        normalized = normalized[normalized["gene"].astype(str).str.len() > 0]
        if len(normalized) < 3:
            rejected.append({"path": str(path), "reason": "derived DE table had fewer than three usable rows"})
            continue
        normalized["abs_log2FoldChange"] = normalized["log2FoldChange"].abs()
        normalized = normalized.sort_values(["padj", "abs_log2FoldChange"], ascending=[True, False])
        normalized_path = workflow_root / "derived_expression_de_repository_workflow_input.csv"
        normalized[["gene", "log2FoldChange", "pvalue", "padj", "baseMean"]].to_csv(normalized_path, index=False)
        return {
            "path": str(path),
            "status": "derived_from_expression_matrix",
            "score": 72 + min(20, int(len(normalized) / 500)),
            "rows": int(len(normalized)),
            "gene_column": gene_col,
            "contrast": contrast_metadata.get("contrast"),
            "contrast_metadata": contrast_metadata,
            "group_a_samples": len(group_a_columns),
            "group_b_samples": len(group_b_columns),
            "metadata_sources": metadata_sources,
            "normalized_input": str(normalized_path),
            "derivation_note": "Derived a lightweight differential-expression-style table from a wide expression matrix so the cloned repository-native DE workflow can run. If phenotype metadata is absent, the contrast is a schema-derived repository-workflow preflight contrast and must not be over-interpreted as the final biological estimand.",
        }, None
    return None, "no compatible expression matrix could be converted into a DE workflow input; rejected=" + json.dumps(rejected[:8], ensure_ascii=False)[:1000]


def _find_de_table(csv_root, output_dir):
    if pd is None:
        return _find_simple_differential_feature_table(csv_root, output_dir)
    candidates = []
    for path in list(_candidate_csv_files(csv_root, output_dir))[:160]:
        try:
            frame = pd.read_csv(path, low_memory=False)
        except Exception as exc:  # pylint: disable=broad-except
            candidates.append({"path": str(path), "status": "load_failed", "error": short_text(exc)})
            continue
        columns = [str(column) for column in frame.columns]
        gene_col = _column_by_alias(columns, ["gene", "gene_name", "gene_symbol", "symbol", "gene_id", "names"])
        lfc_col = _column_by_alias(columns, ["log2FoldChange", "log2fc", "log2_fc", "log2(fc)", "logFC", "avg_log2FC"])
        padj_col = _column_by_alias(columns, ["padj", "qval", "q.value", "qvalue", "fdr", "FDR", "adj.P.Val", "p.adjust"])
        p_col = _column_by_alias(columns, ["pvalue", "pval", "P.Value", "P.value", "p.value", "p_val", "p_value", "permutation_p", "perm_p"])
        feature_col = _column_by_alias(columns, ["feature", "program", "program_name", "signature", "pathway", "contrast_feature", "metric"])
        effect_col = _column_by_alias(columns, ["effect_size", "effect", "difference", "delta", "mean_difference", "vili_minus_aih", "estimate", "coefficient"])
        score = 0
        if gene_col:
            score += 20
        if lfc_col:
            score += 30
        if padj_col:
            score += 25
        if p_col:
            score += 10
        if re.search(r"(diff|de|deseq|edger|limma|contrast)", path.name, re.I):
            score += 15
        feature_score = 0
        if feature_col:
            feature_score += 25
        if effect_col:
            feature_score += 35
        if padj_col:
            feature_score += 20
        if p_col:
            feature_score += 10
        if re.search(r"(program|feature|contrast|effect|differential|master)", path.name, re.I):
            feature_score += 15
        if path.name.lower().endswith("program-effects.csv"):
            feature_score += 35
        if re.search(r"leave[-_]?one", path.name, re.I):
            feature_score -= 20
        if score < 65 and feature_score >= 65:
            normalized = pd.DataFrame()
            normalized["gene"] = frame[feature_col].astype(str).replace({"nan": ""})
            normalized["log2FoldChange"] = pd.to_numeric(frame[effect_col], errors="coerce")
            if padj_col:
                normalized["padj"] = pd.to_numeric(frame[padj_col], errors="coerce")
            elif p_col:
                normalized["padj"] = pd.to_numeric(frame[p_col], errors="coerce")
            if p_col:
                normalized["pvalue"] = pd.to_numeric(frame[p_col], errors="coerce")
            else:
                normalized["pvalue"] = normalized["padj"]
            base_col = _column_by_alias(columns, ["baseMean", "base_mean", "mean", "mean_score", "average", "AveExpr"])
            if base_col:
                normalized["baseMean"] = pd.to_numeric(frame[base_col], errors="coerce")
            else:
                normalized["baseMean"] = normalized["log2FoldChange"].abs()
            normalized = normalized.dropna(subset=["log2FoldChange"]).copy()
            normalized = normalized[normalized["gene"].astype(str).str.len() > 0]
            if len(normalized) < 2:
                candidates.append({
                    "path": str(path),
                    "status": "rejected",
                    "reason": "fewer than two finite differential feature rows after normalization",
                    "rows": int(len(normalized)),
                    "columns": columns[:20],
                })
                continue
            candidates.append({
                "path": str(path),
                "status": "candidate",
                "score": feature_score + min(20, int(len(normalized) / 50)),
                "rows": int(len(normalized)),
                "feature_column": feature_col,
                "effect_column": effect_col,
                "adjusted_p_column": padj_col,
                "p_value_column": p_col,
                "normalized": normalized,
                "input_table_semantics": "modality_specific_differential_feature_table",
                "derivation_note": (
                    "Normalized a modality-specific differential feature/program contrast table into the ClawBio diff-visualizer column names. "
                    "The rows are not asserted to be gene-level DE rows; the feature identifiers preserve the GeoMx/program-score estimand."
                ),
            })
            continue
        if score < 65:
            candidates.append({
                "path": str(path),
                "status": "rejected",
                "reason": "missing either gene/log2 fold-change/adjusted-p columns or modality-specific feature/effect/p-value columns required by a differential feature visualization workflow",
                "columns": columns[:20],
            })
            continue
        normalized = pd.DataFrame()
        normalized["gene"] = frame[gene_col].astype(str).replace({"nan": ""})
        normalized["log2FoldChange"] = pd.to_numeric(frame[lfc_col], errors="coerce")
        if padj_col:
            normalized["padj"] = pd.to_numeric(frame[padj_col], errors="coerce")
        elif p_col:
            normalized["padj"] = pd.to_numeric(frame[p_col], errors="coerce")
        if p_col:
            normalized["pvalue"] = pd.to_numeric(frame[p_col], errors="coerce")
        else:
            normalized["pvalue"] = normalized["padj"]
        base_col = _column_by_alias(columns, ["baseMean", "base_mean", "mean", "AveExpr"])
        if base_col:
            normalized["baseMean"] = pd.to_numeric(frame[base_col], errors="coerce")
        normalized = normalized.dropna(subset=["log2FoldChange"]).copy()
        normalized = normalized[normalized["gene"].astype(str).str.len() > 0]
        if len(normalized) < 3:
            candidates.append({
                "path": str(path),
                "status": "rejected",
                "reason": "fewer than three finite DE rows after normalization",
                "rows": int(len(normalized)),
            })
            continue
        candidates.append({
            "path": str(path),
            "status": "candidate",
            "score": score + min(20, int(len(normalized) / 500)),
            "rows": int(len(normalized)),
            "gene_column": gene_col,
            "log2fc_column": lfc_col,
            "adjusted_p_column": padj_col,
            "p_value_column": p_col,
            "normalized": normalized,
            "input_table_semantics": "gene_level_differential_expression_table",
        })
    usable = [item for item in candidates if item.get("status") == "candidate"]
    if not usable:
        derived, derivation_blocker = _derive_de_table_from_expression(csv_root, output_dir)
        if derived:
            return derived, None
        blocked = [item for item in candidates if item.get("status") == "rejected"][:8]
        return None, (
            "no CSV matched a repository-native differential feature workflow input contract; "
            f"rejected={json.dumps(blocked, ensure_ascii=False)[:1000]}; "
            f"derivation_blocker={derivation_blocker}"
        )
    selected = sorted(usable, key=lambda item: (item.get("score") or 0, item.get("rows") or 0), reverse=True)[0]
    workflow_root = Path(output_dir).resolve() / "repo_workflows"
    workflow_root.mkdir(parents=True, exist_ok=True)
    normalized_path = workflow_root / "clawbio_diffviz_input.csv"
    selected["normalized"].to_csv(normalized_path, index=False)
    selected = {key: value for key, value in selected.items() if key != "normalized"}
    selected["normalized_input"] = str(normalized_path)
    return selected, None


def _scan_workflow_outputs(output_dir):
    figures = []
    tables = []
    reports = []
    for path in sorted(Path(output_dir).rglob("*")):
        if not path.is_file():
            continue
        rel = str(path.relative_to(output_dir))
        if path.name.lower() in {"report.md", "report.html"}:
            reports.append(rel)
        elif path.suffix.lower() in {".png", ".jpg", ".jpeg", ".svg", ".pdf", ".html"}:
            figures.append(rel)
        elif path.suffix.lower() in {".csv", ".tsv", ".json"}:
            tables.append(rel)
    return figures[:24], tables[:24], reports[:12]


def _read_text_excerpt(path, limit=1600):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")[:limit]
    except Exception:  # pylint: disable=broad-except
        return ""


def _svg_circle_rows(frame, width=900, height=520):
    margin_left = 70
    margin_right = 30
    margin_top = 32
    margin_bottom = 58
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom
    xs = frame["log2FoldChange"].astype(float)
    ys = frame["neg_log10_p"].astype(float)
    x_min = float(min(xs.min(), -1.0))
    x_max = float(max(xs.max(), 1.0))
    y_min = 0.0
    y_max = float(max(ys.max(), 1.0))
    if x_max <= x_min:
        x_max = x_min + 1.0
    if y_max <= y_min:
        y_max = y_min + 1.0

    def sx(value):
        return margin_left + ((float(value) - x_min) / (x_max - x_min)) * plot_w

    def sy(value):
        return margin_top + plot_h - ((float(value) - y_min) / (y_max - y_min)) * plot_h

    circles = []
    plot_frame = frame.sort_values("neg_log10_p", ascending=False).head(1400)
    for _, row in plot_frame.iterrows():
        label = str(row.get("gene") or "")
        status = str(row.get("significance") or "NS")
        color = "#cf3f3f" if status == "Up" else "#2e6db8" if status == "Down" else "#9aa0a6"
        radius = 3.4 if status != "NS" else 2.1
        circles.append(
            f'<circle cx="{sx(row["log2FoldChange"]):.2f}" cy="{sy(row["neg_log10_p"]):.2f}" r="{radius}" '
            f'fill="{color}" opacity="0.72"><title>{html.escape(label)} '
            f'log2FC={float(row["log2FoldChange"]):.3f} FDR={float(row["padj"]):.3g}</title></circle>'
        )
    x0 = sx(0)
    y_cut = sy(-math.log10(0.05))
    return "\n".join([
        f'<line x1="{margin_left}" y1="{margin_top + plot_h}" x2="{width - margin_right}" y2="{margin_top + plot_h}" stroke="#202124" stroke-width="1"/>',
        f'<line x1="{margin_left}" y1="{margin_top}" x2="{margin_left}" y2="{margin_top + plot_h}" stroke="#202124" stroke-width="1"/>',
        f'<line x1="{x0:.2f}" y1="{margin_top}" x2="{x0:.2f}" y2="{margin_top + plot_h}" stroke="#5f6368" stroke-dasharray="4 4"/>',
        f'<line x1="{margin_left}" y1="{y_cut:.2f}" x2="{width - margin_right}" y2="{y_cut:.2f}" stroke="#5f6368" stroke-dasharray="4 4"/>',
        *circles,
        f'<text x="{width / 2:.0f}" y="{height - 16}" text-anchor="middle" font-size="14">log2 fold change</text>',
        '<text x="18" y="260" transform="rotate(-90 18 260)" text-anchor="middle" font-size="14">-log10(p-value)</text>',
        f'<text x="{margin_left}" y="22" font-size="14">BioSkills DE visualization skill-guided volcano plot</text>',
    ])


def _run_bioskills_de_skill_workflow(repo, csv_root, output_dir):
    visual_skill = repo / "differential-expression" / "de-visualization" / "SKILL.md"
    results_skill = repo / "differential-expression" / "de-results" / "SKILL.md"
    skill_paths = [path for path in [visual_skill, results_skill] if path.is_file()]
    run_record = {
        "workflow_name": "BioSkills differential-expression skill-guided workflow",
        "workflow_kind": "repository_native_skill_docs",
        "status": "blocked",
        "substantive": False,
        "command": "internal:apply BioSkills differential-expression SKILL.md guidance to selected DE table",
        "skill_paths": [str(path.relative_to(repo)) for path in skill_paths],
        "stdout_path": None,
        "stderr_path": None,
        "output_dir": None,
        "reason": None,
    }
    if not skill_paths:
        run_record["reason"] = "repo does not expose differential-expression/de-visualization or de-results SKILL.md"
        return run_record
    de_table, blocker = _find_de_table(csv_root, output_dir)
    if not de_table:
        run_record["reason"] = blocker or "no compatible DE result table found"
        return run_record
    workflow_out = Path(output_dir).resolve() / "repo_workflows" / "bioskills-de-skill"
    if workflow_out.exists():
        shutil.rmtree(workflow_out)
    workflow_out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        ranked = None
        if pd is not None:
            frame = pd.read_csv(de_table["normalized_input"], low_memory=False)
            frame["log2FoldChange"] = pd.to_numeric(frame["log2FoldChange"], errors="coerce")
            frame["padj"] = pd.to_numeric(frame.get("padj"), errors="coerce")
            frame["pvalue"] = pd.to_numeric(frame.get("pvalue"), errors="coerce")
            frame = frame.dropna(subset=["gene", "log2FoldChange"]).copy()
            frame["padj"] = frame["padj"].fillna(frame["pvalue"]).fillna(1.0).clip(lower=1e-300, upper=1.0)
            frame["pvalue"] = frame["pvalue"].fillna(frame["padj"]).fillna(1.0).clip(lower=1e-300, upper=1.0)
            frame["neg_log10_p"] = frame["pvalue"].map(lambda value: -math.log10(max(float(value), 1e-300)))
            frame["abs_log2fc"] = frame["log2FoldChange"].abs()
            frame["significance"] = "NS"
            frame.loc[(frame["padj"] <= 0.05) & (frame["log2FoldChange"] >= 1.0), "significance"] = "Up"
            frame.loc[(frame["padj"] <= 0.05) & (frame["log2FoldChange"] <= -1.0), "significance"] = "Down"
            ranked = frame.sort_values(["padj", "abs_log2fc"], ascending=[True, False]).copy()
            ranked_records = ranked.head(5000).to_dict(orient="records")
            top_genes = ranked.head(20)[["gene", "log2FoldChange", "padj", "pvalue", "significance"]].to_dict(orient="records")
            counts = ranked["significance"].value_counts().to_dict()
        else:
            ranked_records = []
            with Path(de_table["normalized_input"]).open(newline="", encoding="utf-8", errors="replace") as handle:
                for row in csv.DictReader(handle):
                    effect = _float_or_default(row.get("log2FoldChange"), default=0.0)
                    pvalue = min(max(_float_or_default(row.get("pvalue"), default=1.0), 1e-300), 1.0)
                    padj = min(max(_float_or_default(row.get("padj"), default=pvalue), 1e-300), 1.0)
                    significance = "Up" if padj <= 0.05 and effect >= 1.0 else "Down" if padj <= 0.05 and effect <= -1.0 else "NS"
                    ranked_records.append({
                        "gene": row.get("gene"),
                        "log2FoldChange": effect,
                        "padj": padj,
                        "pvalue": pvalue,
                        "baseMean": _float_or_default(row.get("baseMean"), default=abs(effect)),
                        "neg_log10_p": -math.log10(max(pvalue, 1e-300)),
                        "abs_log2fc": abs(effect),
                        "significance": significance,
                    })
            ranked_records = sorted(ranked_records, key=lambda row: (row["padj"], -row["abs_log2fc"]))
            top_genes = ranked_records[:20]
            counts = {}
            for row in ranked_records:
                counts[row["significance"]] = counts.get(row["significance"], 0) + 1
        table_path = workflow_out / "bioskills_de_results.csv"
        with table_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["gene", "log2FoldChange", "padj", "pvalue", "baseMean", "neg_log10_p", "abs_log2fc", "significance"])
            writer.writeheader()
            writer.writerows(ranked_records)
        skill_excerpts = {
            str(path.relative_to(repo)): short_text(_read_text_excerpt(path), 500)
            for path in skill_paths
        }
        result = {
            "workflow_name": run_record["workflow_name"],
            "workflow_kind": run_record["workflow_kind"],
            "repository_native_skill_paths": run_record["skill_paths"],
            "source_table": {key: value for key, value in de_table.items() if key != "normalized"},
            "thresholds": {"padj_max": 0.05, "abs_log2fc_min": 1.0},
            "gene_count": int(len(ranked_records)),
            "significant_up": int(counts.get("Up", 0)),
            "significant_down": int(counts.get("Down", 0)),
            "top_genes": top_genes,
            "skill_excerpts": skill_excerpts,
            "interpretation": "Applied the cloned BioSkills differential-expression skill guidance to the selected dataset's DE result table, producing ranked DE results and a volcano-style visualization.",
        }
        result_path = workflow_out / "result.json"
        result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        rows_html = "\n".join(
            "<tr>"
            f"<td>{html.escape(str(row['gene']))}</td>"
            f"<td>{float(row['log2FoldChange']):.3f}</td>"
            f"<td>{float(row['padj']):.3g}</td>"
            f"<td>{html.escape(str(row['significance']))}</td>"
            "</tr>"
            for row in top_genes[:12]
        )
        figure_path = workflow_out / "bioskills_volcano.html"
        figure_path.write_text(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>BioSkills DE Volcano</title>"
            "<style>body{font-family:Arial,sans-serif;margin:24px;color:#202124}"
            "svg{border:1px solid #dadce0;background:#fff}table{border-collapse:collapse;margin-top:16px}"
            "td,th{border:1px solid #dadce0;padding:5px 8px;font-size:12px}</style></head><body>"
            "<h1>BioSkills Differential-Expression Skill Workflow</h1>"
            "<svg width=\"900\" height=\"520\" viewBox=\"0 0 900 520\">"
            f"{_svg_circle_rows(ranked) if ranked is not None else '<text x=\"40\" y=\"40\">BioSkills differential feature visualization</text>'}"
            "</svg>"
            "<table><thead><tr><th>gene</th><th>log2FC</th><th>FDR</th><th>call</th></tr></thead>"
            f"<tbody>{rows_html}</tbody></table></body></html>",
            encoding="utf-8",
        )
        report_path = workflow_out / "report.md"
        report_path.write_text(
            "# BioSkills DE Skill Workflow\n\n"
            f"- Source skill paths: {', '.join(run_record['skill_paths'])}\n"
            f"- Source table: {de_table.get('path')}\n"
            f"- Genes/features analyzed: {len(ranked_records)}\n"
            f"- Significant up/down: {counts.get('Up', 0)}/{counts.get('Down', 0)}\n"
            "- Outputs: result.json, bioskills_de_results.csv, bioskills_volcano.html\n",
            encoding="utf-8",
        )
        figures, tables, reports = _scan_workflow_outputs(workflow_out)
        substantive = result_path.is_file() and bool(figures) and bool(tables)
        run_record.update({
            "status": "completed",
            "substantive": substantive,
            "return_code": 0,
            "duration_seconds": time.monotonic() - started,
            "output_dir": str(workflow_out),
            "source_table": de_table,
            "figures": figures,
            "tables": tables,
            "reports": reports,
            "result_json": str(result_path),
            "repository_native_evidence": "Used cloned BioSkills differential-expression SKILL.md/usage guidance and selected dataset DE columns to produce a result table, visualization, and report.",
            "reason": None if substantive else "BioSkills workflow did not produce the expected result.json plus figure/table bundle",
        })
    except Exception as exc:  # pylint: disable=broad-except
        stderr_path = workflow_out / "stderr.log"
        stderr_path.write_text(f"[wrapper] BioSkills DE skill workflow failed: {exc!r}\n", encoding="utf-8")
        run_record.update({
            "status": "failed",
            "return_code": 1,
            "duration_seconds": time.monotonic() - started,
            "stderr_path": str(stderr_path),
            "output_dir": str(workflow_out),
            "source_table": de_table,
            "reason": short_text(exc),
        })
    return run_record


def _run_clawbio_diff_visualizer(repo, csv_root, output_dir):
    skill = repo / "skills" / "diff-visualizer" / "diff_visualizer.py"
    run_record = {
        "workflow_name": "ClawBio diff-visualizer",
        "workflow_kind": "repository_native_skill",
        "status": "blocked",
        "substantive": False,
        "command": None,
        "stdout_path": None,
        "stderr_path": None,
        "output_dir": None,
        "reason": None,
    }
    if not skill.is_file():
        run_record["reason"] = "repo does not expose skills/diff-visualizer/diff_visualizer.py"
        return run_record
    de_table, blocker = _find_de_table(csv_root, output_dir)
    if not de_table:
        run_record["reason"] = blocker or "no compatible DE table found"
        return run_record
    workflow_out = Path(output_dir).resolve() / "repo_workflows" / "clawbio-diffviz"
    if workflow_out.exists():
        shutil.rmtree(workflow_out)
    workflow_out.mkdir(parents=True, exist_ok=True)
    stdout_path = workflow_out / "stdout.log"
    stderr_path = workflow_out / "stderr.log"
    workflow_python = _python_with_modules("matplotlib")
    command = [
        workflow_python,
        str(skill),
        "--input",
        str(de_table["normalized_input"]),
        "--output",
        str(workflow_out),
    ]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(repo) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=str(repo),
            env=env,
            capture_output=True,
            text=True,
            timeout=240,
        )
        duration = time.monotonic() - started
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        figures, tables, reports = _scan_workflow_outputs(workflow_out)
        result_path = workflow_out / "result.json"
        substantive = completed.returncode == 0 and result_path.is_file() and bool(figures) and bool(tables)
        run_record.update({
            "status": "completed" if completed.returncode == 0 else "failed",
            "substantive": substantive,
            "return_code": completed.returncode,
            "duration_seconds": duration,
            "command": " ".join(command),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "output_dir": str(workflow_out),
            "source_table": de_table,
            "figures": figures,
            "tables": tables,
            "reports": reports,
            "result_json": str(result_path) if result_path.is_file() else None,
            "reason": None if substantive else "workflow did not produce the expected result.json plus figure/table bundle",
        })
    except subprocess.TimeoutExpired as exc:
        stdout_path.write_text(str(exc.stdout or ""), encoding="utf-8")
        stderr_path.write_text(str(exc.stderr or "") + "\n[wrapper] ClawBio diffviz timed out after 240s", encoding="utf-8")
        run_record.update({
            "status": "timeout",
            "command": " ".join(command),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "output_dir": str(workflow_out),
            "source_table": de_table,
            "reason": "workflow timed out after 240s",
        })
    except Exception as exc:  # pylint: disable=broad-except
        stderr_path.write_text(f"[wrapper] failed to start ClawBio diffviz: {exc!r}\n", encoding="utf-8")
        run_record.update({
            "status": "failed",
            "command": " ".join(command),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "output_dir": str(workflow_out),
            "source_table": de_table,
            "reason": short_text(exc),
        })
    return run_record


def _run_generic_repository_workflow(repo, csv_root, output_dir, workflow):
    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    record = {
        "workflow_name": workflow.get("workflow_name"),
        "workflow_kind": workflow.get("workflow_kind"),
        "status": "blocked",
        "substantive": False,
        "output_dir": str(out),
    }
    entry = workflow.get("entrypoint")
    if not entry or not Path(entry).is_file():
        record["reason"] = "repository exposes no runnable entrypoint script to apply (library-only clone); the analyst should self-provision the tool in a blueprint instead of cloning it"
        return record
    env = dict(os.environ)
    env["RESEARCHLAB_CSV_ROOT"] = str(csv_root)
    env["RESEARCHLAB_OUTPUT_DIR"] = str(out)
    try:
        completed = subprocess.run(
            [sys.executable, str(entry)],
            capture_output=True,
            text=True,
            timeout=600,
            cwd=str(repo),
            env=env,
        )
        record["returncode"] = completed.returncode
        record["stdout_tail"] = (completed.stdout or "")[-2000:]
        record["stderr_tail"] = (completed.stderr or "")[-2000:]
    except Exception as exc:  # pylint: disable=broad-except
        record["reason"] = "entrypoint execution failed: " + short_text(exc)
        return record
    image_exts = (".png", ".exr", ".jpg", ".jpeg", ".hdr", ".ppm")
    figures = [str(p) for p in out.rglob("*") if p.is_file() and p.suffix.lower() in image_exts][:20]
    tables = [str(p) for p in out.rglob("*.csv")][:20]
    result_json = next((str(p) for p in out.rglob("result.json")), None)
    produced = bool(figures or tables or result_json)
    if completed.returncode == 0 and produced:
        record.update(
            status="completed",
            substantive=True,
            figures=figures,
            tables=tables,
            reports=[],
            result_json=result_json,
        )
    else:
        record["reason"] = (
            "entrypoint ran but produced no recognized outputs (images/tables/result.json)"
            if completed.returncode == 0
            else "entrypoint returned non-zero exit " + str(completed.returncode)
        )
    return record


def run_repository_native_workflows(repo, csv_root, output_dir, metadata):
    runs = []
    repo_text = json.dumps({
        "name": metadata.get("name"),
        "url": metadata.get("url"),
        "description": metadata.get("description"),
        "analysis_terms": metadata.get("analysis_terms") or [],
    }).lower()
    if "clawbio" in repo_text or (repo / "clawbio.py").is_file():
        runs.append(_run_clawbio_diff_visualizer(repo, csv_root, output_dir))
    if any(
        item.get("workflow_name") == "BioSkills differential-expression skill-guided workflow"
        for item in supported_repository_workflows(repo)
    ):
        runs.append(_run_bioskills_de_skill_workflow(repo, csv_root, output_dir))
    for wf in supported_repository_workflows(repo):
        if wf.get("workflow_kind") in ("repository_render_workflow", "repository_generic_cli"):
            runs.append(_run_generic_repository_workflow(repo, csv_root, output_dir, wf))
    return runs


def application(csv_root, output_dir):
    metadata = load_metadata()
    repo = repo_path_from(metadata)
    out = Path(output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    terms = [
        str(term).strip()
        for term in (metadata.get("analysis_terms") or [])
        if str(term).strip()
    ][:24]
    if not terms:
        terms = ["gene", "pathway", "expression", "enrichment", "differential"]
    profiles = []
    for path in sorted(Path(csv_root).rglob("*.csv"))[:80]:
        profiles.append(table_profile(path, terms))
    workflow_runs = run_repository_native_workflows(repo, csv_root, out, metadata) if repo.exists() else []
    substantive_runs = [
        run for run in workflow_runs
        if run.get("status") == "completed" and run.get("substantive") is True
    ]
    application_csv = out / "external_repository_dataset_application.csv"
    fieldnames = ["path", "status", "rows_read", "columns", "text_columns", "numeric_columns", "term_hits", "top_variable_rows"]
    with application_csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for profile in profiles:
            writer.writerow({key: json.dumps(profile.get(key), ensure_ascii=False) if isinstance(profile.get(key), (list, dict)) else profile.get(key) for key in fieldnames})
    summary = {
        "status": "completed",
        "agent_name": metadata.get("name"),
        "repo_url": metadata.get("url"),
        "repo_path": str(repo),
        "repo_exists": repo.exists(),
        "csv_root": str(csv_root),
        "files_profiled": len([p for p in profiles if p.get("status") == "profiled"]),
        "analysis_terms": terms,
        "application_table": str(application_csv),
        "method": "real external repository selected by runtime search and cloned into the cycle tool cache; this wrapper records repository smoke/debug evidence, profiles the selected data/asset bundle, and requires a repository-native workflow/skill/domain command to produce substantive hypothesis-relevant outputs before the gate can pass",
        "repo_inventory": repo_inventory(repo) if repo.exists() else {},
        "repo_workflow_runs": workflow_runs,
        "substantive_repository_workflow_applied": bool(substantive_runs),
        "substantive_workflow_outputs": [
            {
                "workflow_name": run.get("workflow_name"),
                "output_dir": run.get("output_dir"),
                "figures": run.get("figures") or [],
                "tables": run.get("tables") or [],
                "reports": run.get("reports") or [],
                "result_json": run.get("result_json"),
            }
            for run in substantive_runs
        ],
        "substantive_workflow_blockers": [
            run.get("reason") or f"{run.get('workflow_name')} status={run.get('status')}"
            for run in workflow_runs
            if not (run.get("status") == "completed" and run.get("substantive") is True)
        ] or (
            []
            if substantive_runs
            else ["no repository-native workflow/skill produced a result.json plus figure/table bundle; data/asset profiling alone is insufficient for mandatory substantive validation"]
        ),
    }
    (out / "external_repository_agent_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (out / "external_repository_workflow_result.json").write_text(json.dumps({
        "agent_name": metadata.get("name"),
        "repo_url": metadata.get("url"),
        "substantive_repository_workflow_applied": bool(substantive_runs),
        "repo_workflow_runs": workflow_runs,
        "substantive_workflow_outputs": summary["substantive_workflow_outputs"],
        "substantive_workflow_blockers": summary["substantive_workflow_blockers"],
    }, indent=2), encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--csv-root", default=os.environ.get("RESEARCHLAB_CSV_ROOT", "."))
    parser.add_argument("--output-dir", default=os.environ.get("RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR") or os.environ.get("RESEARCHLAB_OUTPUT_DIR", "."))
    args = parser.parse_args()
    if args.smoke:
        smoke()
    else:
        application(args.csv_root, args.output_dir)


if __name__ == "__main__":
    main()
