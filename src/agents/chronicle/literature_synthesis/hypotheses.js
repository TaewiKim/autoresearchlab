"use strict";

const { createFrontierCatalog } = require("../data_graph_artifacts");
const { typedId } = require("../graph_schema");
const { uniqueTitles } = require("./compact");
const {
  inferFamilyRootFromVariable,
  rivalFamiliesFor,
  CODEBOOK_VARIABLES,
  buildDynamicCodebook,
  conceptBundle,
  groundedVariableBundle,
  discoverPrimaryFamilyRoots,
  selectPrimaryVariableForFamily,
  slugifyFragment,
  dynamicHypothesisId,
} = require("./codebook");
const {
  buildHypothesisNode,
  inferCondition,
  deriveConfounders,
  deriveRivalExplanations,
  buildLiteratureGraph,
  buildScoreBundle,
  buildStructuredClaims,
  buildResearchReasoningGraph,
} = require("./literature_graph");

function buildFamilyRootHypotheses(papers, rolePlan, graphSupport, grounded) {
  const titles = uniqueTitles(papers, 8);
  if (titles.length === 0) return [];
  const discoveredFamilies = discoverPrimaryFamilyRoots(papers, rolePlan).slice(0, 5);
  // No grounded variables == no template hypothesis. Earlier code
  // fell back to CODEBOOK_VARIABLES[neonatal_mortality / region_name]
  // which forced a WHO outcome onto every cycle without one.
  if (!grounded?.y) return [];
  const outcome = grounded.y;
  const condition = grounded.z || null;
  const confounders = deriveConfounders(papers, rolePlan);
  const rivalExplanations = deriveRivalExplanations(papers, rolePlan);
  const dynamicCodebook = buildDynamicCodebook(rolePlan, papers).variables;
  const codebook = CODEBOOK_VARIABLES.length > 0 ? CODEBOOK_VARIABLES : dynamicCodebook;
  const hypotheses = [];
  const familyPeers = discoveredFamilies.map((item) => item.family_root);

  for (const family of discoveredFamilies) {
    const variable = selectPrimaryVariableForFamily(family.family_root, codebook);
    if (!variable || !outcome) continue;
    const mechanism = family.mechanisms[0] || `${family.family_root.replaceAll("_", " ")} mechanism`;
    const rivalFamilies = rivalFamiliesFor(family.family_root, familyPeers);
    hypotheses.push(
      hypothesisFromTemplate(
        `${variable.label} may explain cross-country variation in ${outcome.label} better than the current incumbent family when tested against the same literature and data graph.`,
        `Family-frontier nomination elevates ${family.family_root} as a competing primary explanatory package rather than treating it as a modifier of another family.`,
        titles.slice(0, 4),
        {
          idPrefix: `hyp-family-${slugifyFragment(family.family_root)}`,
          family: family.family_root,
          family_root: family.family_root,
          x_variable: variable.variable_id,
          y_variable: outcome.variable_id,
          condition: condition?.variable_id || null,
          direction: "comparative",
          mechanisms: [mechanism],
          confounders,
          rival_explanations: rivalExplanations,
          rival_to: rivalFamilies,
          graph_support: graphSupport,
          support_paths: [graphSupport.anchor_path],
          validation_plan: [
            `Estimate a ${variable.variable_id} rooted model for ${outcome.variable_id} and compare it against rival primary families.`,
            `Run pairwise family debate against ${rivalFamilies.join(", ")} with matched validation checks.`,
            `Promote only if ${family.family_root} materially improves explanatory fit, subgroup stability, or falsification resilience.`,
          ],
          validation_protocol: {
            dataset: variable.dataset_id || "cycle-data-graph",
            model: "family-rooted comparative model",
            comparison: `${family.family_root} versus ${rivalFamilies.join(", ")}`,
            acceptance_criterion: `${variable.variable_id} outperforms rival families on matched validation criteria without collapsing under confound or falsification checks.`,
          },
          falsification_rule: `Reject ${family.family_root} if it does not beat rival families after matched robustness and confound tests.`,
          impact: 0.79,
          directness: 0.71,
        },
      ),
    );
    hypotheses.push(
      hypothesisFromTemplate(
        `A rival DAG rooted in ${variable.label} may outperform an average-coverage story by operating through ${mechanism}.`,
        `This converts family nomination into a rival-DAG comparison so the planner can test whether ${family.family_root} should replace, not merely modify, the incumbent family.`,
        titles.slice(1, 5),
        {
          idPrefix: `hyp-family-dag-${slugifyFragment(family.family_root)}`,
          family: family.family_root,
          family_root: family.family_root,
          x_variable: variable.variable_id,
          y_variable: outcome.variable_id,
          condition: condition?.variable_id || null,
          direction: "conditional",
          mechanisms: [mechanism, condition?.label].filter(Boolean),
          confounders,
          rival_explanations: rivalExplanations,
          rival_to: rivalFamilies,
          graph_support: graphSupport,
          support_paths: [graphSupport.anchor_path],
          validation_plan: [
            `Specify a rival DAG with ${variable.variable_id} as the root family.`,
            `Compare subgroup stability, falsification strength, and explanatory fit against the incumbent family.`,
            `Demote the incumbent if ${family.family_root} wins the pairwise debate on matched evidence.`,
          ],
          validation_protocol: {
            dataset: variable.dataset_id || "cycle-data-graph",
            model: "rival-dag comparison",
            comparison: `${family.family_root} root DAG against incumbent root DAG`,
            acceptance_criterion: `${family.family_root} wins pairwise comparison on explanatory quality and robustness, not just surface plausibility.`,
          },
          falsification_rule: `Reject this rival DAG if its apparent advantage disappears under the same controls and subgroup checks applied to the incumbent family.`,
          impact: 0.83,
          directness: 0.69,
        },
      ),
    );
  }

  return hypotheses;
}


function hypothesisFromTemplate(statement, rationale, paperSupport, options = {}) {
  const graphSupport = options.graph_support || null;
  const condition = options.condition || null;
  const mechanisms = Array.isArray(options.mechanisms)
    ? options.mechanisms.filter(Boolean)
    : options.mechanism
      ? [options.mechanism]
      : [];
  const moderators = Array.isArray(options.moderators)
    ? options.moderators.filter(Boolean)
    : condition
      ? [condition]
      : [];
  const confounders = Array.isArray(options.confounders) ? options.confounders.filter(Boolean) : [];
  const rivalExplanations = Array.isArray(options.rival_explanations)
    ? options.rival_explanations.filter(Boolean)
    : [];
  const falsificationTests = Array.isArray(options.falsification_tests)
    ? options.falsification_tests.filter((item) => item && item.label)
    : [];
  const scores = buildScoreBundle({
    paperSupport,
    graphSupport,
    condition,
    directness: options.directness,
    impact: options.impact,
  });
  const validationProtocol = options.validation_protocol || {
    dataset: "cycle-data-graph",
    model: condition ? "conditional graph-grounded validation model" : "graph-grounded validation model",
    comparison: condition ? `conditional comparison under ${condition}` : "pooled baseline comparison",
    acceptance_criterion: `The ${options.x_variable || "x"} to ${options.y_variable || "y"} relationship remains directionally stable and materially stronger than the rival explanation.`,
  };
  const hypothesisNode = buildHypothesisNode({
    hypothesis_id: dynamicHypothesisId(statement, options.idPrefix || "hyp"),
    statement,
    direction: options.direction || "unknown",
    ...scores,
  });
  const defaultFalsificationRule =
    options.falsification_rule ||
    `Reject the hypothesis if the ${options.x_variable || "lead"} to ${options.y_variable || "target"} relationship is not directionally stable after sensitivity checks.`;
  const normalizedFalsificationTests = falsificationTests.length > 0
    ? falsificationTests
    : [
        {
          test_id: typedId("test", defaultFalsificationRule),
          kind: "rule",
          label: defaultFalsificationRule,
        },
        ...((options.validation_plan || []).slice(0, 3).map((step) => ({
          test_id: typedId("test", step),
          kind: "validation_step",
          label: step,
        }))),
      ];
  const structuredHypothesisComponents = {
    mechanisms: mechanisms.map((label) => ({
      node_id: typedId("mechanism", label),
      type: "mechanism",
      label,
    })),
    moderators: moderators.map((label) => ({
      node_id: typedId("moderator", label),
      type: "moderator",
      label,
    })),
    confounders: confounders.map((label) => ({
      node_id: typedId("confounder", label),
      type: "confounder",
      label,
    })),
    rival_explanations: rivalExplanations.map((label) => ({
      node_id: typedId("rival", label),
      type: "rival_explanation",
      label,
    })),
    falsification_tests: normalizedFalsificationTests,
  };
  const claims = buildStructuredClaims({ statement, rationale, paperSupport, options });
  const reasoningGraphSupport = buildResearchReasoningGraph(graphSupport, {
    hypothesis_id: hypothesisNode.node_id.replace(/^hypothesis:/, ""),
    statement,
    x_variable: options.x_variable || null,
    y_variable: options.y_variable || null,
    direction: options.direction || "unknown",
    claims,
    structured_hypothesis_components: structuredHypothesisComponents,
  });
  const familyRoot = options.family_root || inferFamilyRootFromVariable(options.x_variable, options.family);
  return {
    hypothesis_id: hypothesisNode.node_id.replace(/^hypothesis:/, ""),
    statement,
    rationale,
    paper_support: paperSupport,
    hypothesis_family: options.family || null,
    family_root: familyRoot,
    primary_exposure: options.x_variable || null,
    core_claim: statement,
    rival_to: Array.isArray(options.rival_to) ? options.rival_to : rivalFamiliesFor(familyRoot),
    mechanism_path: mechanisms.slice(0, 4),
    test_plan: (options.validation_plan || []).slice(0, 4),
    x_variable: options.x_variable || null,
    y_variable: options.y_variable || null,
    condition,
    direction: options.direction || "unknown",
    mechanism: mechanisms[0] || null,
    mechanisms,
    claims,
    moderators,
    confounders,
    rival_explanations: rivalExplanations,
    falsification_rule: defaultFalsificationRule,
    falsification_tests: normalizedFalsificationTests,
    validation_plan:
      options.validation_plan || [
        `Map the literature path from ${options.x_variable || "lead"} to ${options.y_variable || "target"}.`,
        `Test whether the relationship holds under ${condition || "the observed context"}.`,
        "Compare against at least one rival explanation before promotion.",
    ],
    validation_protocol: validationProtocol,
    support_paths: options.support_paths || (graphSupport?.anchor_path ? [graphSupport.anchor_path] : []),
    graph_support: reasoningGraphSupport,
    codebook_grounding: graphSupport?.codebook_grounding || null,
    hypothesis_node: hypothesisNode,
    structured_hypothesis_components: structuredHypothesisComponents,
    source_graph: "literature",
    schema_version: "scientific-hypothesis-spec-v1",
    required_output_complete: Boolean(
      options.x_variable &&
      options.y_variable &&
      condition &&
      (options.direction || "unknown") &&
      mechanisms.length > 0 &&
      validationProtocol &&
      (options.falsification_rule || true)
    ),
    ...scores,
  };
}

function buildHypotheses(papers, rolePlan) {
  const titles = uniqueTitles(papers, 8);
  if (titles.length === 0) return [];
  const bundle = conceptBundle(papers, rolePlan);
  const grounded = groundedVariableBundle(papers, rolePlan);
  const graphSupport = buildLiteratureGraph(papers, rolePlan);
  const condition = inferCondition(bundle, rolePlan);
  const confounders = deriveConfounders(papers, rolePlan);
  const rivalExplanations = deriveRivalExplanations(papers, rolePlan);

  // No grounded variable bundle = no template hypotheses. Earlier
  // versions fell through to grounded.x/y/z reads on null and crashed,
  // or worse, used WHO defaults so the template always fired with
  // health-domain phrasing. Now we just return whatever
  // buildFamilyRootHypotheses produced (which itself returns [] when
  // not grounded).
  if (!grounded) {
    return buildFamilyRootHypotheses(papers, rolePlan, graphSupport, grounded);
  }
  return [
    ...buildFamilyRootHypotheses(papers, rolePlan, graphSupport, grounded),
    hypothesisFromTemplate(
      `The relationship between ${grounded.x_label} and ${grounded.y_label} may vary across ${grounded.z_label} contexts.`,
      `Literature concepts are grounded to measurable variables, suggesting that ${grounded.x_label} should be tested against ${grounded.y_label} under ${grounded.z_label}-linked settings.`,
      titles.slice(0, 4),
      {
        x_variable: grounded.x_variable,
        y_variable: grounded.y_variable,
        condition: grounded.z_variable,
        direction: "conditional",
        mechanism: grounded.z_label,
        confounders,
        rival_explanations: rivalExplanations,
        family: "literature-graph-conditional",
        graph_support: graphSupport,
        support_paths: [graphSupport.anchor_path],
        validation_plan: [
          `Use a dataset that contains ${grounded.x_variable}, ${grounded.y_variable}, and ${grounded.z_variable}.`,
          `Estimate whether ${grounded.x_variable} changes ${grounded.y_variable} differently across ${grounded.z_variable}.`,
          "Accept only if the conditional model improves on the pooled baseline with a directionally stable effect.",
        ],
        validation_protocol: {
          dataset: grounded.x?.dataset_id || "cycle-data-graph",
          model: "conditional interaction model",
          comparison: `${grounded.z_variable} stratified comparison against pooled baseline`,
          acceptance_criterion: `${grounded.x_variable} remains directionally stable for ${grounded.y_variable} and the interaction term is practically meaningful.`,
        },
        falsification_rule:
          `Reject if ${grounded.x_variable} does not show a stable conditional relationship with ${grounded.y_variable} under ${grounded.z_variable}.`,
      },
    ),
    hypothesisFromTemplate(
      `${grounded.x_label} may align more strongly with ${grounded.y_label} than with broader aggregate outcomes under the same evidence base.`,
      `The retrieved papers suggest that ${grounded.y_label} is the most measurable outcome proxy available for validating the current literature path.`,
      titles.slice(1, 5),
      {
        x_variable: grounded.x_variable,
        y_variable: grounded.y_variable,
        condition: grounded.z_variable,
        direction: "positive",
        mechanism: `direct pathway through ${grounded.z_label}`,
        confounders,
        rival_explanations: rivalExplanations,
        family: "literature-graph-directed",
        graph_support: graphSupport,
        directness: 0.72,
        impact: 0.68,
        support_paths: [graphSupport.anchor_path],
        validation_protocol: {
          dataset: grounded.x?.dataset_id || "cycle-data-graph",
          model: "direct-path comparison model",
          comparison: `${grounded.y_variable} against broader health outcome baselines`,
          acceptance_criterion: `${grounded.y_variable} shows a clearer and more stable directional response than the competing aggregate outcome.`,
        },
      },
    ),
    // Removed: a hardcoded "measurement quality / surveillance"
    // hypothesis that previously got appended to every cycle. It
    // assumed every domain has a measurement-reporting backbone like
    // a WHO surveillance system, which only fits the health domain.
  ];
}

function buildBrainstormHypotheses(papers, rolePlan) {
  const titles = uniqueTitles(papers, 8);
  const frame = String(rolePlan?.planner_metadata?.brainstorm_frame || "").trim();
  if (!frame || titles.length === 0) return [];
  const bundle = conceptBundle(papers, rolePlan);
  const graphSupport = buildLiteratureGraph(papers, rolePlan);
  const focusHypotheses = Array.isArray(rolePlan?.assigned_hypotheses)
    ? rolePlan.assigned_hypotheses.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  // Brainstorm leads used to be hand-routed to WHO terminology
  // ("DTP3 coverage", "neonatal mortality", "regional delivery
  // context"). Now they come from the topic-derived concept bundle so
  // the brainstorm framing matches whatever the cycle actually
  // researches. The focus_hypotheses (active ones being challenged)
  // still inform the selection, but only via tokenization rather than
  // through fixed health-domain mappings.
  const leadExposure = bundle.primary;
  const leadOutcome = bundle.secondary;
  const contextDriver = bundle.tertiary;
  const noveltyAnchors = Array.from(new Set([
    contextDriver,
    bundle.tertiary,
    bundle.concepts[3],
    bundle.concepts[4],
  ])).filter(Boolean);
  const [anchorA, anchorB] = noveltyAnchors;

  const byFrame = {
    "alternative-mechanism": [
      hypothesisFromTemplate(
        `The apparent ${leadExposure}-${leadOutcome} relationship may be mediated by ${anchorA || contextDriver} rather than reflecting a single direct pathway.`,
        `Alternative-mechanism brainstorming converts the current lead conclusion into a mechanism test around ${anchorA || contextDriver}.`,
        titles.slice(0, 4),
        {
          idPrefix: "hyp-alternative",
          family: "alternative-mechanism",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: contextDriver,
          direction: "conditional",
          mechanism: anchorA || contextDriver,
          graph_support: graphSupport,
        },
      ),
      hypothesisFromTemplate(
        `${anchorB || "surveillance quality"} may explain why the pooled ${leadExposure}-${leadOutcome} signal overstates a direct causal effect.`,
        `This variant proposes a distinct institutional mechanism rather than a restatement of the pooled association.`,
        titles.slice(1, 5),
        {
          idPrefix: "hyp-alternative",
          family: "alternative-mechanism",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorB || "surveillance quality",
          direction: "conditional",
          mechanism: anchorB || "surveillance quality",
          graph_support: graphSupport,
        },
      ),
    ],
    "moderator-map": [
      hypothesisFromTemplate(
        `${anchorA || contextDriver} may moderate how strongly ${leadExposure} relates to ${leadOutcome}.`,
        `Moderator mapping should produce a conditional hypothesis family, not another pooled average result.`,
        titles.slice(0, 4),
        {
          idPrefix: "hyp-moderator",
          family: "moderator-map",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorA || contextDriver,
          direction: "conditional",
          mechanism: anchorA || contextDriver,
          graph_support: graphSupport,
        },
      ),
      hypothesisFromTemplate(
        `The ${leadExposure}-${leadOutcome} relationship may strengthen or weaken across ${anchorB || "inequality"} strata.`,
        `This hypothesis asks for a stratified test that could overturn the pooled conclusion.`,
        titles.slice(1, 5),
        {
          idPrefix: "hyp-moderator",
          family: "moderator-map",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorB || "inequality",
          direction: "conditional",
          mechanism: anchorB || "inequality",
          graph_support: graphSupport,
        },
      ),
    ],
    "partition-and-threshold": [
      hypothesisFromTemplate(
        `There may be a threshold where changes in ${leadExposure} matter disproportionately for ${leadOutcome}.`,
        `Partition-and-threshold framing searches for a non-linear regime change rather than another linear restatement.`,
        titles.slice(0, 4),
        {
          idPrefix: "hyp-threshold",
          family: "partition-and-threshold",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: "threshold regime",
          direction: "threshold",
          mechanism: "non-linear threshold",
          graph_support: graphSupport,
        },
      ),
      hypothesisFromTemplate(
        `A partition defined by ${anchorA || "low baseline coverage"} may reveal that ${leadExposure} only changes ${leadOutcome} beyond a narrow operational threshold.`,
        `This produces a genuinely different test family focused on partitions and threshold behavior.`,
        titles.slice(1, 5),
        {
          idPrefix: "hyp-threshold",
          family: "partition-and-threshold",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorA || "low baseline coverage",
          direction: "threshold",
          mechanism: anchorA || "low baseline coverage",
          graph_support: graphSupport,
        },
      ),
    ],
    "counterfactual-and-rival": [
      hypothesisFromTemplate(
        `A rival explanation centered on ${anchorA || contextDriver} may account for part of the observed ${leadExposure}-${leadOutcome} relationship.`,
        `Counterfactual brainstorming requires an explicit rival explanation that can displace the current lead interpretation.`,
        titles.slice(0, 4),
        {
          idPrefix: "hyp-rival",
          family: "counterfactual-and-rival",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorA || contextDriver,
          direction: "conditional",
          mechanism: anchorA || contextDriver,
          graph_support: graphSupport,
        },
      ),
      hypothesisFromTemplate(
        `If ${anchorB || "system capacity"} is held constant, the observed ${leadExposure}-${leadOutcome} relationship may weaken materially.`,
        `This makes the rival explanation directly testable against the current favored hypothesis family.`,
        titles.slice(1, 5),
        {
          idPrefix: "hyp-rival",
          family: "counterfactual-and-rival",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorB || "system capacity",
          direction: "conditional",
          mechanism: anchorB || "system capacity",
          graph_support: graphSupport,
        },
      ),
    ],
    "high-upside-bet": [
      hypothesisFromTemplate(
        `A high-upside hypothesis is that ${anchorA || contextDriver}-specific variation reveals a more decision-relevant effect than the average ${leadExposure}-${leadOutcome} relationship.`,
        `High-upside brainstorming should nominate a narrower but more original and higher-impact family for validation.`,
        titles.slice(0, 4),
        {
          idPrefix: "hyp-high-upside",
          family: "high-upside-bet",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorA || contextDriver,
          direction: "conditional",
          mechanism: anchorA || contextDriver,
          graph_support: graphSupport,
          impact: 0.82,
        },
      ),
      hypothesisFromTemplate(
        `${leadExposure} may only produce a high-impact improvement in ${leadOutcome} within a neglected subgroup defined by ${anchorB || "zero-dose concentration"}.`,
        `This forces the planner to test a targeted, decision-relevant subgroup instead of repeating the average-case result.`,
        titles.slice(1, 5),
        {
          idPrefix: "hyp-high-upside",
          family: "high-upside-bet",
          x_variable: leadExposure,
          y_variable: leadOutcome,
          condition: anchorB || "zero-dose concentration",
          direction: "conditional",
          mechanism: anchorB || "zero-dose concentration",
          graph_support: graphSupport,
          impact: 0.85,
        },
      ),
    ],
  };

  return byFrame[frame] || [];
}

function buildScenarioHypotheses(papers, rolePlan, scenarios = []) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return [];
  const titles = uniqueTitles(papers, 8);
  if (titles.length === 0) return [];
  const grounded = groundedVariableBundle(papers, rolePlan);
  // Without grounded variables we have nothing to bind the scenario
  // hypotheses against. Earlier code reached for grounded.x_variable
  // unconditionally and crashed when groundedVariableBundle now
  // returns null for cycles with no upstream-seeded codebook.
  if (!grounded) return [];
  const graphSupport = buildLiteratureGraph(papers, rolePlan, { hypothesis_scenarios: scenarios });
  const confounders = deriveConfounders(papers, rolePlan);
  const rivalExplanations = deriveRivalExplanations(papers, rolePlan);
  return scenarios.slice(0, 6).map((scenario, index) =>
    hypothesisFromTemplate(
      scenario.hypothesis || `Scenario hypothesis ${index + 1}`,
      `Search-derived scenario: ${scenario.validation_scenario || "validate with follow-up analysis"}`,
      titles.slice(0, 4),
      {
        idPrefix: "hyp-search-scenario",
        family: `search-scenario-${slugifyFragment(scenario.label || `scenario-${index + 1}`)}`,
        x_variable: grounded.x_variable,
        y_variable: grounded.y_variable,
        condition: grounded.z_variable,
        direction: "conditional",
        mechanism: (scenario.search_terms || []).join(", ") || scenario.label || grounded.z_label,
        confounders,
        rival_explanations: rivalExplanations,
        graph_support: graphSupport,
        support_paths: [graphSupport.anchor_path],
        validation_plan: [
          scenario.validation_scenario || "Validate with a targeted follow-up analysis.",
          `Expand literature search with: ${(scenario.search_terms || []).join(", ") || "scenario-specific terms"}.`,
          `Test whether ${grounded.x_variable} and ${grounded.y_variable} remain aligned under the scenario-specific mechanism.`,
        ],
        validation_protocol: {
          dataset: grounded.x?.dataset_id || "cycle-data-graph",
          model: "search-derived scenario validation model",
          comparison: `scenario test for ${scenario.label || `scenario-${index + 1}`}`,
          acceptance_criterion: `${grounded.x_variable} and ${grounded.y_variable} remain directionally consistent under the search-derived scenario.`,
        },
        impact: 0.78,
        directness: 0.66,
      },
    ));
}

function buildClaims(hypotheses) {
  const claims = [];
  const seen = new Set();
  for (const item of hypotheses) {
    for (const claim of item.claims || []) {
      if (!claim?.claim_id || seen.has(claim.claim_id)) continue;
      seen.add(claim.claim_id);
      claims.push({
        ...claim,
        status: "exploratory",
        source_hypothesis_id: item.hypothesis_id,
      });
    }
  }
  return claims.slice(0, 12);
}

function buildFamilyNomination(hypotheses, frontierCatalog) {
  const families = new Map();
  for (const item of hypotheses || []) {
    const familyRoot = String(item.family_root || inferFamilyRootFromVariable(item.x_variable, item.hypothesis_family)).trim();
    if (!familyRoot) continue;
    if (!families.has(familyRoot)) {
      families.set(familyRoot, {
        family_root: familyRoot,
        hypothesis_count: 0,
        sample_claims: [],
        primary_exposures: new Set(),
      });
    }
    const entry = families.get(familyRoot);
    entry.hypothesis_count += 1;
    if (item.primary_exposure) entry.primary_exposures.add(item.primary_exposure);
    if (entry.sample_claims.length < 3 && item.statement) entry.sample_claims.push(item.statement);
  }
  const frontierFamilies = Array.isArray(frontierCatalog?.candidate_primary_variable_families)
    ? frontierCatalog.candidate_primary_variable_families
    : Array.isArray(frontierCatalog?.primary_variable_families)
      ? frontierCatalog.primary_variable_families
    : [];
  return frontierFamilies.map((item) => {
    const familyRoot = item.family_id || item.family;
    const match = families.get(familyRoot) || {
      hypothesis_count: 0,
      sample_claims: [],
      primary_exposures: new Set(),
    };
    return {
      family_root: familyRoot,
      support_count: Number(item.support_count || 0),
      hypothesis_count: match.hypothesis_count,
      nominated: match.hypothesis_count > 0,
      primary_exposures: Array.from(match.primary_exposures || []),
      sample_claims: match.sample_claims || [],
      mechanisms: item.mechanism_ids || item.mechanisms || [],
    };
  });
}

function buildFallbackFrontierCatalog(hypotheses, frontierCatalog = {}, rolePlan = {}, papers = []) {
  const primaryFamilies = Array.isArray(frontierCatalog?.candidate_primary_variable_families)
    ? frontierCatalog.candidate_primary_variable_families.filter((item) => item && (item.family_id || item.family))
    : Array.isArray(frontierCatalog?.primary_variable_families)
      ? frontierCatalog.primary_variable_families.filter((item) => item && item.family)
    : [];
  if (primaryFamilies.length > 0) return createFrontierCatalog(frontierCatalog);

  const families = new Map();
  const seedFamilies = Array.isArray(rolePlan?.candidate_primary_families)
    ? rolePlan.candidate_primary_families
    : [];
  for (const seed of seedFamilies) {
    const familyRoot = String(seed?.family || seed?.family_root || "").trim();
    if (!familyRoot) continue;
    families.set(familyRoot, {
      family: familyRoot,
      members: Array.isArray(seed?.members) ? seed.members.slice(0, 6) : [],
      support_count: Number(seed?.support_count || 0),
      mechanisms: Array.isArray(seed?.mechanisms) ? seed.mechanisms.slice(0, 4) : [],
      rival_status: "candidate_primary",
    });
  }

  for (const item of hypotheses || []) {
    const familyRoot = String(item.family_root || inferFamilyRootFromVariable(item.x_variable, item.hypothesis_family)).trim();
    if (!familyRoot) continue;
    if (!families.has(familyRoot)) {
      families.set(familyRoot, {
        family: familyRoot,
        members: [],
        support_count: 0,
        mechanisms: [],
        rival_status: "candidate_primary",
      });
    }
    const entry = families.get(familyRoot);
    entry.support_count += 1;
    if (item.primary_exposure && entry.members.length < 6 && !entry.members.includes(item.primary_exposure)) {
      entry.members.push(item.primary_exposure);
    }
    for (const mechanism of Array.isArray(item.mechanism_path) ? item.mechanism_path : []) {
      if (entry.mechanisms.length >= 4) break;
      if (!entry.mechanisms.includes(mechanism)) entry.mechanisms.push(mechanism);
    }
  }

  // The previous implementation walked each paper's text and tagged
  // it into one of five fixed WHO families (zero_dose_burden,
  // maternal_newborn_care, equity_gap, measurement_quality,
  // immunization_coverage) by keyword match. That synthesised WHO
  // families out of any cycle's papers, even when they had nothing
  // to do with WHO. Domain-neutral version now relies on the families
  // upstream agents (lab-director, analyst) actually nominated above
  // — papers contribute support counts to those, not new ones.

  return createFrontierCatalog({
    primary_variable_families: Array.from(families.values())
      .sort((a, b) => b.support_count - a.support_count || a.family.localeCompare(b.family)),
  });
}

function buildFamilyTournament(hypotheses) {
  const counts = new Map();
  for (const item of hypotheses || []) {
    const familyRoot = String(item.family_root || inferFamilyRootFromVariable(item.x_variable, item.hypothesis_family)).trim();
    if (!familyRoot) continue;
    counts.set(familyRoot, (counts.get(familyRoot) || 0) + 1);
  }
  const ranked = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family_root, hypothesis_count]) => ({ family_root, hypothesis_count }));
  return {
    family_count: ranked.length,
    ranking: ranked,
    top_k_family_diversity: ranked.slice(0, 3).length,
  };
}

module.exports = {
  buildFamilyRootHypotheses,
  hypothesisFromTemplate,
  buildHypotheses,
  buildBrainstormHypotheses,
  buildScenarioHypotheses,
  buildClaims,
  buildFamilyNomination,
  buildFallbackFrontierCatalog,
  buildFamilyTournament,
};
