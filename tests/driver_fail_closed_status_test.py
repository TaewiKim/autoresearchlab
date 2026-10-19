"""Fail-closed lane status for the python-stats driver.

Regression guard for the silent failure that let v61/v62/v63 each burn a full
review budget: the driver hardcoded ``status="completed"``, so a lane whose
blueprints all died (v63: 22 executions on ``Plugin "h_rps" not found``, every
metric inf/0, pass_fail="fail") still reported success and the gate, watchdog
and self-healing layers never saw it.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "analysis" / "python_stats.py"

_spec = importlib.util.spec_from_file_location("python_stats_under_test", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["python_stats_under_test"] = _mod
_spec.loader.exec_module(_mod)

BlueprintExecution = _mod.BlueprintExecution
_result_status = _mod._result_status


def execution(*, status="completed", metrics=None, error=None):
    return BlueprintExecution(
        blueprint_id="bp_test",
        check_id="check_test",
        status=status,
        script_path=None,
        output_dir="/tmp/out",
        stdout_path="",
        stderr_path="",
        timeout_seconds=60,
        duration_seconds=1.0,
        return_code=0,
        metrics=metrics or {},
        figures=[],
        tables=[],
        error=error,
    )


# The exact shape v63 produced 22 times.
V63_PLUGIN_MISSING = execution(
    metrics={
        "correlations": {},
        "pass_fail": "fail",
        "notes": (
            'native_available=False; native_execution_fraction=0.000; mass_error=inf; '
            'relative_bias=inf; errors=[\'h_rps probe failed: RuntimeError: failed to '
            'instantiate unknown plugin of type "h_rps": Plugin "h_rps" not found!\']'
        ),
    }
)

WORKING = execution(metrics={"correlations": {"a_vs_b": 0.42}, "pass_fail": "pass"})


class FailClosedStatusTest(unittest.TestCase):
    def test_all_blueprints_unrunnable_is_failed(self):
        self.assertEqual(_result_status([V63_PLUGIN_MISSING]), "failed")

    def test_v63_full_shape_many_failures_is_failed(self):
        self.assertEqual(_result_status([V63_PLUGIN_MISSING] * 22), "failed")

    def test_working_blueprint_stays_completed(self):
        self.assertEqual(_result_status([WORKING]), "completed")

    def test_partial_failure_with_real_evidence_is_degraded(self):
        self.assertEqual(_result_status([V63_PLUGIN_MISSING, WORKING]), "degraded")

    def test_crashed_execution_is_failed(self):
        self.assertEqual(
            _result_status([execution(status="failed", error="boom")]), "failed"
        )

    def test_timeout_execution_is_failed(self):
        self.assertEqual(_result_status([execution(status="timeout")]), "failed")

    def test_null_scientific_result_is_not_a_failure(self):
        # Ran fine, honestly found ~no effect: still a completed lane.
        null_result = execution(metrics={"correlations": {"a_vs_b": 0.0}, "pass_fail": "pass"})
        self.assertEqual(_result_status([null_result]), "completed")

    def test_no_failure_signal_stays_completed_even_without_correlations(self):
        # Conservative: unknown blueprint shapes must not be demoted.
        quiet = execution(metrics={"evidence_grade": {"link": "weak"}})
        self.assertEqual(_result_status([quiet]), "completed")

    def test_degenerate_inf_note_is_failure(self):
        inf_only = execution(metrics={"correlations": {}, "notes": "mass_error=inf; ESS_fraction=0.000"})
        self.assertEqual(_result_status([inf_only]), "failed")

    def test_no_executions_is_failed(self):
        self.assertEqual(_result_status([]), "failed")

    def test_failed_execution_without_metrics_does_not_record_pass(self):
        # MEASURED ON cycle-a-20260919, 2026-09-30: 54 failed runner
        # records with zero passed blueprints and no measurements nevertheless
        # exposed pass_fail="pass" through handoff_check_resolutions.
        failed = execution(status="failed", metrics={}, error="dataset missing")

        summary = _mod._validation_summary(
            [failed], {}, role_plan=None, external_agent_executions=[]
        )

        self.assertEqual(summary["blueprints_passed"], 0)
        self.assertEqual(summary["measured_quantities"], [])
        resolution = summary["handoff_check_resolutions"][0]
        self.assertEqual(resolution["status"], "failed")
        self.assertEqual(resolution["pass_fail"], "inconclusive")
        self.assertFalse(resolution["resolved"])


class UnrunnableMethodTest(unittest.TestCase):
    """The proposed method does not exist as executable code yet.

    That is an implementation gap, not a scientific result — it must be
    machine-readable so the planner stops re-dispatching the same impossible
    validation (v63 paid for the identical unimplementable check 22 times).
    """

    def test_extracts_missing_plugin_name_from_real_note(self):
        self.assertEqual(_mod._unrunnable_method_names(V63_PLUGIN_MISSING), ["h_rps"])

    def test_healthy_execution_reports_no_unrunnable_methods(self):
        self.assertEqual(_mod._unrunnable_method_names(WORKING), [])

    def test_validation_summary_surfaces_unrunnable_methods(self):
        summary = _mod._validation_summary(
            [V63_PLUGIN_MISSING] * 22, {}, role_plan=None, external_agent_executions=[]
        )
        self.assertEqual(summary["unrunnable_methods"], ["h_rps"])
        self.assertIn("proposed_method_implementation_available", summary["failed_checks"])
        self.assertEqual(summary["overall_status"], "degraded")

    def test_healthy_summary_is_unaffected(self):
        summary = _mod._validation_summary(
            [WORKING], {}, role_plan=None, external_agent_executions=[]
        )
        self.assertEqual(summary["unrunnable_methods"], [])
        self.assertEqual(summary["overall_status"], "passed")

    def test_dedupes_repeated_missing_method(self):
        self.assertEqual(
            _mod._aggregate_unrunnable_methods([V63_PLUGIN_MISSING] * 5), ["h_rps"]
        )


class IdentityColumnMappingBackfillTest(unittest.TestCase):
    """A self-generating render blueprint must not self-block on column_mapping.

    LLM-authored render blueprints open with a defensive preflight that demands an
    external ``column_mapping`` and then render the scenes and write those very
    columns themselves. For a ``procedural://`` dataset nobody supplies that
    mapping, so the script dies before ``mi.render`` runs (17 of 28 runner
    failures in v68, 4 of 5 in v69). The driver synthesizes the identity mapping
    from the keys the script itself declares.
    """

    SELF_GENERATING = (
        'req = ["scene_id", "seed", "estimate", "squared_error"]\n'
        'miss = [x for x in req if x not in m]\n'
        'img = mi.render(scene, spp=16)\n'
        'pd.DataFrame(rows).to_csv(out / "cells.csv")\n'
    )

    def test_procedural_dataset_gets_identity_mapping(self):
        mapping = _mod._identity_column_mapping_for_self_generated(
            {"dataset": "procedural://rare_event_light_transport"}, self.SELF_GENERATING
        )
        self.assertEqual(
            mapping,
            {
                "scene_id": "scene_id",
                "seed": "seed",
                "estimate": "estimate",
                "squared_error": "squared_error",
            },
        )

    def test_analyst_supplied_mapping_is_never_overwritten(self):
        mapping = _mod._identity_column_mapping_for_self_generated(
            {"dataset": "procedural://x", "column_mapping": {"scene_id": "scene"}},
            self.SELF_GENERATING,
        )
        self.assertEqual(mapping, {})

    def test_external_dataset_is_not_backfilled(self):
        # A real external CSV keeps failing honestly: only the analyst can name
        # that file's headers.
        for dataset in ("geo://GSE12345", "https://example.org/data.csv"):
            self.assertEqual(
                _mod._identity_column_mapping_for_self_generated(
                    {"dataset": dataset}, self.SELF_GENERATING
                ),
                {},
                dataset,
            )

    def test_procedural_identification_strategy_counts_as_self_generated(self):
        mapping = _mod._identity_column_mapping_for_self_generated(
            {"identification_strategy": {"materialized_dataset": {"mode": "procedural"}}},
            self.SELF_GENERATING,
        )
        self.assertEqual(len(mapping), 4)

    def test_blueprint_that_generates_nothing_is_untouched(self):
        self.assertEqual(
            _mod._identity_column_mapping_for_self_generated({}, 'req = ["a"]\nprint(1)\n'),
            {},
        )

    def test_declares_no_required_keys_is_untouched(self):
        self.assertEqual(
            _mod._identity_column_mapping_for_self_generated(
                {"dataset": "procedural://x"}, "img = mi.render(scene)\npd.DataFrame([]).to_csv(p)\n"
            ),
            {},
        )


class PermissiveMappingTest(unittest.TestCase):
    """The preflight must be satisfiable regardless of how it declares its keys.

    Predicting the declaration site failed twice in production: a blueprint that
    wrote `cols = [...]` instead of `req = [...]`, and one that checked its keys
    inline with no list literal at all. Every key a preflight can require is a
    string literal in that same script, so the driver supplies a superset
    identity mapping instead of trying to locate the declaration.
    """

    PROCEDURAL = {"dataset": "procedural_mitsuba_x.csv"}

    COLS_STYLE = (
        'cols = ["edit_severity", "overlap_signal", "ess_ratio"]\n'
        'm = spec.get("column_mapping")\n'
        'if not m: raise ValueError("non-empty column_mapping")\n'
        'img = mi.render(scene)\n'
        'pd.DataFrame(rows).to_csv(p)\n'
    )

    INLINE_STYLE = (
        'm = spec.get("column_mapping")\n'
        'for k in ("scene_id", "policy", "charged_error_time"):\n'
        '    if k not in m: raise ValueError("missing " + k)\n'
        'img = mi.render(scene)\n'
        'pd.DataFrame(rows).to_csv(p)\n'
    )

    def test_cols_style_declaration_is_covered(self):
        mapping = _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, self.COLS_STYLE)
        for key in ("edit_severity", "overlap_signal", "ess_ratio"):
            self.assertEqual(mapping.get(key), key)

    def test_inline_membership_check_is_covered(self):
        mapping = _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, self.INLINE_STYLE)
        for key in ("scene_id", "policy", "charged_error_time"):
            self.assertEqual(mapping.get(key), key)

    def test_external_dataset_still_never_relaxed(self):
        # Handing an external file an identity mapping would silently point at
        # headers it does not have; failing honestly is correct there.
        self.assertEqual(
            _mod._identity_column_mapping_for_self_generated({"dataset": "geo://GSE1"}, self.COLS_STYLE),
            {},
        )

    def test_analyst_mapping_still_wins(self):
        self.assertEqual(
            _mod._identity_column_mapping_for_self_generated(
                {"dataset": "procedural_x.csv", "column_mapping": {"a": "b"}}, self.COLS_STYLE
            ),
            {},
        )

    def test_library_vocabulary_is_not_mapped_as_a_column(self):
        mapping = _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, self.COLS_STYLE)
        for noise in ("utf-8", "scalar_rgb", "png"):
            self.assertNotIn(noise, mapping)


class EmbeddedBlueprintSourceTest(unittest.TestCase):
    """A script shipped as a compressed payload must not blind the scanners.

    cycle-g-v74 followup-runner-58/60/61: the analyst began emitting scripts whose
    whole body is ``exec(compile(gzip.decompress(base64.b64decode("H4sIC..."))))``.
    Every source-reading heuristic went blind at once, and the permissive superset
    found exactly one quoted identifier in the file -- the "exec" mode argument of
    ``compile`` -- so the backfill produced ``{"exec": "exec"}``: non-empty, hence
    apparently successful, while the preflight demanded 22 real semantic keys.
    """

    REAL_SOURCE = (
        'req = ["scene_regime", "edit_class", "current_spp_per_frame", "tinmse_16",\n'
        '       "flip_mean_16", "latency_s", "memory_bytes", "variance_over_frames"]\n'
        'm = spec.get("column_mapping")\n'
        'if not isinstance(m, dict) or not m:\n'
        '    raise ValueError("handoff check requires a non-empty column_mapping")\n'
    )
    PROCEDURAL = {"dataset": "procedural://mitsuba-visibility-hazard-v2"}

    @staticmethod
    def _embed(source: str, compressor) -> str:
        import base64 as _b64

        blob = _b64.b64encode(compressor(source.encode("utf-8"))).decode("ascii")
        return (
            "#!/usr/bin/env python3\nimport base64, gzip\n"
            f'exec(compile(gzip.decompress(base64.b64decode("{blob}")), "<embedded.py>", "exec"))\n'
        )

    def test_gzip_embedded_source_is_recovered(self):
        import gzip as _gzip

        code = self._embed(self.REAL_SOURCE, _gzip.compress)
        mapping = _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, code)
        for key in ("scene_regime", "tinmse_16", "latency_s", "variance_over_frames"):
            self.assertEqual(mapping.get(key), key)

    def test_the_compile_mode_argument_is_not_a_column(self):
        import gzip as _gzip

        code = self._embed(self.REAL_SOURCE, _gzip.compress)
        self.assertNotIn("exec", _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, code))

    def test_other_compression_formats_are_read_too(self):
        import bz2 as _bz2
        import zlib as _zlib

        for compressor in (_zlib.compress, _bz2.compress):
            code = self._embed(self.REAL_SOURCE, compressor)
            mapping = _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, code)
            self.assertEqual(mapping.get("scene_regime"), "scene_regime")

    def test_a_blob_that_is_not_compressed_source_is_ignored(self):
        import base64 as _b64

        junk = _b64.b64encode(b"\x00\x01\x02" * 400).decode("ascii")
        self.assertEqual(_mod._inflate_embedded_code(f'x = "{junk}"'), "")

    def test_plain_scripts_are_unaffected(self):
        mapping = _mod._identity_column_mapping_for_self_generated(self.PROCEDURAL, self.REAL_SOURCE)
        self.assertEqual(mapping.get("flip_mean_16"), "flip_mean_16")

    def test_external_dataset_is_still_never_relaxed(self):
        import gzip as _gzip

        code = self._embed(self.REAL_SOURCE, _gzip.compress)
        self.assertEqual(
            _mod._identity_column_mapping_for_self_generated({"dataset": "geo://GSE1"}, code), {}
        )


class CheckDeclaredColumnsTest(unittest.TestCase):
    """The check's own variable declarations need no readable script at all."""

    V74_CHECK = {
        "dataset": "procedural://mitsuba-visibility-hazard-v2",
        "adjustment_set": ["scene_regime", "edit_class", "seed", "reference_spp"],
        "exposures": ["visibility_flip_fraction", "reuse_age_mean"],
        "outcome": "tinmse_16",
    }

    def test_declared_variables_become_mapping_keys(self):
        names = _mod._check_declared_semantic_columns(self.V74_CHECK)
        for key in ("scene_regime", "visibility_flip_fraction", "tinmse_16"):
            self.assertIn(key, names)

    def test_it_survives_a_script_this_driver_cannot_read(self):
        # Compiled, minified, fetched at runtime -- whatever the reason, the
        # declaration still supplies a floor.
        mapping = _mod._identity_column_mapping_for_self_generated(self.V74_CHECK, "# opaque\n")
        self.assertEqual(mapping.get("scene_regime"), "scene_regime")
        self.assertEqual(mapping.get("tinmse_16"), "tinmse_16")

    def test_non_identifier_declarations_are_skipped(self):
        names = _mod._check_declared_semantic_columns(
            {"adjustment_set": ["ok_col", "not a column", "", 7, "trailing-dash"]}
        )
        self.assertEqual(names, ["ok_col"])


class BlueprintTimeBudgetTest(unittest.TestCase):
    """240s was written as a default and was silently acting as a cap.

    cycle-g-v74 followup-runner-61 and -63 both died at exactly 240.3s on the same
    visibility-hazard prospective design, while 1260s of the driver's own 1500s
    wall-clock budget went unused because only one blueprint had been requested.
    """

    def test_a_lone_blueprint_may_use_the_whole_budget(self):
        share = _mod.DRIVER_WALL_CLOCK_BUDGET_SECONDS // 1
        allocated = max(60, _mod.BLUEPRINT_TIMEOUT_SECONDS_DEFAULT, share)
        self.assertGreater(allocated, _mod.BLUEPRINT_TIMEOUT_SECONDS_DEFAULT)
        self.assertEqual(allocated, _mod.DRIVER_WALL_CLOCK_BUDGET_SECONDS)

    def test_many_blueprints_still_share_fairly(self):
        share = _mod.DRIVER_WALL_CLOCK_BUDGET_SECONDS // 10
        allocated = max(60, _mod.BLUEPRINT_TIMEOUT_SECONDS_DEFAULT, share)
        # The default is a floor, so a crowded handoff is not starved below it.
        self.assertEqual(allocated, _mod.BLUEPRINT_TIMEOUT_SECONDS_DEFAULT)

    def test_the_analyst_may_state_what_its_sweep_needs(self):
        self.assertEqual(_mod._requested_timeout_seconds({"timeout_seconds": 900}), 900)
        self.assertEqual(_mod._requested_timeout_seconds({"expected_runtime_seconds": "600"}), 600)
        self.assertEqual(_mod._requested_timeout_seconds({}, {"budget_seconds": 750}), 750)

    def test_a_request_cannot_exceed_the_aggregate_budget(self):
        self.assertEqual(
            _mod._requested_timeout_seconds({"timeout_seconds": 99999}),
            _mod.DRIVER_WALL_CLOCK_BUDGET_SECONDS,
        )

    def test_saying_nothing_keeps_the_default(self):
        self.assertIsNone(_mod._requested_timeout_seconds({}))
        self.assertIsNone(_mod._requested_timeout_seconds({"timeout_seconds": "soon"}))
        self.assertIsNone(_mod._requested_timeout_seconds({"timeout_seconds": 0}))

    def test_the_declaration_reaches_the_blueprint(self):
        blueprints = _mod._collect_blueprints(
            {
                "validation_code_blueprints": [
                    {
                        "blueprint_id": "bp1",
                        "check_id": "c1",
                        "code": "print(1)",
                        "timeout_seconds": 900,
                    }
                ]
            }
        )
        self.assertEqual(len(blueprints), 1)
        self.assertEqual(blueprints[0].requested_timeout_seconds, 900)


class MeasuredQuantitiesTest(unittest.TestCase):
    """The blueprint's numbers must reach the summary, not stop at its artifacts.

    On cycle-g-v74 lab-runner-04 measured +0.84 dB / -0.19 dB across two scenes,
    and ``validation-summary.json`` mentioned "psnr" zero times — the gate was
    handed "checks 13/13" and reviewed the claim against nothing.
    """

    V74_RENDER = execution(
        metrics={
            "check_id": "render_quality_convergence_01",
            "metrics": {
                "summary": [
                    {"scene": "glossy_sphere", "adaptive_gain_psnr_mean": 0.8414, "adaptive_wins": True},
                    {"scene": "diffuse_sphere", "adaptive_gain_psnr_mean": -0.1911, "adaptive_wins": False},
                ],
                "matched_budget_spp": 24,
                "reference_spp": 256,
            },
            "checks": {"adaptive_beats_uniform": True, "falsification_boundary_held": True},
            "pass_fail": "pass",
        }
    )

    def test_reported_measurements_are_carried_up(self):
        measured = _mod._measured_quantities([self.V74_RENDER])
        self.assertEqual(len(measured), 1)
        rows = measured[0]["quantities"]["metrics"]["summary"]
        self.assertEqual(rows[0]["adaptive_gain_psnr_mean"], 0.8414)
        self.assertEqual(rows[1]["adaptive_gain_psnr_mean"], -0.1911)

    def test_a_losing_condition_is_evidence_and_is_kept(self):
        # Where the method fails bounds the claim; dropping it would leave the
        # summary looking like an unqualified win.
        measured = _mod._measured_quantities([self.V74_RENDER])
        self.assertFalse(measured[0]["quantities"]["metrics"]["summary"][1]["adaptive_wins"])
        self.assertTrue(measured[0]["reported_checks"]["falsification_boundary_held"])

    def test_failed_and_empty_executions_contribute_nothing(self):
        self.assertEqual(_mod._measured_quantities([V63_PLUGIN_MISSING]), [])
        self.assertEqual(_mod._measured_quantities([execution(status="failed")]), [])
        self.assertEqual(_mod._measured_quantities([]), [])

    def test_non_finite_values_are_dropped_not_serialized(self):
        # inf/NaN are how an unrunnable method reports itself; they are not
        # measurements and must not travel as if they were.
        junk = execution(metrics={"metrics": {"mass_error": float("inf"), "bias": float("nan")}})
        self.assertEqual(_mod._measured_quantities([junk]), [])

    def test_large_payloads_are_bounded(self):
        big = execution(
            metrics={"metrics": {"per_seed": [{"psnr": float(i)} for i in range(500)]}}
        )
        rows = _mod._measured_quantities([big])[0]["quantities"]["metrics"]["per_seed"]
        self.assertLessEqual(len(rows), _mod._MEASUREMENT_LIST_LIMIT)

    def test_a_different_payload_shape_is_carried_too(self):
        # cycle-g-v74's later blueprints report under `correlations`, not
        # `metrics`. Keying on one field name left 39 of 40 runners with an empty
        # measured_quantities while their numbers sat in the payload.
        other_shape = execution(
            metrics={
                "check_id": "rare_visibility_frozen_ams_v2",
                "correlations": {"hazard_gain_vs_standard": 0.31, "tinmse_ratio": 0.87},
                "evidence_grade": "moderate",
                "pass_fail": "pass",
            }
        )
        quantities = _mod._measured_quantities([other_shape])[0]["quantities"]
        self.assertEqual(quantities["correlations"]["hazard_gain_vs_standard"], 0.31)
        self.assertEqual(quantities["evidence_grade"], "moderate")
        # The wrappers that merely describe the run do not travel as measurements.
        self.assertNotIn("check_id", quantities)

    def test_it_reads_no_domain_vocabulary(self):
        # Nothing here knows what PSNR is; an entirely different field's
        # measurements travel on the same path.
        other = execution(metrics={"metrics": {"throughput_qps": 1840.5, "p99_latency_ms": 12.3}})
        quantities = _mod._measured_quantities([other])[0]["quantities"]["metrics"]
        self.assertEqual(quantities["throughput_qps"], 1840.5)
        self.assertEqual(quantities["p99_latency_ms"], 12.3)


if __name__ == "__main__":
    unittest.main()
