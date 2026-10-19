"""Vetted omics data-loading + master-table helpers (Skills layer).

The analyst's per-cycle blueprints kept re-implementing data loading from
scratch and crashed on real GEO inputs (a bare ``pd.read_csv`` on a series
matrix / file-list manifest), which cascaded into every downstream check
failing and blocked hypothesis promotion. This module is the validated,
reusable implementation the analyst should IMPORT instead of re-deriving —
the omics analog of the DABStep matcher helper.

It is copied next to each blueprint at run time (see _run_blueprint), so a
blueprint can simply::

    import omics_helpers as oh
    matrix, info = oh.load_expression_matrix()        # finds + loads the wide matrix
    groups = oh.infer_sample_groups(matrix.columns)   # e.g. {"HD": [...], "SLE": [...]}
    master = oh.build_master_table(matrix, binary={"control_prefixes": ["HD","CTRL"]})

Encodes only general omics conventions — no hypothesis-, dataset-, or
answer-specific knowledge. pandas-only; .xlsx handled via openpyxl if present.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

# Files that are manifests / file-lists, never the expression matrix itself.
_NON_MATRIX_HINTS = ("filelist", "file_list", "manifest", "readme", "metadata-template", "checksums")
# Comment/banner prefixes used by GEO series-matrix and similar text exports.
_BANNER_PREFIXES = ("!", "#", "^")


def csv_root() -> Path:
    """The dataset csv directory the lab-runner passes via the environment."""
    return Path(os.environ.get("RESEARCHLAB_CSV_ROOT", ".")).resolve()


def load_table(path: str | Path) -> pd.DataFrame:
    """Robustly load one tabular file regardless of delimiter / banner lines.

    Tries, in order: native format by extension, delimiter sniffing with
    comment-line skipping (GEO series-matrix), then a banner-skip retry. Raises
    the last error only if every strategy fails."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext in {".xlsx", ".xls"}:
        return _largest_excel_sheet(path)
    if ext == ".parquet":
        return pd.read_parquet(path)
    attempts = [
        dict(sep=None, engine="python"),
        dict(sep=None, engine="python", comment="!"),
        dict(sep="\t"),
        dict(sep=","),
    ]
    last_err: Optional[Exception] = None
    for kwargs in attempts:
        try:
            df = pd.read_csv(path, **kwargs)
            if df.shape[1] >= 2:
                return df
        except Exception as exc:  # noqa: BLE001
            last_err = exc
    # final attempt: skip leading banner lines explicitly, then sniff
    try:
        skip = _count_banner_lines(path)
        return pd.read_csv(path, sep=None, engine="python", skiprows=skip)
    except Exception as exc:  # noqa: BLE001
        raise (last_err or exc)


def _count_banner_lines(path: Path) -> int:
    n = 0
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.lstrip().startswith(_BANNER_PREFIXES):
                    n += 1
                else:
                    break
    except Exception:  # noqa: BLE001
        return 0
    return n


def _largest_excel_sheet(path: Path) -> pd.DataFrame:
    """Return the sheet with the most cells (the data sheet, not a template)."""
    sheets = pd.read_excel(path, sheet_name=None)
    if not sheets:
        raise ValueError(f"no sheets in {path}")
    best = max(sheets.values(), key=lambda d: d.shape[0] * max(d.shape[1], 1))
    return best


def _looks_like_sample_column(name: Any) -> bool:
    """Heuristic: a sample column header (GSM id or a group_prefixed id)."""
    if not isinstance(name, str):
        return False
    if re.fullmatch(r"GSM\d+", name):
        return True
    # group-prefixed sample ids like SLE_Mod_A0221004 / SLEC_HD_A0221011
    return bool(re.search(r"[A-Za-z]+_[A-Za-z0-9]+_[A-Za-z]?\d{3,}", name))


def _is_matrix_candidate(path: Path) -> bool:
    low = path.name.lower()
    return path.suffix.lower() in {".csv", ".tsv", ".txt", ".xlsx"} and not any(h in low for h in _NON_MATRIX_HINTS)


def find_expression_matrix_path(root: str | Path | None = None) -> Optional[Path]:
    """Pick the wide expression/abundance matrix among the dataset's tables.

    Skips file-list / manifest / template files; ranks the remaining tables by
    how many sample-like columns they expose. Returns None if none qualifies."""
    base = Path(root) if root else csv_root()
    if not base.exists():
        return None
    best: Optional[Tuple[Path, int]] = None
    for path in sorted(base.rglob("*")):
        if not path.is_file() or not _is_matrix_candidate(path):
            continue
        try:
            head = load_table(path)
        except Exception:  # noqa: BLE001
            continue
        sample_cols = sum(1 for c in head.columns if _looks_like_sample_column(c))
        if sample_cols >= 2 and (best is None or sample_cols > best[1]):
            best = (path, sample_cols)
    return best[0] if best else None


def load_expression_matrix(root: str | Path | None = None) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """Load the dataset's wide expression matrix + a small provenance dict.

    Raises a clear error (not a tokenizer crash) when no matrix is present, so
    the blueprint can record an explicit data-unavailable resolution instead of
    crashing."""
    path = find_expression_matrix_path(root)
    if path is None:
        raise FileNotFoundError(
            "no wide expression matrix found under the dataset csv root "
            "(only manifests/file-lists?) — record data_unavailable rather than guessing"
        )
    df = load_table(path)
    sample_cols = [c for c in df.columns if _looks_like_sample_column(c)]
    feature_col = next((c for c in df.columns if c not in sample_cols), df.columns[0])
    info = {
        "matrix_path": str(path),
        "shape": list(df.shape),
        "feature_column": feature_col,
        "sample_columns": sample_cols,
        "n_samples": len(sample_cols),
    }
    return df, info


def infer_sample_groups(sample_columns: List[str]) -> Dict[str, List[str]]:
    """Group sample ids by their leading label token(s).

    GEO group-coded ids commonly look like ``<GROUP>_<sub>_<accession>``
    (e.g. SLEC_HD_..., SLE_Mil_..., SLE_Sev_...). Groups by the first token;
    callers can re-bucket (e.g. control vs disease) with binary_outcome()."""
    groups: Dict[str, List[str]] = {}
    for s in sample_columns:
        if not isinstance(s, str):
            continue
        token = s.split("_", 1)[0] if "_" in s else s
        groups.setdefault(token, []).append(s)
    return groups


def binary_outcome(sample_columns: List[str], control_prefixes: List[str]) -> Dict[str, int]:
    """Map each sample to 0 (control) / 1 (case) by name prefix membership.

    control_prefixes are matched case-insensitively against the sample id's
    leading tokens (e.g. ["HD","CTRL","HC"]). Everything else is a case (1)."""
    cps = tuple(p.lower() for p in control_prefixes)
    out: Dict[str, int] = {}
    for s in sample_columns:
        if not isinstance(s, str):
            continue
        toks = [t.lower() for t in s.split("_")]
        out[s] = 0 if any(t in cps for t in toks) else 1
    return out


def build_master_table(
    matrix: pd.DataFrame,
    *,
    control_prefixes: Optional[List[str]] = None,
    feature_column: Optional[str] = None,
) -> pd.DataFrame:
    """Build the canonical sample-level master table from a wide matrix.

    Rows = samples; columns = sample_id (+ binary_outcome when control_prefixes
    are given). The wide matrix (genes/proteins × samples) stays available to
    the caller for repository/DE workflows, which consume that shape directly."""
    sample_cols = [c for c in matrix.columns if _looks_like_sample_column(c)]
    if feature_column is None:
        feature_column = next((c for c in matrix.columns if c not in sample_cols), None)
    master = pd.DataFrame({"sample_id": sample_cols})
    if control_prefixes:
        bo = binary_outcome(sample_cols, control_prefixes)
        master["binary_outcome"] = master["sample_id"].map(bo)
    return master


def wide_matrix_for_de(matrix: pd.DataFrame, feature_column: Optional[str] = None) -> pd.DataFrame:
    """Return the matrix in the gene/feature-row × sample-column shape that a
    repository differential-expression workflow expects (feature column first).
    """
    sample_cols = [c for c in matrix.columns if _looks_like_sample_column(c)]
    if feature_column is None:
        feature_column = next((c for c in matrix.columns if c not in sample_cols), matrix.columns[0])
    return matrix[[feature_column] + sample_cols]
