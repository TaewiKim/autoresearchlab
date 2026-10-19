from __future__ import annotations

import argparse
import base64
import bz2
import gzip
import importlib.util
import csv
import json
import lzma
import math
import os
import re
import subprocess
import sys
import time
import traceback
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .execution_model import BlueprintExecution


def _aggregate_correlations(executions: Iterable[BlueprintExecution]) -> Dict[str, float]:
    """Collect correlation pairs reported in blueprint metrics.

    Convention (domain-agnostic): a blueprint emits a dict like
    ``{"correlations": {"<exposure>_vs_<outcome>": 0.42, ...}}`` on stdout.
    The chronicle module iterates this dict generically.
    """

    out: Dict[str, float] = {}
    for execution in executions:
        metrics = execution.metrics or {}
        correlations = metrics.get("correlations")
        if isinstance(correlations, dict):
            for key, value in correlations.items():
                if not isinstance(key, str):
                    continue
                try:
                    numeric = float(value)
                except (TypeError, ValueError):
                    continue
                out[key] = numeric
    return out


# Substrings that mean "the thing under test never actually ran". The most
# damaging real case: a cycle proposes a novel Mitsuba integrator, the blueprint
# does ``load_dict({"integrator": {"type": "h_rps"}})``, Mitsuba raises
# ``Plugin "h_rps" not found``, and every downstream metric degenerates to
# inf/0 — yet the lane still reported ``completed``.
_UNRUNNABLE_NOTE_MARKERS = (
    "not found",
    "unknown plugin",
    "failed to instantiate",
    "native_available=false",
)


def _unrunnable_method_names(execution: BlueprintExecution) -> List[str]:
    """Names of methods/plugins this execution could not instantiate.

    The blueprint already probes the proposed method (``load_dict({"type":
    "h_rps"})``) and catches the failure, but it then keeps going and emits
    degenerate inf/0 metrics, and the reason survives only as prose inside
    ``metrics.notes``. Nothing machine-readable meant the planner happily
    re-dispatched the same unimplementable check 22 times in v63. Surfacing the
    name lets upstream mark the hypothesis "implementation required" instead of
    paying for the same impossible validation again.
    """

    metrics = execution.metrics or {}
    notes = str(metrics.get("notes", ""))
    names: List[str] = []
    # Mitsuba: 'failed to instantiate unknown plugin of type "h_rps"' /
    #          'Plugin "h_rps" not found!'
    for marker in ('unknown plugin of type "', 'Plugin "'):
        start = 0
        while True:
            index = notes.find(marker, start)
            if index < 0:
                break
            rest = notes[index + len(marker):]
            end = rest.find('"')
            if end > 0:
                candidate = rest[:end].strip()
                if candidate and candidate not in names:
                    names.append(candidate)
            start = index + len(marker)
    return names


def _aggregate_unrunnable_methods(
    executions: Iterable[BlueprintExecution],
) -> List[str]:
    """Every method the lane tried and could not instantiate, de-duplicated."""

    out: List[str] = []
    for execution in executions:
        for name in _unrunnable_method_names(execution):
            if name not in out:
                out.append(name)
    return out


def _execution_produced_evidence(execution: BlueprintExecution) -> bool:
    """True when this blueprint execution emitted a genuine quantitative signal."""

    if execution.status != "completed":
        return False
    metrics = execution.metrics or {}
    if str(metrics.get("pass_fail", "")).strip().lower() == "fail":
        # A hypothesis falsified with emitted tables and finite numbers IS
        # evidence -- often the strongest kind. Only an unbacked "fail" is not.
        return _execution_is_clean_falsification(execution)
    return _execution_has_finite_signal(execution)


def _execution_is_clean_falsification(execution: BlueprintExecution) -> bool:
    """True when ``pass_fail="fail"`` is a SCIENTIFIC verdict, not an execution failure.

    The analyst standard asks for exactly this distinction -- "a clean scientific
    fail is resolved evidence; ambiguous or incomplete output is not" -- and sets
    ``require_all_handoff_checks_pass=false`` to permit it. The driver never made
    it: any ``pass_fail="fail"`` counted as a blueprint FAILURE. Measured on v85
    (2026-08-26): followup-runner-06/08/09 exited 0 after 855s of real Mitsuba,
    emitted six CSVs plus a figure, correctly falsified their own joint-signal
    hypothesis at Wilcoxon p=8.7e-17 against uniform -- and were stamped
    ``status: failed``. The Gatekeeper then wrote "the cited primary follow-up
    artifact failed", scoring the label instead of the science, and three further
    lanes died looking for tables those "failed" lanes had in fact written.

    Deliberately narrow so the v63 regression cannot return: a blueprint that
    could not instantiate its method (``Plugin "h_rps" not found``) emits no
    tables and inf/0 metrics, so it fails the clauses below and stays a failure.
    """

    if execution.status != "completed":
        return False
    if execution.return_code not in (0, None):
        return False
    if execution.error:
        return False
    if _unrunnable_method_names(execution):
        return False
    metrics = execution.metrics or {}
    notes = str(metrics.get("notes", "")).lower()
    if any(marker in notes for marker in _UNRUNNABLE_NOTE_MARKERS):
        return False
    if "=inf" in notes.replace(" ", ""):
        return False
    # A verdict with nothing underneath it is "incomplete", not "clean": require
    # a real emitted table AND at least one finite measured number.
    if not (execution.tables or []):
        return False
    # The blueprint contract asks a falsifying run to SAY SO, and
    # `_execution_resolution` already accepts the label. Honour it here too: v86
    # emitted `resolution_status: "valid_falsification"` on four runs that the
    # resolution layer marked resolved and this function still called failures.
    # Checked after the crash/timeout/unrunnable/inf clauses above, so a broken
    # run cannot self-certify with a label.
    if _metric_declares_valid_falsification(execution.metrics or {}):
        return True
    return _execution_has_finite_signal(execution)


# Kept beside _execution_resolution's accepted set on purpose: the two must agree
# about what a blueprint is allowed to call a falsification.
_DECLARED_FALSIFICATION_STATUSES = frozenset(
    {"resolved", "valid_falsification", "valid_negative", "not_supported_by_data"}
)


def _metric_declares_valid_falsification(metrics: Dict[str, Any]) -> bool:
    """Did the blueprint itself label this a falsification, as the contract asks?"""
    status = str(
        (metrics or {}).get("resolution_status")
        or (metrics or {}).get("check_resolution")
        or (metrics or {}).get("scientific_resolution")
        or ""
    ).strip().lower()
    if status in _DECLARED_FALSIFICATION_STATUSES:
        return True
    for key in ("valid_falsification_result", "valid_negative_result"):
        if (metrics or {}).get(key) is True:
            return True
    return False


def _execution_has_finite_signal(execution: BlueprintExecution) -> bool:
    """True when the execution left at least one real, finite number behind.

    Split out of :func:`_execution_produced_evidence` so a falsified-but-measured
    run can be asked "did you actually measure anything?" without first being
    rejected for having reported ``pass_fail="fail"``.
    """

    metrics = execution.metrics or {}
    correlations = metrics.get("correlations")
    if isinstance(correlations, dict):
        for value in correlations.values():
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                continue
            if numeric == numeric and numeric not in (float("inf"), float("-inf")):
                return True
    checks_passed = metrics.get("checks_passed_count")
    try:
        if float(checks_passed) > 0:
            return True
    except (TypeError, ValueError):
        pass
    # Boolean check map. A blueprint that renders and then reports
    # {"adaptive_beats_uniform": true, "hypothesis_supported": true, ...} has
    # produced real evidence even though it never filled `correlations` or
    # `checks_passed_count`. Measured on v70: 24 executions carried 11 passing
    # checks each (plus PSNR/SSIM per-seed tables and figures) and were still
    # counted as "no numbers", so the soundness floor scored the cycle as
    # evidence-free.
    if _passed_check_count(metrics) > 0:
        return True
    # Nested numeric payload: many blueprints put their real measurements under
    # metrics.metrics (per_seed / summary rows carrying psnr, ssim, gains).
    if _nested_numeric_signal(metrics.get("metrics")):
        return True
    # Top-level numeric metrics. v86's conformal runs reported
    # matched_width_wilcoxon_p=0.03125, rich_coverage_across_seed_std and six
    # more as plain keys on `metrics`; every source above came back empty and the
    # run read as unmeasured. A falsification's boolean checks are all False by
    # definition, so this is precisely when the other sources go quiet.
    for key, value in metrics.items():
        if key in _MEASUREMENT_WRAPPER_KEYS or key in ("pass_fail", "resolution_status"):
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if value == value and value not in (float("inf"), float("-inf")):
            return True
    return _primary_contrast_table_has_estimate(execution)


# The table an analysis contract measures into (src/policy/analysis_contract.js
# asks every contract-bound blueprint for it).
PRIMARY_CONTRAST_TABLE = "primary_contrasts.csv"


def _primary_contrast_table_has_estimate(execution: BlueprintExecution) -> bool:
    """True when the emitted primary contrast table holds a finite estimate.

    MEASURED ON cycle-a-20260919, 2026-10-18: runners 459-473 each
    wrote the contract's primary_contrasts.csv with four finite estimates and
    simultaneous bounds (0.8992 [0.1585, ...] every time), and the contract
    verifier called them verified -- but their metrics carried only pass_fail
    and notes, so every one was stamped no_measurement_produced, and the next
    analyst was asked for the measurement again.
    """

    for table in execution.tables or []:
        if not isinstance(table, dict) or table.get("name") != PRIMARY_CONTRAST_TABLE:
            continue
        try:
            with open(table.get("path") or "", newline="", encoding="utf-8") as handle:
                for row in csv.DictReader(handle):
                    try:
                        value = float(row.get("estimate") or "")
                    except (TypeError, ValueError):
                        continue
                    if math.isfinite(value):
                        return True
        except OSError:
            continue
    return False


def _passed_check_count(metrics: Dict[str, Any]) -> int:
    """How many boolean checks the execution reports as passing."""

    checks = (metrics or {}).get("checks")
    if not isinstance(checks, dict):
        return 0
    return sum(1 for value in checks.values() if value is True)


def _nested_numeric_signal(payload: Any, _depth: int = 0) -> bool:
    """True when a nested metrics payload holds at least one finite measurement.

    Walks the small nested structures blueprints emit (``per_seed`` /
    ``summary`` lists of dicts) looking for a real number, ignoring the
    bookkeeping scalars that describe the run rather than its outcome.
    """

    if _depth > 4:
        return False
    bookkeeping = {
        "seed",
        "seeds",
        "levels",
        "budget_spp",
        "matched_budget_spp",
        "reference_spp",
        "spp",
        "n",
        "count",
        "index",
    }
    if isinstance(payload, dict):
        for key, value in payload.items():
            if str(key).strip().lower() in bookkeeping:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                numeric = float(value)
                if numeric == numeric and numeric not in (float("inf"), float("-inf")):
                    return True
            elif _nested_numeric_signal(value, _depth + 1):
                return True
        return False
    if isinstance(payload, (list, tuple)):
        for item in payload[:20]:
            if _nested_numeric_signal(item, _depth + 1):
                return True
    return False


# Every number a blueprint measures used to stop at its own artifact directory.
#
# WHAT THIS COSTS (measured on cycle-g-v74). lab-runner-04 rendered 2 scenes x 5
# seeds at a matched 24 spp against a 256-spp reference and wrote real numbers:
# +0.84 dB PSNR for adaptive over uniform on the high-variance scene, -0.19 dB on
# the low-variance one — a clean falsification boundary. `validation-summary.json`
# for that same run contains the string "psnr" ZERO times. What travelled to the
# LabDirector and the gate was `blueprints 1/1, checks 13/13, accuracy 94`: pure
# workflow bookkeeping. The gatekeeper then wrote, correctly, that it had been
# given "only a 13/13 workflow/check result with no rendering estimate", and
# scored technical_quality 12 / reproducibility 15.
#
# So the gate could not compare the claim to its evidence because the evidence had
# been reduced to a pass count before it arrived, and the director could not scope
# a claim down to a result it was never shown. Both fixes above depend on this one.
#
# Deliberately domain-blind: it does not know what PSNR is, and no key list decides
# what counts as a measurement. It carries through whatever the blueprint itself
# reported under `metrics`, bounded so a large payload cannot flood the summary.
_MEASUREMENT_DEPTH_LIMIT = 5
_MEASUREMENT_LIST_LIMIT = 12
_MEASUREMENT_FIELD_LIMIT = 32
_MEASUREMENT_STRING_LIMIT = 160
_MEASUREMENT_CHECK_LIMIT = 8


def _compact_measurements(payload: Any, _depth: int = 0) -> Any:
    """Shrink a reported measurement payload without discarding its numbers."""

    if _depth > _MEASUREMENT_DEPTH_LIMIT:
        return None
    if payload is None:
        return None
    if isinstance(payload, bool):
        return payload
    if isinstance(payload, (int, float)):
        numeric = float(payload)
        if numeric != numeric or numeric in (float("inf"), float("-inf")):
            return None
        return payload
    if isinstance(payload, str):
        text = payload.strip()
        return text[:_MEASUREMENT_STRING_LIMIT] or None
    if isinstance(payload, dict):
        compacted: Dict[str, Any] = {}
        for key, value in list(payload.items())[:_MEASUREMENT_FIELD_LIMIT]:
            child = _compact_measurements(value, _depth + 1)
            if child is None or child == {} or child == []:
                continue
            compacted[str(key)] = child
        return compacted or None
    if isinstance(payload, (list, tuple)):
        compacted_items = []
        for item in payload[:_MEASUREMENT_LIST_LIMIT]:
            child = _compact_measurements(item, _depth + 1)
            if child is None or child == {} or child == []:
                continue
            compacted_items.append(child)
        return compacted_items or None
    return None


# Wrappers that describe the run rather than measure anything. Everything else
# in the payload is carried, whatever the blueprint chose to call it.
#
# Reading a single named field was the first version's mistake, and it was the
# same mistake as the ones this commit series keeps fixing: it looked for
# `metrics["metrics"]`, the shape one blueprint on cycle-g-v74 happened to use,
# and every blueprint reporting under `correlations` came through with
# measured_quantities=[] -- 39 of 40 runners. No enumeration of field names can
# be right for payloads this driver does not author.
_MEASUREMENT_WRAPPER_KEYS = frozenset({"check_id", "checks", "status", "figures", "tables"})
# Columns that, when they carry two or more distinct values, are DIRECT evidence
# of the axis -- not a word that happened to appear in a prose note.
_SEED_COLUMN_NAMES = (
    "seed", "seed_id", "seed_value", "rng_seed", "random_seed", "sample_seed",
    "eval_seed", "evaluation_seed", "training_seed", "train_seed",
    "checkpoint_lineage", "independent_checkpoint_lineage",
)
_ARM_COLUMN_NAMES = (
    "method", "arm", "variant", "condition", "algorithm", "policy",
    "treatment", "estimator", "approach", "strategy",
    "policy_class", "loss_family", "refinement_steps",
)
_RIGOR_TABLE_MAX_FILES = 12
_RIGOR_TABLE_MAX_BYTES = 32 * 1024 * 1024
_RIGOR_TABLE_MAX_ROWS = 50000


def _table_rigor_evidence(executions) -> Dict[str, Any]:
    """Reproducibility signals read out of the CSVs the blueprints actually wrote.

    ``_rigor_profile`` used to judge a run from ``json.dumps(_measured_quantities(...))``
    alone. That blob truncates ``metrics.notes`` at ~200 characters, so which
    signals were "found" depended on where in the note they happened to fall.
    Measured on cycle-g-v85 followup-runner-08: the profile reported
    ``multi_seed: false, comparator: false`` for a run whose
    ``allocation_results_per_seed.csv`` holds 540 rows across five pinned seeds
    (851-855) and three arms (uniform / aov_only / joint), because
    ``"seeds": [851, ...]`` sat past the cut while ``std_rmse_gain`` sat before it.
    That understatement feeds the reproducibility rubric -- the one axis v85 had
    not beaten.

    An emitted column with two or more distinct values is strictly stronger
    evidence than a word in a note, so this only ever ADDS signal; it never
    clears one the measured quantities already established. Best-effort by
    construction: any unreadable table is skipped rather than raising, because an
    understated profile is a smaller harm than a driver that dies at summary time.
    """

    evidence: Dict[str, Any] = {"tables_scanned": 0, "header_columns": []}
    seen_headers: List[str] = []
    files = 0
    for execution in executions or []:
        for table in (getattr(execution, "tables", None) or []):
            if files >= _RIGOR_TABLE_MAX_FILES:
                break
            path = (table or {}).get("path")
            suffix = str((table or {}).get("suffix") or "").lower()
            if not path or suffix not in (".csv", ".tsv"):
                continue
            try:
                if os.path.getsize(path) > _RIGOR_TABLE_MAX_BYTES:
                    continue
                delimiter = "\t" if suffix == ".tsv" else ","
                with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
                    reader = csv.reader(handle, delimiter=delimiter)
                    header = next(reader, None)
                    if not header:
                        continue
                    files += 1
                    evidence["tables_scanned"] = files
                    lowered = [str(c).strip().lower() for c in header]
                    seen_headers.extend(lowered)
                    wanted = {}
                    seed_columns = {index: column for index, column in enumerate(lowered)
                                    if column in _SEED_COLUMN_NAMES or column == "analysis_seed"}
                    for axis, names in (("multi_seed", _SEED_COLUMN_NAMES),
                                        ("comparator", _ARM_COLUMN_NAMES)):
                        if axis in evidence:
                            continue
                        for index, column in enumerate(lowered):
                            if column in names:
                                wanted[axis] = (index, column)
                                break
                    if not wanted and not seed_columns:
                        continue
                    distinct = {axis: set() for axis in wanted}
                    seed_values = {column: set() for column in seed_columns.values()}
                    for row_index, row in enumerate(reader):
                        if row_index >= _RIGOR_TABLE_MAX_ROWS:
                            break
                        for axis, (index, _name) in wanted.items():
                            if index < len(row):
                                value = str(row[index]).strip()
                                if value:
                                    distinct[axis].add(value)
                        for index, column in seed_columns.items():
                            if index < len(row) and str(row[index]).strip():
                                seed_values[column].add(str(row[index]).strip())
                    for column, values in seed_values.items():
                        dimensions = evidence.setdefault("seed_dimensions", {})
                        if len(values) > dimensions.get(column, {}).get("distinct_values", 0):
                            dimensions[column] = {
                                "distinct_values": len(values),
                                "table": (table or {}).get("name") or os.path.basename(path),
                            }
                    for axis, (_index, name) in wanted.items():
                        values = distinct[axis]
                        if len(values) >= 2:
                            entry = {
                                "column": name,
                                "distinct_values": len(values),
                                "table": (table or {}).get("name") or os.path.basename(path),
                            }
                            if axis == "comparator":
                                entry["arms"] = sorted(values)[:8]
                            evidence[axis] = entry
            except (OSError, UnicodeDecodeError, csv.Error, ValueError) as exc:
                # Only what an unreadable/malformed table can actually raise. A
                # bare `except Exception` here hid a NameError (csv unimported in
                # the flat parts layout) and returned the very understatement this
                # function exists to prevent -- silently, with tables_scanned=0.
                evidence.setdefault("skipped_tables", []).append(
                    {"table": os.path.basename(str(path)), "reason": type(exc).__name__}
                )
                continue
    evidence["header_columns"] = sorted(set(seen_headers))[:_MEASUREMENT_FIELD_LIMIT]
    return evidence


def _measured_quantities(executions: List[BlueprintExecution]) -> List[Dict[str, Any]]:
    """The measurements each blueprint reported, carried up to the summary."""

    measured: List[Dict[str, Any]] = []
    for execution in executions or []:
        if execution.status != "completed":
            continue
        metrics = execution.metrics or {}
        payload = {
            key: value for key, value in metrics.items() if key not in _MEASUREMENT_WRAPPER_KEYS
        }
        # Carrying the whole payload means the status/notes of a run that measured
        # NOTHING would otherwise travel as if it were evidence -- the v63 shape,
        # where every metric was inf and the only survivors were `pass_fail: fail`
        # and an error note. Require at least one finite number before reporting.
        if not _nested_numeric_signal(payload):
            continue
        quantities = _compact_measurements(payload)
        if not quantities:
            continue
        entry: Dict[str, Any] = {
            "check_id": execution.check_id or metrics.get("check_id"),
            "blueprint_id": execution.blueprint_id,
            "quantities": quantities,
        }
        # The blueprint's own boolean verdicts belong with its numbers: a check
        # that reports `adaptive_wins: false` is stating the claim's boundary,
        # which is evidence, not a failure to hide.
        checks = metrics.get("checks")
        if isinstance(checks, dict):
            entry["reported_checks"] = {
                str(key): bool(value)
                for key, value in list(checks.items())[:_MEASUREMENT_FIELD_LIMIT]
                if isinstance(value, bool)
            } or None
        if entry.get("reported_checks") is None:
            entry.pop("reported_checks", None)
        measured.append(entry)
        if len(measured) >= _MEASUREMENT_CHECK_LIMIT:
            break
    return measured


