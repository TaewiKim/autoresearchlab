"""Bind executed primary contrasts to the canonical scientific contract."""
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess


def current_contract(role_plan_file):
    if not role_plan_file:
        return None
    root = Path(role_plan_file).resolve().parents[3]
    cycle = Path(role_plan_file).parent.parent.name
    policy = root / "state" / f"{cycle}-analysis-contract-policy.json"
    if not policy.exists() or not json.loads(policy.read_text()).get("enabled"):
        return None
    script = root.parent / "src/policy/analysis_contract.js"
    process = subprocess.run(["node", str(script), str(root.parent), cycle, "--current"],
                             capture_output=True, text=True, check=True, timeout=30)
    contract = json.loads(process.stdout)
    if not contract:
        raise ValueError("analysis_contract_mismatch: canonical_contract_unavailable")
    return contract


def preflight(handoff, contract, role_plan_file):
    if not contract:
        return None
    checks = handoff.get("handoff_checks") or []
    # The analyst schema writes column_mapping as [{"key", "column"}] pairs
    # (blueprint_model._column_mapping_dict). MEASURED ON
    # cycle-a-20260919, 2026-10-18: analyst-1012's contact-mode audit
    # declared analysis_evidence_role=supporting that way and was read as a
    # primary execution of an already measured contract.
    from .blueprint_model import _column_mapping_dict
    mappings = [_column_mapping_dict(check.get("column_mapping")) for check in checks]
    if checks and all(isinstance(mapping, dict)
                      and mapping.get("analysis_evidence_role") == "supporting" for mapping in mappings):
        return {"contract_id": contract["contract_id"], "status": "supporting", "evidence_role": "supporting"}
    problems = []
    if handoff.get("analysis_contract", {}).get("contract_id") != contract["contract_id"]:
        problems.append("stale_or_missing_handoff_contract")
    if handoff.get("primary_hypothesis_id") != contract["contract_id"]:
        problems.append("primary_hypothesis_id_does_not_match_contract")
    if not any(target.get("claim_text") == contract["statement"] for target in handoff.get("validation_targets", [])):
        problems.append("primary_claim_text_mismatch")
    spec = contract.get("operational_spec")
    if not spec:
        problems.append("operational_spec_missing")
    else:
        expected = spec.get("dataset_sha256")
        paths = [Path(check["dataset"]) for check in checks if check.get("dataset")]
        if not paths or not expected or any(not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected for path in paths):
            problems.append("executed_dataset_hash_mismatch")
    report = {"contract_id": contract["contract_id"], "status": "blocked" if problems else "ready",
              "evidence_role": "primary", "problems": problems}
    if role_plan_file:
        (Path(role_plan_file).parent / "analysis-contract-preflight.json").write_text(json.dumps(report, indent=2))
    if problems:
        raise ValueError("analysis_contract_mismatch: " + ", ".join(problems))
    return report


def _text_registered_gate(contract, gate_id, operator, threshold):
    """Match a gate row to a threshold in the canonical hypothesis."""
    expected_relations = {">=": {"below"}, "<=": {"above", "exceeds"}}.get(operator)
    if not expected_relations:
        return False
    gate_tokens = set(re.findall(r"[a-z0-9]+", str(gate_id).lower()))
    for condition in contract.get("falsification_conditions") or []:
        for match in re.finditer(
                r"(?:^|,|\bif\b|\bor\b)\s*(.*?)\s+(?:is\s+)?(below|above|exceeds)\s+([0-9]+(?:\.[0-9]+)?)",
                str(condition), re.IGNORECASE):
            label, relation, registered = match.groups()
            label_tokens = set(re.findall(r"[a-z0-9]+", label.lower()))
            shared = gate_tokens & label_tokens
            if (relation.lower() in expected_relations
                    and math.isclose(float(registered), threshold)
                    and (len(shared) >= 2 or (len(gate_tokens) <= 2 and shared))):
                return True
    return False


def _is_recorded_invalid_design(run, rows, contract):
    """True only when a completed run documents why estimates cannot exist."""
    metrics = run.metrics or {}
    spec = contract.get("operational_spec") or {}
    estimate_fields = ("estimate", "simultaneous_lower", "simultaneous_upper",
                       "simultaneous_ci_lower", "simultaneous_ci_upper")
    if (getattr(run, "status", None) != "completed"
            # MEASURED ON cycle-a-20260919, 2026-10-17: runner 382
            # used pass for successful execution of its validity audit, while
            # its resolution and every primary row recorded design-invalid.
            # The failed canonical gate below, not that overloaded execution
            # flag, determines whether the scientific result is inconclusive.
            # MEASURED ON cycle-a-20260919, 2026-10-17: runner 424
            # preserved its scientific `fail` verdict after a registered
            # boolean validity predicate failed. The proved invalid-design
            # gate, not this verdict, determines whether blank rows are valid.
            or metrics.get("pass_fail") not in {"inconclusive", "pass", "fail"}
            # MEASURED ON cycle-a-20260919, 2026-10-16: runner 356
            # followed its assignment's not_estimable_design_invalid vocabulary,
            # but the verifier recognized only its older internal spelling.
            # MEASURED ON cycle-a-20260919, 2026-10-19: runner 522
            # wrote design_invalid_registered_gate after proving an exact
            # canonical threshold failure. Resolution prose is not part of the
            # analyst contract; infer invalidity from the canonical blank rows
            # and registered gate evidence checked below, not a spelling list.
            or not str(metrics.get("resolution_status") or "").strip()
            or not rows
            or any(row.get("status") != "not_estimable_design_invalid" for row in rows)
            or any(row.get(field) for row in rows for field in estimate_fields)):
        return False
    gate_tables = [table for table in run.tables if table.get("name") == "validity_gates.csv"]
    if len(gate_tables) != 1:
        return False
    gate_path = gate_tables[0].get("path")
    if not gate_path:
        return False
    try:
        with open(gate_path, newline="", encoding="utf-8") as handle:
            gates = list(csv.DictReader(handle))
        registered = {}
        threshold_specs = {
            **(spec.get("validity_gates") or {}),
            **(spec.get("validity_thresholds") or {}),
        }
        boolean_gates = {key: value for key, value in threshold_specs.items()
                         if isinstance(value, bool)}
        for key, threshold in threshold_specs.items():
            if key.endswith("_min"):
                registered[key] = registered[key[:-4]] = (">=", float(threshold))
            elif key.endswith("_max"):
                registered[key] = registered[key[:-4]] = ("<=", float(threshold))
            # MEASURED ON cycle-a-20260919, 2026-10-17: runner 408
            # proved failures using the exact minimum_*/maximum_* gate IDs
            # registered by the contract, but only *_min/*_max was recognized.
            elif key.startswith("minimum_") and isinstance(threshold, (int, float)):
                registered[key] = (">=", float(threshold))
            elif key.startswith("maximum_") and isinstance(threshold, (int, float)):
                registered[key] = ("<=", float(threshold))
        for gate in gates:
            gate_id = gate.get("gate") or gate.get("gate_id") or gate.get("gate_name")
            # MEASURED ON cycle-a-20260919, 2026-10-17: runner 424
            # proved that the contract's boolean checkpoint-matching predicate
            # was false. Its row spelled the predicate across the gate name and
            # registered-threshold description, but the verifier understood
            # only numeric min/max thresholds and discarded the evidence.
            emitted_tokens = set(re.findall(
                r"[a-z0-9]+", f"{gate_id or ''} {gate.get('registered_threshold', '')}".lower()))
            boolean_matches = [(key, expected) for key, expected in boolean_gates.items()
                               if set(re.findall(r"[a-z0-9]+", key.lower())) <= emitted_tokens]
            observed_text = str(gate.get("observed", gate.get("observed_value", ""))).strip().lower()
            observed_boolean = ({"true": True, "1": True, "false": False, "0": False}
                                .get(observed_text))
            if (len(boolean_matches) == 1
                    and observed_boolean is not None
                    and observed_boolean != boolean_matches[0][1]
                    and str(gate.get("passed", "")).strip().lower() == "false"):
                return True
            operator = gate.get("operator")
            threshold_value = gate.get("threshold")
            # MEASURED ON cycle-a-20260919, 2026-10-17: runner 405
            # emitted the canonical numeric threshold with threshold_direction
            # min/max, so its two failed registered gates were not recognized
            # and its deliberately blank design-invalid estimates were rejected.
            if not operator and threshold_value not in (None, ""):
                operator = {"min": ">=", "max": "<="}.get(
                    str(gate.get("threshold_direction", "")).strip().lower())
            expected = registered.get(gate_id)
            # An exact canonical gate ID and threshold already determine the
            # registered direction; output column names are presentation, not
            # a second protocol for the scientific rule.
            if (not operator and threshold_value not in (None, "") and expected):
                try:
                    if math.isclose(float(threshold_value), expected[1]):
                        operator = expected[0]
                except (TypeError, ValueError):
                    pass
            if not operator or threshold_value in (None, ""):
                # MEASURED ON cycle-a-20260919, 2026-10-16: runner 370's
                # frozen blueprint emitted the registered relation atomically.
                match = re.fullmatch(
                    r"\s*(>=|<=)\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*",
                    gate.get("registered_threshold", ""))
                if not match:
                    continue
                operator, threshold_value = match.groups()
            threshold = float(threshold_value)
            structured_match = expected and operator == expected[0] and math.isclose(threshold, expected[1])
            # Some early registered contracts kept their gates in the
            # authoritative hypothesis's falsification conditions rather than
            # duplicating them in operational_spec. Require the emitted row to
            # match that preregistered text; the output cannot certify itself.
            textual_match = _text_registered_gate(contract, gate_id, operator, threshold)
            if not structured_match and not textual_match:
                continue
            try:
                observed = float(gate.get("observed", gate.get("observed_value")))
            except (TypeError, ValueError):
                # An unmeasurable prerequisite is itself useful audit output,
                # but it must not hide a later, numeric canonical gate failure.
                continue
            if (math.isfinite(observed)
                    and str(gate.get("passed", "")).strip().lower() == "false"
                    and ((operator == ">=" and observed < threshold)
                         or (operator == "<=" and observed > threshold))):
                return True
        return False
    except (OSError, csv.Error, KeyError, TypeError, ValueError):
        return False


def verify_outputs(executions, contract, binding):
    if not binding or binding["evidence_role"] == "supporting":
        return binding
    problems = []
    invalid_design = False
    required = set(contract["operational_spec"].get("required_contrast_ids") or [])
    tables = [table for run in executions for table in run.tables if table.get("name") == "primary_contrasts.csv"]
    if len(tables) != 1:
        problems.append("one_primary_contrast_table_required")
    else:
        with open(tables[0]["path"], newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        if len(rows) != len(required) or {row.get("contrast_id") for row in rows} != required:
            problems.append("primary_contrast_family_mismatch")
        # MEASURED ON cycle-a-20260919, 2026-10-14: the registered
        # predictive-gain contrast used its per-contrast designed-axis comparator
        # and emitted the documented comparator_label column, but was rejected
        # against the global retrieval comparator.
        spec = contract["operational_spec"]
        contrast_comparators = spec.get("contrast_comparators") or {}
        if any((row.get("comparator_label") if "comparator_label" in row else row.get("comparator"))
               != contrast_comparators.get(row.get("contrast_id"), spec["comparator"])
               for row in rows):
            problems.append("primary_comparator_mismatch")
        primary_run = next(run for run in executions if tables[0] in run.tables)
        # MEASURED ON cycle-a-20260919, 2026-10-16: runner 342
        # preserved all 30 contract rows and comparators, then correctly left
        # estimates blank after three preregistered validity gates failed. The
        # verifier called that scientific inconclusive a contract mismatch.
        missing_estimates = any(not all(row.get(field) for field in
                                    ("estimate", "simultaneous_lower", "simultaneous_upper")) for row in rows)
        if missing_estimates:
            invalid_design = _is_recorded_invalid_design(primary_run, rows, contract)
            if not invalid_design:
                problems.append("primary_contrast_estimates_missing")
        elif not missing_estimates:
            try:
                if any(not all(math.isfinite(float(row[field])) for field in ("estimate", "simultaneous_lower", "simultaneous_upper"))
                       or float(row["simultaneous_lower"]) > float(row["simultaneous_upper"]) for row in rows):
                    problems.append("primary_contrast_estimates_invalid")
            except (ValueError, TypeError):
                problems.append("primary_contrast_estimates_invalid")
    if not any(run.metrics.get("analysis_contract_id") == contract["contract_id"] for run in executions):
        problems.append("executed_contract_id_missing")
    spec = contract["operational_spec"]
    if not problems and not invalid_design and spec.get("support_quantifier") == "each learned policy on at least one axis AND at least one policy cross-axis contrast":
        margin = float(spec["margin"])
        supported = lambda row: float(row["simultaneous_lower"]) > margin or float(row["simultaneous_upper"]) < -margin
        equivalent = lambda row: float(row["simultaneous_lower"]) >= -margin and float(row["simultaneous_upper"]) <= margin
        by_id = {row["contrast_id"]: row for row in rows}
        axis_rows = {policy: [by_id[f"{policy}:{axis}"] for axis in spec["axes"]] for policy in spec["policies"]}
        cross_rows = [by_id[f"{policy}:cross_axis"] for policy in spec["policies"]]
        support = all(any(supported(row) for row in group) for group in axis_rows.values()) and any(supported(row) for row in cross_rows)
        falsification = any(all(equivalent(row) for row in group) for group in axis_rows.values()) or all(equivalent(row) for row in cross_rows)
        for run in executions:
            if run.metrics.get("analysis_contract_id") != contract["contract_id"]:
                continue
            reported = run.metrics.get("pass_fail")
            if (reported == "pass" and not support) or (reported == "fail" and not falsification):
                problems.append("scientific_decision_does_not_match_registered_quantifier")
            if reported == "pass" and run.metrics.get("terminal_error_concordance") is not True:
                problems.append("registered_terminal_error_concordance_missing")
            if "minimum_effect_supported" in run.metrics and run.metrics["minimum_effect_supported"] != support:
                problems.append("reported_support_flag_does_not_match_primary_contrasts")
    return {**binding, "status": "mismatch" if problems else "verified", "problems": problems,
            "executed_code_sha256": [hashlib.sha256(Path(run.script_path).read_bytes()).hexdigest()
                                     for run in executions if run.script_path and Path(run.script_path).is_file()]}
