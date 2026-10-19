"use strict";

const { loadCycleEvidence } = require("./cycle_evidence");
const { resolveProfile } = require("./derived_profile");
const { runtimeRoot } = require("../../runtime/native_client");

function normalizePrompt(prompt) {
  return String(prompt || "").trim();
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function promptKeywords(prompt, limit = 10) {
  const text = normalizePrompt(prompt);
  const stop = new Set([
    "the", "and", "for", "with", "from", "into", "using", "that", "this",
    "data", "dataset", "analysis", "analyze", "research", "study", "effect",
  ]);
  const quoted = (text.match(/["'`](.+?)["'`]/g) || []).map((item) => item.replace(/^["'`]|["'`]$/g, ""));
  // Unicode letters and digits, so an objective in any language tokenises.
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || [])
    .filter((token) => !stop.has(token));
  return dedupe(quoted.concat(tokens)).slice(0, limit);
}

function inferOutcome(prompt) {
  const keywords = promptKeywords(prompt, 6);
  return keywords.length ? keywords.slice(0, 4).join(" / ") : "the target outcome";
}

function buildFrontierDiscoveryFrame(prompt) {
  const outcome = inferOutcome(prompt);
  return {
    original_prompt: normalizePrompt(prompt),
    reframed_goal: `Identify competing variable families, mechanisms, datasets, and validation strategies that can explain ${outcome} for the requested research objective.`,
    first_task:
      "Do not assume any single exposure is primary. Identify competing primary variable families, rival mechanisms, and alternative causal structures supported by literature and data.",
    required_output: [
      "candidate primary variable families",
      "candidate mechanisms",
      "rival DAGs",
      "mediators vs confounders vs competing exposures",
      "evidence gaps that could overturn the current leading family",
    ],
  };
}

// Fallback candidate families, used only when the agents supplied none.
//
// This used to append a fixed list called GENERIC_RESEARCH_FAMILIES whose content
// was anything but generic: "cohort strata", "disease subtypes", "instrumental
// variables", "natural experiments", "latent biological state". In a rendering
// cycle those are not candidate families, they are noise that grounds the
// codebook in the wrong field. A fixed list can only ever be right for the fields
// somebody enumerated.
//
// What is left is derived from the objective itself, so the fallback speaks the
// cycle's own vocabulary. When the objective yields nothing usable we return
// NOTHING — an empty candidate set is honest, and the agents' own families are
// the real source anyway.
function candidatePrimaryFamilies(prompt) {
  const keywords = promptKeywords(prompt, 8);
  if (keywords.length === 0) return [];
  return [
    {
      family: "prompt_specific_candidate_family",
      members: keywords.slice(0, 4),
      mechanisms: ["prompt-grounded mechanism", "candidate explanatory pathway", "testable contrast"],
      search_terms: keywords.slice(0, 6),
    },
  ];
}

// Candidate OUTCOME variables for the cycle, grounded in the prompt rather
// than a hard-coded domain default. The codebook's groundedVariableBundle
// needs at least one role:"outcome" variable to ground a hypothesis (it
// returns null otherwise, which suppresses all structured-hypothesis
// synthesis). Nothing else in the pipeline ever populated
// rolePlan.candidate_outcomes, so grounding silently failed on every cycle
// once the hard-coded WHO CODEBOOK_VARIABLES were removed. This restores a
// domain-neutral, prompt-derived outcome so x/y/direction are populated
// again (the promotion gate requires them) without reintroducing a fixed
// health-domain target.
function candidateOutcomes(prompt) {
  const keywords = promptKeywords(prompt, 6);
  if (keywords.length === 0) return [];
  const label = keywords.slice(0, 3).join(" / ");
  return [
    {
      id: "primary_outcome",
      label,
      concepts: keywords.slice(0, 6),
      dtype: "float",
      unit: "value",
      quantity_type: "metric",
    },
  ];
}

// Pull short, search-friendly anchor phrases out of the user prompt so
// we can build keyword queries instead of shipping the whole prompt as
// a single search term.
function extractQueryAnchors(prompt) {
  // The objective's OWN keywords only — no injected study-design vocabulary.
  // (Earlier this appended a hardcoded epidemiology/econ design list — cohort,
  // mendelian randomization, diff-in-diff — which biased the scout toward
  // biomedical/observational literature regardless of the actual field.)
  return Array.from(new Set(promptKeywords(prompt, 14)));
}

function frontierQueries(prompt, { role = "scout", cycleId = null } = {}) {
  const frame = buildFrontierDiscoveryFrame(prompt);
  const contentAnchors = extractQueryAnchors(prompt);

  // Seed vocabulary this cycle actually retrieved, which supplements the
  // prompt's own keywords so a non-English prompt still forms queries in the
  // field's published vocabulary. It used to come from a per-field table, which
  // supplied nothing at all for a field that was not in it.
  const seeds = (resolveProfile({
    ...loadCycleEvidence({ root: runtimeRoot(), cycleId }),
    context: prompt,
  }).profile.searchSeeds || []).slice(0, 8);

  const queries = [];
  const seen = new Set();
  const push = (q) => {
    const key = q.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(q.trim());
  };

  // The objective's own keyword pairs (may be non-English).
  for (let i = 0; i + 1 < contentAnchors.length; i += 2) {
    push(`${contentAnchors[i]} ${contentAnchors[i + 1]}`);
  }
  // Domain seed vocabulary: on-domain English terms, alone and paired, so the
  // scout actually retrieves this field's literature.
  for (const seed of seeds) push(seed);
  for (let i = 0; i + 1 < seeds.length; i += 2) push(`${seeds[i]} ${seeds[i + 1]}`);

  // Fallback: if nothing was produced, emit the prompt's short form as a seed.
  if (queries.length === 0 && prompt) {
    const short = normalizePrompt(prompt).split(/[.!?\n]/)[0].slice(0, 160);
    if (short) push(short);
  }

  // Analyst lanes additionally ask about methodology / benchmark comparisons,
  // anchored on the domain's own seed vocabulary.
  if (role === "analyst") {
    for (const seed of seeds.slice(0, 2)) push(`${seed} benchmark comparison`);
  }

  return {
    frame,
    families: candidatePrimaryFamilies(prompt),
    outcomes: candidateOutcomes(prompt),
    queries: queries.slice(0, 12),
    anchors: {
      content: contentAnchors,
      // Seeds this cycle retrieved, not seeds a field label supplied.
      retrieved_seeds: seeds,
    },
  };
}

module.exports = {
  buildFrontierDiscoveryFrame,
  candidateOutcomes,
  candidatePrimaryFamilies,
  extractQueryAnchors,
  frontierQueries,
};
