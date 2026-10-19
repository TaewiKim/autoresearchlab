"use strict";

// Design-constraints memory — a per-project append-only log of "do not
// do X on Y kind of data" lessons distilled from past cycles. Stored at
// .research-lab/state/design_constraints.jsonl (JSON Lines, newest last).
//
// Each row has the shape:
//   {
//     "id": string,                    // stable hash or cycle-derived id
//     "added_at": ISO-8601 string,
//     "cycle_id": string,              // cycle that produced the lesson
//     "pattern": {                     // the shape of the failed attempt
//       "identification_strategy": string | null,
//       "evidence_ceiling": string | null,   // e.g. "pooled_only"
//       "within_unit_collapse": boolean | null
//     },
//     "lesson": string,                // free-form: "do not X because Y"
//     "expires_after_cycle": string | null   // optional hard expiry
//   }
//
// Consumers (hypothesis_generator, validation plan builder) MUST treat
// constraints as a soft prior — they gate generation but do not hard-fail
// if a candidate violates one. Violations are annotated on the candidate
// as `design_constraint_violations: [id, ...]` so downstream reviewers
// see the tension explicitly.

const fs = require("fs");
const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { ensureDir } = require("../../shared/json");

function constraintsPath(cwd) {
  return path.join(runtimeRoot(cwd), "state", "design_constraints.jsonl");
}

function readDesignConstraints(cwd = process.cwd()) {
  const file = constraintsPath(cwd);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const constraints = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === "object") constraints.push(row);
    } catch {
      // skip malformed rows — the log is append-only so a bad row should
      // not poison the whole feed; we tolerate and move on.
    }
  }
  return constraints;
}

function appendDesignConstraint(cwd, constraint) {
  const file = constraintsPath(cwd);
  ensureDir(path.dirname(file));
  const row = {
    id: constraint?.id || `constraint-${Date.now()}`,
    added_at: constraint?.added_at || new Date().toISOString(),
    cycle_id: constraint?.cycle_id || null,
    pattern: constraint?.pattern || {},
    lesson: constraint?.lesson || "",
    expires_after_cycle: constraint?.expires_after_cycle || null,
  };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

// Derive candidate constraints from a completed cycle's ledger + next-cycle
// plan. Called once per cycle closure; emits constraints for patterns that
// should not repeat until the associated design_shift has been applied.
function deriveConstraintsFromCycle({ cycleId, summary, nextCyclePlan }) {
  const constraints = [];
  const robustnessRatio = Number(nextCyclePlan?.robustness_failure_ratio || 0);
  const designBlockReasons = Array.isArray(summary?.design_block_reasons) ? summary.design_block_reasons : [];
  const shifts = Array.isArray(nextCyclePlan?.design_shifts) ? nextCyclePlan.design_shifts : [];

  // Only emit the robustness constraint when the planner actually carried a
  // strategy-switch design_shift. When a lead hypothesis already promoted the
  // planner suppresses the shift (the approach worked), so no "avoid this
  // approach" prior should be written — otherwise the next cycle is needlessly
  // pushed off a strategy that succeeded.
  const strategyShift = shifts.find((s) => Array.isArray(s?.suggested_strategies) && s.suggested_strategies.length);
  if (robustnessRatio > 0.5 && strategyShift) {
    // The alternative strategies come from the (domain-general) design_shift
    // the planner already emitted — never a hardcoded epi list, so a graphics
    // cycle carries a graphics-appropriate lesson rather than "diff-in-diff".
    const strategyProse = strategyShift.suggested_strategies.map((s) => String(s).replace(/_/g, " ")).join(", ");
    constraints.push({
      id: `${cycleId}:approach-robustness-fail`,
      cycle_id: cycleId,
      pattern: {
        identification_strategy: "current_cycle_approach",
        evidence_ceiling: "robustness_failed",
        within_unit_collapse: null,
      },
      lesson:
        `The current cycle's validation approach hit robustness_failure_ratio=${robustnessRatio}; ` +
        `avoid re-running the same approach on the same data unless a design_shift (${strategyProse}) is attached.`,
      expires_after_cycle: null,
    });
  }

  if (designBlockReasons.includes("pairwise_tournament_loss")) {
    constraints.push({
      id: `${cycleId}:pairwise-tournament-exhausted`,
      cycle_id: cycleId,
      pattern: {
        identification_strategy: null,
        evidence_ceiling: "tournament_loss",
        within_unit_collapse: null,
      },
      lesson:
        "Families that already lost ≥2 pairwise contests should not be re-proposed with the same framing; if revisiting, the hypothesis must carry a design_shift (a sharper contrast or a different dataset/setting).",
      expires_after_cycle: null,
    });
  }

  if (shifts.some((s) => s?.type === "switch_identification_strategy")) {
    constraints.push({
      id: `${cycleId}:strategy-exhausted-for-question`,
      cycle_id: cycleId,
      pattern: {
        identification_strategy: "current_cycle_approach",
        evidence_ceiling: null,
        within_unit_collapse: null,
      },
      lesson:
        "The prior cycle explicitly requested a strategy switch; the next cycle's hypotheses must carry a different validation/identification strategy than the exhausted one, or declare why the same strategy will now work.",
      expires_after_cycle: null,
    });
  }

  return constraints;
}

// Summarise the active (non-expired) constraints into a concise prose
// block suitable for inclusion in hypothesis-generator prompts.
function summarizeConstraintsForPrompt(constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) return "";
  const lines = constraints
    .map((c, idx) => `  ${idx + 1}. ${c.lesson}`)
    .join("\n");
  return (
    "Prior-cycle design constraints (soft priors — flag violations, do not silently ignore):\n" +
    lines
  );
}

// Check if a candidate hypothesis violates any active constraint. Returns
// the list of violated constraint ids (empty when clean).
function matchConstraintViolations(candidate, constraints) {
  const violations = [];
  const candStrategy = String(candidate?.identification_strategy || "").toLowerCase();
  for (const c of constraints || []) {
    const reqStrategy = String(c?.pattern?.identification_strategy || "").toLowerCase();
    if (reqStrategy && candStrategy && reqStrategy === candStrategy) {
      violations.push(c.id);
    }
  }
  return violations;
}

module.exports = {
  constraintsPath,
  readDesignConstraints,
  appendDesignConstraint,
  deriveConstraintsFromCycle,
  summarizeConstraintsForPrompt,
  matchConstraintViolations,
};
