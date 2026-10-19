"use strict";


const GATE_REVIEW_RUBRICS = [
  "novelty",
  "technical_quality",
  "reproducibility",
  "clarity",
  "impact",
  "consort_reporting_completeness",
  "strobe_reporting_completeness",
];

// CONSORT (randomized-trial reporting) and STROBE (observational-epidemiology
// reporting) are BIOMEDICAL reporting standards. They were hardcoded into every
// cycle's gate rubric, so a computer-graphics rendering study was asked to fill
// in "missing observational-study reporting elements" it can never satisfy —
// the gatekeeper carried a permanent strobe/consort blocker and the LabDirector
// had to fight to supersede it, keeping the gate from ever closing honestly.
// These reporting rubrics are only APPLICABLE to a biomedical objective; for a
// cs/graphics or generic objective they are dropped so the gate is judged on the
// research rubrics (novelty/technical_quality/reproducibility/clarity/impact)
// that actually apply. Mirrors the domain-aware novelty-baseline filter (Fix A).
const REPORTING_STANDARD_RUBRICS = new Set([
  "consort_reporting_completeness",
  "strobe_reporting_completeness",
]);

function isReportingStandardRubric(name) {
  return REPORTING_STANDARD_RUBRICS.has(String(name || "").trim());
}

// These two rubrics are named after two study-design reporting standards, so
// unlike everything else in this file they ARE field-specific -- and the honest
// consequence is that deciding when they apply needs a field check.
//
// That check used to be the shared domain classifier, which no longer exists:
// it decided far more than this (which profile every lane ran on, which
// repositories a scout searched), and deciding those from a word-match against a
// table of fields is what steered a rendering cycle into a gene-expression
// archive. What is left here is local, and its scope is only these two rubric
// names.
//
// The real fix is one field-independent `reporting_completeness` rubric judged
// against whatever standard the objective's own field expects. That is a rename
// of two recorded rubric keys -- ~110 references and every historical score is
// indexed by them -- so it is a records decision, not a wording one, and it is
// the owner's to make.
//
// Fail toward the general research rubrics: an objective this cannot place is
// treated as out of scope, so the gate never injects a blocker no cycle in that
// field could satisfy.
const STUDY_DESIGN_SIGNALS = [
  "randomized",
  "randomised",
  "clinical trial",
  "observational",
  "cohort",
  "case-control",
  "cross-sectional",
  "participants",
  "patients",
  "epidemiolog",
];

function reportingRubricApplies(objective) {
  const text = String(objective || "").toLowerCase();
  if (!text.trim()) return false;
  return STUDY_DESIGN_SIGNALS.some((signal) => text.includes(signal));
}

// Filter a rubric NAME list to what applies: drop the two study-design reporting
// standards unless the objective describes that kind of study, pass the rest.
function filterRubricNamesForObjective(names, objective) {
  const list = Array.isArray(names) ? names : [];
  if (reportingRubricApplies(objective)) return list.slice();
  return list.filter((name) => !isReportingStandardRubric(name));
}

const GATE_REVIEWER_BRIEFS = {
  novelty: {
    standard: "research",
    description:
      "judge whether the lead hypotheses are genuinely novel beyond the RELEVANT prior art. Do NOT rely only on the handed-over retrieved paper set — it is often topically incomplete or biased toward one sub-area — a corpus concentrated on the method family next to the lead's, rather than on the lead's own — which makes a non-novel lead look novel. ACTIVELY SEARCH for the lead's direct prior art yourself: author 2-4 targeted prior-art queries in the field's expert vocabulary (the lead's specific method/claim plus foundational / survey / seminal-baseline terms) and run `python3 drivers/literature/search.py --query \"<query>\"` for each, reading the results, before scoring. Then infer the state of the art from BOTH your own search AND the retrieved set + knowledge graph. Novelty MUST be earned against RELEVANT prior art. If neither the retrieved set NOR your own search covers the hypothesis's subject/method — a genuinely off-topic or unrelated baseline — you have NO valid baseline and MUST score novelty LOW (unverified): absence of matching papers means the prior-art search FAILED, it does NOT mean the idea is new. Never infer high novelty from a mismatched baseline -- a corpus from a different field than the claim -- OR from one that simply missed the sub-topic. ONE EXCEPTION, and only when you can demonstrate it — AN UNPOSED PROBLEM. The rule above cannot otherwise tell 'nobody has asked this question' apart from 'my search failed', so it scores both low and the gate can never reward a genuinely new TASK — only a new method for a task the field already named. To separate them, search the lead's COMPONENTS separately: the objects, the measured quantity, the setting, the instrument. If each component is RICHLY covered by on-topic prior art but NO work poses the question itself (the conjunction), your search demonstrably worked and the absence is real: score novelty on the strength of the question and say explicitly which component queries you ran and what they returned. If the components themselves return little or nothing, the search failed — score LOW as above. An unposed problem still has to clear the other rubrics: a question nobody asked because the answer is obvious, useless, or untestable is not novel, it is unasked for a reason, and you should say so. Treat a hypothesis that restates a well-established/textbook result in its field as LOW novelty even if the retrieved set omits it, and if your search finds prior work that already reports the lead's core claim, score novelty LOW and NAME it. Award high novelty ONLY when relevant, on-topic prior art was actually surfaced (by the corpus or your search) AND the lead clearly advances beyond it.",
  },
  technical_quality: {
    standard: "research",
    description:
      "audit technical soundness, confound handling, falsification strength, and whether the core claims are adequately supported",
  },
  reproducibility: {
    standard: "research",
    description:
      "audit whether the evidence, validation steps, and traceability are strong enough that an expert could realistically reproduce the result",
  },
  clarity: {
    standard: "research",
    description:
      "audit whether the claims, evidence chain, limitations, and takeaways are communicated clearly enough for expert review",
  },
  impact: {
    standard: "research",
    description:
      "audit whether the validated findings materially advance the problem area and would matter to researchers or practitioners",
  },
  consort_reporting_completeness: {
    standard: "CONSORT",
    description:
      "audit reporting completeness for randomized-trial style work only when applicable",
  },
  strobe_reporting_completeness: {
    standard: "STROBE",
    description:
      "audit reporting completeness for observational study work only when applicable",
  },
};

module.exports = {

  GATE_REVIEW_RUBRICS,

  GATE_REVIEWER_BRIEFS,

  REPORTING_STANDARD_RUBRICS,

  isReportingStandardRubric,

  reportingRubricApplies,

  filterRubricNamesForObjective,

};