#!/usr/bin/env python3
"""An objective's lab-describing sections are not its search topic.

MEASURED ON cycle-b-20260918, 2026-09-18/19. Deterministic external-driver
scouts searched

    "python several procedure distinct candidate questions significance"
    "python claims PC simulators"
    "mujoco simulation several procedure distinct candidate questions significance"

The phrases came from the objective's "What each role delivers" bullets and
its research-problem sentence; "python" and "mujoco simulation" were the
capability anchor, taken from the instrument inventory's tool names. 4,617
candidates and 290 accepted papers later, the field's landmark robot-learning
papers were still missing.

The fixture below is that cycle's objective as its task file carried it
(.research-lab/lanes/cycle-b-20260918/followup-scout-02/task.md).
"""
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature.search_lib.queries import (
    capability_anchor_terms,
    derive_queries_from_role_plan,
    domain_objective_text,
    load_queries,
    queries_from_objective_text,
)

OBJECTIVE = """# Robotics simulation research cycle

Research problem: which robot-learning claims that this PC's simulators can test are still unsettled, and does one of them hold up when tested with matched seeds, declared baselines and ablations?

Pick ONE falsifiable question in robot learning \u2014 manipulation, legged locomotion, sim-to-real transfer, contact safety, or language/vision-conditioned policies \u2014 that the simulators below can decide now, and answer it with measured evidence.

## Instruments on this host

Windows 11, NVIDIA RTX 4060 (8 GB), CUDA available. Measure what an environment can actually do before relying on it; record a failure as a concrete blocker.

- Isaac Sim 6.1: `D:/envs/isaacsim6/Scripts/python.exe` (isaacsim 6.1, newton 1.5, warp 1.17, mujoco 3.11, torch 2.11 cu128). Headless.
- Isaac Lab 2.3.2 source at `D:/projects/IsaacLab` (not pip-installed in that env; check compatibility first). It ships Unitree Go2 locomotion tasks and robot assets.
- Docker image `sim-image:latest`, and the project `D:/projects/xARM/isaac_xarm_learning`.
- MuJoCo 3.x, on the host and in the Isaac Sim env.
- SuperDex xArm grasp simulator: copy at `.research-lab/datasets/superdex`, interpreter `D:/projects/superdex/.venv/Scripts/python.exe`, trained policy `results/rl_grasp_hw/ppo_xarm_grasp_hw.zip`.
- Reference repos under `D:/projects/reference-repos/repos` (Isaac-GR00T with env `D:/envs/groot`, curobo, genesis-world, lerobot, uf-gym, xArm-Python-SDK). Read them as prior art; do not modify them.

Run one GPU simulator process at a time, headless, with a declared step or episode budget and measured wall time. A short budgeted training run is fine when the question needs it and its budget is stated first; no long training and no paid cloud jobs.

## Robots

xArm7 and Unitree Go2 EDU Plus are available for a later real-robot check, so a question one of them could confirm is worth more. That is a preference, not a restriction: choose another embodiment when it makes the question better, and say what real validation would then require.

## What each role delivers

- Scout: search the literature for this question, read abstracts before admitting a paper, and keep queries, provenance and inclusion decisions. Prefer 2024\u20132026 work plus the seminal papers the argument needs. State plainly what the corpus does and does not settle.
- LabDirector: several procedure-distinct candidate questions with significance, closest prior art and the exact delta, the strongest rival explanation, the quantity to measure in the chosen simulator, and the decisive falsifier. Reject anything a simpler baseline already explains. Leave unsupported novelty scores unset.
- Analyst: an executable Python validation handoff using the measured simulator capabilities, with matched seeds, baselines and ablations.
- A short Korean summary: what ran, what was measured, the limitations, and the artifact paths.

## Constraints

- Simulation and offline analysis only. Do not connect to, enable, move or calibrate any physical robot, and do not change hardware safety thresholds. Never claim hardware success from simulation.
- Windows host: author Python with pathlib and subprocess argument lists; avoid Bash-only snippets and Linux paths unless inside the declared Docker image.
"""

TASK_FILE = (
    "# Autonomous Follow-up Task for scout\n\n"
    "- cycle_id: cycle-b-20260918\n"
    f"- objective: {OBJECTIVE}\n"
    "- source_brief_id: external_validation_gate\n"
    "- role: scout\n"
    "- task: re-plan the lead hypothesis under unresolved external-validation pressure; choose a "
    "narrower claim, a replacement hypothesis, or a concrete validation/failed-attempt path and assign "
    "follow-up lanes\n"
)

# Words that only the instrument, robot, role and constraint sections carry, or
# that the measured queries were made of.
FORBIDDEN = {
    "python", "mujoco", "isaac", "isaacsim", "docker", "cuda", "gpu", "windows", "nvidia", "xarm",
    "xarm7", "unitree", "go2", "superdex", "headless", "several", "procedure", "distinct",
    "candidate", "questions", "significance", "claims", "pc", "one", "korean", "hardware",
}

# cycle-b-20260918's own instrument inventory, trimmed to the keys read.
ROBOTICS_INVENTORY = {
    "backend": "isaacsim",
    "verified_instruments": [
        "isaacsim_headless_physics_simulation", "isaacsim_gravity_response",
        "mujoco_rigid_body_simulation", "mujoco_contact_response",
        "python_standard_library_statistics", "superdex_gripper_force_actor_coverage",
        "superdex_policy_simulation_measurement", "superdex_nonzero_contact_response",
    ],
    "measurable_quantities": [
        "rigid-body pose and linear velocity over a stepped Isaac Sim (PhysX) simulation",
        "physics timestep and simulated-to-wall-clock throughput for this Isaac Sim installation",
        "whether this Isaac Sim process sees a CUDA device",
        "rigid-body pose and velocity over a stepped MuJoCo simulation",
        "per-step contact count and contact-force magnitude in a MuJoCo scene",
        "count, mean and sample variance of supplied finite numeric values",
    ],
    "probe_modules": {
        "common": {"role": "support"}, "isaacsim": {"role": "backend"}, "mitsuba": {"role": "backend"},
        "mujoco": {"role": "backend"}, "python": {"role": "backend"}, "superdex": {"role": "backend"},
    },
}


def words(query: str) -> set[str]:
    return set(query.lower().replace("-", " ").split())


class ObjectiveQueryTest(unittest.TestCase):
    def assert_domain_queries(self, queries):
        self.assertTrue(queries, "a subject-bearing objective produced no query")
        for query in queries:
            leaked = words(query) & FORBIDDEN
            self.assertFalse(leaked, f"{query!r} carries instrument/meta words {sorted(leaked)}")
            # One phrase per query, not the joined blob.
            self.assertLessEqual(len(query.split()), 6, query)
        joined = " | ".join(queries).lower()
        self.assertIn("robot learning", joined)

    def test_lab_sections_are_dropped_and_the_research_problem_kept(self):
        text = domain_objective_text(OBJECTIVE)
        self.assertIn("robot-learning claims", text)
        self.assertIn("legged locomotion", text)
        for gone in ("Instruments on this host", "D:/envs", "Unitree Go2 EDU", "LabDirector",
                     "several procedure-distinct", "Korean summary", "pathlib"):
            self.assertNotIn(gone, text)

    def test_role_plan_objective_yields_only_subject_queries(self):
        self.assert_domain_queries(derive_queries_from_role_plan({"objective": OBJECTIVE}))

    def test_task_file_yields_per_phrase_queries_not_one_blob(self):
        with tempfile.TemporaryDirectory() as tmp:
            task = Path(tmp) / "task.md"
            task.write_text(TASK_FILE, encoding="utf-8")
            queries = load_queries(None, task)
        self.assert_domain_queries(queries)
        self.assertGreater(len(queries), 1)

    def test_an_objective_with_no_subject_produces_no_query(self):
        only_lab = (
            "## Instruments on this host\n- Isaac Sim 6.1: `D:/envs/isaacsim6/Scripts/python.exe`\n\n"
            "## What each role delivers\n- LabDirector: several procedure-distinct candidate questions with significance\n"
        )
        self.assertEqual(domain_objective_text(only_lab), "")
        self.assertEqual(queries_from_objective_text(only_lab), [])
        self.assertEqual(derive_queries_from_role_plan({"objective": only_lab}), [])
        # Instruction words alone are not a subject either.
        self.assertEqual(queries_from_objective_text("Pick ONE falsifiable question and answer it."), [])

    def test_the_capability_anchor_is_not_a_tool_name(self):
        anchor = capability_anchor_terms(ROBOTICS_INVENTORY)
        self.assertTrue(anchor)
        for tool in ("python", "mujoco", "isaacsim", "superdex", "mitsuba", "cuda", "standard", "library"):
            self.assertNotIn(tool, anchor)


if __name__ == "__main__":
    unittest.main()
