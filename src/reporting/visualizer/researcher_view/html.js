"use strict";

const {
  escapeHtml,
  formatSigned,
  formatPlain,
  formatPercent,
} = require("../shared");
const {
  barChartSvg,
  renderSignalScorecardSvg,
  renderPrimarySignalSummarySvg,
  renderPrimaryClaimBridgeSvg,
  renderSubgroupHeterogeneitySvg,
  renderRobustnessSvg,
  renderPromotedHypothesesSummarySvg,
  renderValidationCoverageSvg,
  renderMetricTiles,
  renderPriorityCards,
  renderRivalFamilyCards,
  renderList,
  renderKnowledgeGraphSummary,
  renderKnowledgeGraphExplorer,
} = require("../renderers");
const { researcherViewStyles } = require("./styles");

function renderResearcherViewHtml(context) {
  const {
    cycleId,
    artifacts,
    laneCounts,
    report,
    literature,
    followupProgress,
    validationSignals,
    analysisTraceBundle,
    openEndedExperimentBundle,
    analysisScoreboard,
    focusHypotheses,
    derivableHypothesisCandidates,
    challengedCount,
    demotedCount,
    familyNomination,
    familyTournament,
    familyPackageLedger,
    nextCyclePlan,
    validationResults,
    schemaQuality,
    hypothesisQualityScore,
    knowledgeGraphExplorer,
    knowledgeGraph,
    reasoningGraph,
    knowledgeGraphDigest,
    topPapers,
    reportedClaims,
    allClaims,
    claims,
    openQuestions,
    actions,
    dataAcquisition,
    analysisVisuals,
    promotedHypothesisValidation,
    chronicleReportDigest,
    illustratorIterations,
    chronicleCheckpoint,
    preferredLeadOutcome,
    openValidationGaps,
    reasoningClaims,
    promotedHypothesisRows,
    validationCoverageRows,
    primaryEvidence,
    visualNarrative,
    illustratorProvidedPackets,
    illustratorRefinementBrief,
    deterministicVisualPackets,
    visualQa,
    visualExecutionPackets,
    graphItems,
    conclusion,
    rivalFamilyAdjudication,
    evidenceReadiness,
    conclusionScore,
    conclusionBand,
    conclusionBlockers,
    conclusionRubric,
    leadLabel,
    leadAdjustedValue,
    hasExecutedLeadOutcome,
    researcherSummary,
    researcherLimits,
    nextAction,
    nextApprovalStep,
    executionCompletion,
    finalClaimPackage,
  } = context;

const chronicleSummaryMetrics = [
    {
      label: "High-Signal Lanes",
      value: String((chronicleReportDigest.latest_high_signal_lane_ids || []).length || 0),
      note: (chronicleReportDigest.latest_high_signal_lane_ids || []).slice(0, 2).join(", ") || "No high-signal lane tagged yet",
      tone: (chronicleReportDigest.latest_high_signal_lane_ids || []).length ? "positive" : "mixed",
    },
    {
      label: "Robust Claims",
      value: String((chronicleReportDigest.robust_vs_exploratory?.robust || []).length || 0),
      note: `${String((chronicleReportDigest.robust_vs_exploratory?.exploratory || []).length || 0)} exploratory still visible`,
      tone: (chronicleReportDigest.robust_vs_exploratory?.robust || []).length ? "positive" : "mixed",
    },
    {
      label: "Analysis Lanes",
      value: String(analysisScoreboard.lane_count || 0),
      note: `method ${analysisScoreboard.score_ranges?.method_appropriateness?.min ?? "n/a"}-${analysisScoreboard.score_ranges?.method_appropriateness?.max ?? "n/a"} | accuracy ${analysisScoreboard.score_ranges?.analysis_accuracy?.min ?? "n/a"}-${analysisScoreboard.score_ranges?.analysis_accuracy?.max ?? "n/a"}`,
      tone: Number(analysisScoreboard.lane_count || 0) >= 8 ? "positive" : "neutral",
    },
    {
      label: "Approval Blockers",
      value: String((chronicleReportDigest.approval_blockers || []).length || 0),
      note: (chronicleReportDigest.approval_blockers || [])[0] || "No blocker recorded",
      tone: (chronicleReportDigest.approval_blockers || []).length ? "mixed" : "positive",
    },
  ];
  const graphDigestMetrics = [
    {
      label: "Literature Graph",
      value: `${knowledgeGraphDigest.literature_graph?.node_count || 0} nodes`,
      note: `${knowledgeGraphDigest.literature_graph?.edge_count || 0} edges | ${(knowledgeGraphDigest.literature_graph?.hypothesis_count || 0)} hypotheses`,
      tone: "neutral",
    },
    {
      label: "Reasoning Graph",
      value: `${knowledgeGraphDigest.reasoning_graph?.claim_count || 0} claims`,
      note: `${knowledgeGraphDigest.reasoning_graph?.analysis_result_count || 0} analyses | ${(knowledgeGraphDigest.reasoning_graph?.test_count || 0)} tests | ${(knowledgeGraphDigest.reasoning_graph?.unresolved_gap_count || 0)} gaps`,
      tone: Number(knowledgeGraphDigest.reasoning_graph?.unresolved_gap_count || 0) > 0 ? "mixed" : "positive",
    },
    {
      label: "Data Graph",
      value: `${knowledgeGraphDigest.data_graph?.node_count || 0} nodes`,
      note: `${knowledgeGraphDigest.data_graph?.edge_count || 0} edges | ${(knowledgeGraphDigest.data_graph?.hypothesis_count || 0)} hypotheses`,
      tone: "neutral",
    },
    {
      label: "Selected Grades",
      value: `${analysisScoreboard.selected_grade_totals?.robust || 0} robust`,
      note: `${analysisScoreboard.selected_grade_totals?.exploratory || 0} exploratory | ${analysisScoreboard.selected_grade_totals?.weak || 0} weak`,
      tone: Number(analysisScoreboard.selected_grade_totals?.robust || 0) > Number(analysisScoreboard.selected_grade_totals?.exploratory || 0) ? "positive" : "mixed",
    },
  ];
  const topLaneScoreRows = (Array.isArray(analysisScoreboard.lane_rows) ? analysisScoreboard.lane_rows : [])
    .slice()
    .sort((left, right) =>
      Number(right.analysis_accuracy_score || 0) - Number(left.analysis_accuracy_score || 0) ||
      Number(right.selected_grade_counts?.robust || 0) - Number(left.selected_grade_counts?.robust || 0) ||
      String(left.lane_id || "").localeCompare(String(right.lane_id || "")),
    )
    .slice(0, 4);
  const chartPriorityRows = visualNarrative.chart_priority_list.slice(0, 6);
  const rivalFamilyRows = rivalFamilyAdjudication.slice(0, 5);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ResearchLab View: ${escapeHtml(cycleId)}</title>
  <style>
${researcherViewStyles}
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>${escapeHtml(cycleId)}</h1>
      <p>${escapeHtml(artifacts.cyclePlan.objective || "Autonomous research cycle")}</p>
      <p class="meta">This view is generated by the visualizer agent to help a time-constrained researcher judge whether the current cycle is strong enough for final approval without digging through raw runtime files.</p>
      <div class="hero-grid">
        <div class="signal-banner">
          <div class="k">Fast Read</div>
          <h2>${escapeHtml(visualNarrative.strongest_claim_summary)}</h2>
          <p class="meta">Read this page top to bottom as an approval path: adjusted signal first, pooled context second, subgroup heterogeneity third, leave-one-group-out robustness fourth.</p>
          <div class="verdict-strip">
            <div class="k">Approval Verdict</div>
            <strong>${escapeHtml(visualNarrative.hero_verdict.verdict)}</strong>
            <div class="meta">${escapeHtml(visualNarrative.hero_verdict.subtitle)}</div>
            ${
              visualNarrative.hero_verdict.supporting_points.length
                ? `
                  <div class="verdict-points">
                    ${visualNarrative.hero_verdict.supporting_points.map((item) => `<span class="verdict-pill">${escapeHtml(item)}</span>`).join("")}
                  </div>
                `
                : ""
            }
          </div>
          ${
            primaryEvidence
              ? `
                <div class="badge-row">
                  <span class="evidence-badge">source ${escapeHtml(primaryEvidence.lane_id)}</span>
                  <span class="evidence-badge">${escapeHtml(primaryEvidence.row_count)} rows</span>
                  <span class="evidence-badge">${escapeHtml(primaryEvidence.group_count ?? primaryEvidence.country_count ?? "n/a")} groups</span>
                  <span class="evidence-badge">${escapeHtml(primaryEvidence.year_range.join(" to ") || "n/a")}</span>
                  <span class="evidence-badge">checks ${escapeHtml(primaryEvidence.checks_passed_count)}/${escapeHtml(primaryEvidence.checks_total_count)}</span>
                  <span class="evidence-badge">bootstrap ${escapeHtml(formatPercent(primaryEvidence.bootstrap_positive_share))} positive</span>
                  <span class="evidence-badge">perm p=${escapeHtml(formatPlain(primaryEvidence.permutation_p_value, 4))}</span>
                </div>
              `
              : ""
          }
          ${
            visualNarrative.fast_review_cards.length
              ? `
                <div class="answer-grid">
                  ${visualNarrative.fast_review_cards.map((item) => `
                    <article class="answer-card" data-tone="${escapeHtml(item.tone || "positive")}">
                      <div class="k">${escapeHtml(item.title)}</div>
                      <div class="value">${escapeHtml(item.value)}</div>
                      <div class="meta">${escapeHtml(item.note || "")}</div>
                    </article>
                  `).join("")}
                </div>
              `
              : ""
          }
          ${
            visualNarrative.evidence_checkpoints.length
              ? `
                <div class="checkpoint-grid">
                  ${visualNarrative.evidence_checkpoints.map((item) => `
                    <article class="checkpoint-card" data-tone="${escapeHtml(item.tone || "positive")}">
                      <div class="k">${escapeHtml(item.label)}</div>
                      <div class="value">${escapeHtml(item.value)}</div>
                      <div class="meta">${escapeHtml(item.note || "")}</div>
                    </article>
                  `).join("")}
                </div>
              `
              : ""
          }
          ${
            visualNarrative.approval_path.length
              ? `
                <div class="path-grid">
                  ${visualNarrative.approval_path.map((item) => `
                    <article class="path-card">
                      <div class="path-step">${escapeHtml(item.step)}</div>
                      <div class="k">${escapeHtml(item.label)}</div>
                      <div class="value">${escapeHtml(item.value)}</div>
                      <div class="meta">${escapeHtml(item.note || "")}</div>
                    </article>
                  `).join("")}
                </div>
              `
              : ""
          }
        </div>
        <div class="hero-side">
          <article class="hero-card">
            <div class="k">Decision Summary</div>
            <strong>${escapeHtml(conclusion.band)}</strong>
            <div class="meta">Conclusion readiness ${escapeHtml(conclusion.score)}. The visual narrative is tuned to the assigned ${escapeHtml((visualNarrative.lead_outcome_label || "primary hypothesis").toLowerCase())} claim rather than generic cycle monitoring.</div>
            <div class="metric-grid">
              <div class="metric-chip">
                <div class="k">Adj. Signal</div>
                <div class="value">${escapeHtml(formatSigned(leadAdjustedValue))}</div>
              </div>
              <div class="metric-chip">
                <div class="k">Sensitivity</div>
                <div class="value">${escapeHtml(
                  Number.isFinite(primaryEvidence?.robustness_min) && Number.isFinite(primaryEvidence?.robustness_max)
                    ? `${formatSigned(primaryEvidence.robustness_min)} to ${formatSigned(primaryEvidence.robustness_max)}`
                    : "n/a"
                )}</div>
              </div>
              <div class="metric-chip">
                <div class="k">Group Support</div>
                <div class="value">${escapeHtml(primaryEvidence?.total_groups ? `${primaryEvidence.directionally_consistent_groups ?? "n/a"}/${primaryEvidence.total_groups}` : "n/a")}</div>
              </div>
              <div class="metric-chip">
                <div class="k">Method Score</div>
                <div class="value">${escapeHtml(Number.isFinite(primaryEvidence?.method_score) ? primaryEvidence.method_score : "n/a")}</div>
              </div>
            </div>
          </article>
          <article class="hero-card">
            <div class="k">Chronicle At A Glance</div>
            <div class="meta">This cycle now has explicit reporting deltas, score ranges, and rival-family competition summaries. Surface these next to the main chart so the researcher sees both effect direction and approval risk in one pass.</div>
            ${renderMetricTiles(chronicleSummaryMetrics)}
          </article>
          <article class="hero-card">
            <div class="k">Why This Is Fast To Review</div>
            <ol class="decision-list">
              <li>The first chart answers the assignment directly: the adjusted ${escapeHtml((visualNarrative.lead_outcome_label || "primary").toLowerCase())} signal is tied to generated evidence.</li>
              <li>The next two visuals show scope and heterogeneity without forcing the researcher into tables.</li>
              <li>The last primary visual keeps source, validation, and unresolved gap evidence visible together.</li>
            </ol>
          </article>
          ${
            visualNarrative.reviewer_objections.length
              ? `
                <article class="hero-card">
                  <div class="k">Reviewer Objections</div>
                  <div class="objection-grid">
                    ${visualNarrative.reviewer_objections.map((item) => `
                      <div class="objection-card">
                        <strong>${escapeHtml(item.title)}</strong>
                        <div class="meta">${escapeHtml(item.answer || "")}</div>
                      </div>
                    `).join("")}
                  </div>
                </article>
              `
              : ""
          }
        </div>
      </div>
    </section>

    <section class="layout">
      <div class="stack">
        <section class="panel">
          <h2>Approval-Ready Visuals</h2>
          <div class="evidence-strip">
            ${
              visualNarrative.primary_signal_rows.length
                ? `
                  <article class="visual-card">
                    <div class="k">Assigned Hypothesis</div>
                    <h3>${escapeHtml(`${visualNarrative.lead_outcome_label || "Primary Outcome"} Across Checks`)}</h3>
                    <div class="meta">Focused on the approval question: does the adjusted ${escapeHtml((visualNarrative.lead_outcome_label || "primary outcome").toLowerCase())} signal survive adjustment, alternate specifications, and simple robustness checks?${primaryEvidence ? ` Source ${escapeHtml(primaryEvidence.lane_id)} with ${escapeHtml(primaryEvidence.row_count)} rows${primaryEvidence.country_count ? ` across ${escapeHtml(primaryEvidence.country_count)} groups` : ""}.` : ""}</div>
                    ${
                      visualNarrative.claim_bridge_rows.length
                        ? renderPrimaryClaimBridgeSvg(visualNarrative.claim_bridge_rows, {
                            title: `${visualNarrative.lead_outcome_label || "Primary outcome"} claim bridge`,
                            claimLabel: "Lead claim",
                            supportRangeLabel: "Support checks stay",
                            summaryText: "The adjusted estimate is the decision point; pooled, sensitivity, and validation checks show whether the claim remains supportable when the framing changes.",
                          })
                        : ""
                    }
                    ${renderPrimarySignalSummarySvg(visualNarrative.primary_signal_rows, {
                      title: `${visualNarrative.lead_outcome_label || "Primary outcome"} across checks`,
                      summaryText: "Adjustment changes the pooled signal; decision-critical checks show whether the promoted claim remains supportable.",
                      supportLabel: "supports hypothesis",
                      opposeLabel: "opposes hypothesis",
                    })}
                    <div class="takeaway">${escapeHtml((visualNarrative.visual_takeaways.find((item) => item.kind === visualNarrative.primary_visual_kind) || {}).takeaway || "")}</div>
                  </article>
                `
                : ""
            }
            ${
              visualNarrative.primary_outcome_rows.length
                ? `
                  <article class="visual-card">
                    <div class="k">Primary Outcome</div>
                    <h3>Core Association Signals</h3>
                      <div class="meta">Pooled view of the main evidence rows so the researcher can compare directions in one glance.</div>
                    ${renderSignalScorecardSvg(visualNarrative.primary_outcome_rows, { title: "Core association signals" })}
                    <div class="takeaway">${escapeHtml((visualNarrative.visual_takeaways.find((item) => item.kind === "pooled-correlation") || {}).takeaway || "")}</div>
                  </article>
                `
                : ""
            }
            <div class="evidence-grid">
              ${
                analysisVisuals.find((item) => item.kind === "subgroup-heterogeneity")
                  ? `
                    <article class="visual-card">
                      <div class="k">Heterogeneity</div>
                      <h3>Subgroup Heterogeneity</h3>
                      <div class="meta">Magnitude varies across available subgroups.</div>
                      ${renderSubgroupHeterogeneitySvg(analysisVisuals.find((item) => item.kind === "subgroup-heterogeneity").items, { title: "Subgroup heterogeneity" })}
                      <div class="takeaway">${escapeHtml((visualNarrative.visual_takeaways.find((item) => item.kind === "subgroup-heterogeneity") || {}).takeaway || "")}</div>
                    </article>
                  `
                  : ""
              }
              ${
                analysisVisuals.find((item) => item.kind === "leave-one-group-out")
                  ? `
                    <article class="visual-card">
                      <div class="k">Robustness</div>
                      <h3>Leave-One-Group-Out</h3>
                      <div class="meta">Reviewer objection check: does one subgroup drive the result?</div>
                      ${renderRobustnessSvg(analysisVisuals.find((item) => item.kind === "leave-one-group-out").items, { title: "Leave-one-group-out robustness" })}
                      <div class="takeaway">${escapeHtml((visualNarrative.visual_takeaways.find((item) => item.kind === "leave-one-group-out") || {}).takeaway || "")}</div>
                    </article>
                  `
                  : ""
              }
            </div>
            <div class="evidence-grid">
              ${
                promotedHypothesisRows.length
                  ? `
                    <article class="visual-card">
                      <div class="k">Promoted Claims</div>
                      <h3>Promoted Hypothesis Coverage</h3>
                      <div class="meta">Validation lane coverage by promoted hypothesis. This varies with what the cycle actually promoted, so it should not collapse to the same fixed chart every run.</div>
                      ${renderPromotedHypothesesSummarySvg(promotedHypothesisRows, { title: "Promoted hypothesis coverage" })}
                    </article>
                  `
                  : ""
              }
              ${
                Array.from(validationCoverageRows.values()).length
                  ? `
                    <article class="visual-card">
                      <div class="k">Validation Matrix</div>
                      <h3>Validation Coverage</h3>
                      <div class="meta">Passed validation checks by lane and validation profile.</div>
                      ${renderValidationCoverageSvg(Array.from(validationCoverageRows.values()).slice(0, 8), { title: "Validation coverage" })}
                    </article>
                  `
                  : ""
              }
            </div>
          </div>
        </section>

        <section class="panel">
          <h2>Researcher Memo</h2>
          <h3>What To Say</h3>
          ${renderList(researcherSummary, (item) => escapeHtml(item))}
          <h3>What Not To Overclaim</h3>
          ${renderList(researcherLimits, (item) => escapeHtml(item))}
          <h3>Next Approval Step</h3>
          <p>${escapeHtml(nextApprovalStep)}</p>
        </section>

        <section class="panel">
          <h2>Chronicle Digest</h2>
          <p class="meta">Condensed reporting checks for director review: score distribution, graph scope, and the changes that materially strengthened this pass.</p>
          ${renderMetricTiles(graphDigestMetrics)}
          <h3>What Changed</h3>
          ${renderList(chronicleReportDigest.what_changed_since_previous_pass, (item) => escapeHtml(item))}
          <h3>High-Signal Lanes</h3>
          ${
            topLaneScoreRows.length
              ? renderPriorityCards(topLaneScoreRows.map((item, index) => ({
                  priority: index + 1,
                  title: item.lane_id,
                  why_it_matters: `accuracy ${item.analysis_accuracy_score} | robust selected ${(item.selected_grade_counts || {}).robust || 0} | exploratory selected ${(item.selected_grade_counts || {}).exploratory || 0}`,
                })))
              : "<p class=\"empty\">No lane score summary yet.</p>"
          }
          <h3>Approval Blockers</h3>
          ${renderList(chronicleReportDigest.approval_blockers, (item) => escapeHtml(item))}
        </section>
      </div>

      <div class="stack">
        <section class="panel">
          <h2>Chart Priority</h2>
          <p class="meta">This is the intended reading order for a time-constrained researcher. If a chart does not affect the decision, it should not appear above this stack.</p>
          ${renderPriorityCards(chartPriorityRows)}
        </section>

        <section class="panel">
          <h2>Figure Recommendations</h2>
          ${
            visualNarrative.figure_recommendations.length
              ? renderList(
                  visualNarrative.figure_recommendations,
                  (item) => `<strong>${escapeHtml(item.title)}</strong><br><span class="meta">${escapeHtml(item.chart_type)} | ${escapeHtml(item.priority)} priority</span><br><span class="meta">${escapeHtml(item.takeaway)}</span>`,
                )
              : "<p class=\"empty\">No figure recommendations yet.</p>"
          }
        </section>

        <section class="panel">
          <h2>Approval Readiness</h2>
          <p><strong>${escapeHtml(conclusion.band)}</strong></p>
          ${renderList(conclusion.reasons, (item) => escapeHtml(item))}
        </section>

        <section class="panel">
          <h2>Rival-Family Adjudication</h2>
          <p class="meta">The strongest result is not enough on its own. This panel shows whether the incumbent family is actually separating from rival explanatory families on support, lane coverage, and validation volume.</p>
          ${renderRivalFamilyCards(rivalFamilyRows)}
        </section>

        <section class="panel">
          <h2>Approval Rubric</h2>
          ${
            conclusion.rubric
              .map(
                (item) => `
            <div class="rubric-row">
              <div><strong>${escapeHtml(item.name)}</strong><div class="meta">weight ${(Number(item.weight || 0) * 100).toFixed(0)}%</div></div>
              <div><span class="score-pill">${escapeHtml(item.score)}</span></div>
              <div class="meta">${item.reasons.length ? escapeHtml(item.reasons.join(" | ")) : "No major blocker at this stage."}</div>
            </div>`,
              )
              .join("")
          }
        </section>

        <section class="panel">
          <h2>Visual Improvement Notes</h2>
          ${renderList(visualNarrative.visual_improvement_notes, (item) => escapeHtml(item))}
        </section>
      </div>
    </section>
  </main>
  <script>
    (function () {
      const dataEl = document.getElementById("kg-data");
      if (!dataEl) return;
      const KG_WIDTH = 1400;
      const KG_HEIGHT = 860;
      const explorer = JSON.parse(dataEl.textContent || "{}");
      const viewTabs = Array.from(document.querySelectorAll("[data-view-target]"));
      const svg = document.getElementById("kg-canvas");
      const titleEl = document.getElementById("kg-title");
      const statsEl = document.getElementById("kg-stats");
      const legendEl = document.getElementById("kg-legend");
      const zoomInEl = document.getElementById("kg-zoom-in");
      const zoomOutEl = document.getElementById("kg-zoom-out");
      const resetViewEl = document.getElementById("kg-reset-view");
      const hypothesesEl = document.getElementById("kg-hypotheses");
      const nodesEl = document.getElementById("kg-nodes");
      const edgesEl = document.getElementById("kg-edges");
      const inspectorBodyEl = document.getElementById("kg-inspector-body");
      const tabs = Array.from(document.querySelectorAll("[data-graph-target]"));
      const palette = {
        paper: "#2563eb",
        query: "#7c3aed",
        concept: "#0f766e",
        condition: "#d97706",
        variable: "#0891b2",
        hypothesis: "#dc2626",
        evidence: "#16a34a",
      };
      let activeSelection = null;
      let currentTransform = { scale: 1, x: 0, y: 0 };
      let dragState = null;

      function escape(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function nodeTypeOrder(type) {
        return ["query", "paper", "concept", "variable", "condition", "evidence", "hypothesis"].indexOf(type);
      }

      function buildLegend() {
        const order = ["paper", "query", "concept", "variable", "condition", "evidence", "hypothesis"];
        legendEl.innerHTML = order.map((type) =>
          '<div class="kg-chip"><span class="kg-swatch" style="background:' + (palette[type] || "#334155") + '"></span>' +
          escape(type) + '</div>'
        ).join("");
      }

      function buildLayout(graph) {
        const width = KG_WIDTH;
        const height = KG_HEIGHT;
        const nodes = (graph.nodes || []).map((node, index) => ({
          ...node,
          x: 180 + (index % 6) * 190,
          y: 140 + Math.floor(index / 6) * 105,
          vx: 0,
          vy: 0,
        }));
        const byId = new Map(nodes.map((node) => [node.node_id, node]));
        const typeBias = new Map([
          ["query", { x: 140, y: 110 }],
          ["paper", { x: 280, y: 220 }],
          ["concept", { x: 520, y: 310 }],
          ["variable", { x: 920, y: 310 }],
          ["condition", { x: 1180, y: 220 }],
          ["evidence", { x: 1180, y: 610 }],
          ["hypothesis", { x: 740, y: 640 }],
        ]);

        for (let step = 0; step < 220; step += 1) {
          for (let i = 0; i < nodes.length; i += 1) {
            const a = nodes[i];
            const bias = typeBias.get(a.type || "concept") || { x: width / 2, y: height / 2 };
            a.vx += (bias.x - a.x) * 0.0009;
            a.vy += (bias.y - a.y) * 0.0009;

            for (let j = i + 1; j < nodes.length; j += 1) {
              const b = nodes[j];
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              const dist2 = Math.max(1, dx * dx + dy * dy);
              const repulse = 1400 / dist2;
              a.vx += (dx / Math.sqrt(dist2)) * repulse;
              a.vy += (dy / Math.sqrt(dist2)) * repulse;
              b.vx -= (dx / Math.sqrt(dist2)) * repulse;
              b.vy -= (dy / Math.sqrt(dist2)) * repulse;
            }
          }

          for (const edge of graph.edges || []) {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) continue;
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
            const desired = source.type === "hypothesis" || target.type === "hypothesis" ? 120 : 150;
            const pull = (dist - desired) * 0.0022;
            const ux = dx / dist;
            const uy = dy / dist;
            source.vx += ux * pull;
            source.vy += uy * pull;
            target.vx -= ux * pull;
            target.vy -= uy * pull;
          }

          for (const node of nodes) {
            node.x = Math.max(70, Math.min(width - 70, node.x + node.vx));
            node.y = Math.max(70, Math.min(height - 50, node.y + node.vy));
            node.vx *= 0.72;
            node.vy *= 0.72;
          }
        }

        return new Map(nodes.map((node) => [node.node_id, { x: node.x, y: node.y }]));
      }

      function truncate(value, size) {
        const text = String(value || "");
        return text.length > size ? text.slice(0, size - 1) + "…" : text;
      }

      function renderInspector(payload) {
        if (!payload) {
          inspectorBodyEl.innerHTML = "Click a node or edge to inspect it.";
          return;
        }
        if (payload.kind === "node") {
          inspectorBodyEl.innerHTML =
            "<strong>" + escape(payload.item.label || payload.item.node_id) + "</strong><br>" +
            '<span class="meta">type ' + escape(payload.item.type || "node") + " | linked hypotheses " + escape((payload.item.linked_hypotheses || []).length) + "</span><br>" +
            '<span class="meta">' + escape(payload.item.node_id || "") + "</span>";
          return;
        }
        inspectorBodyEl.innerHTML =
          "<strong>" + escape(payload.item.relation || "edge") + "</strong><br>" +
          '<span class="meta">' + escape(payload.item.source || "") + " → " + escape(payload.item.target || "") + "</span><br>" +
          '<span class="meta">linked hypotheses ' + escape((payload.item.linked_hypotheses || []).length) + "</span>";
      }

      function clampScale(value) {
        return Math.max(0.55, Math.min(2.4, value));
      }

      function applyViewportTransform() {
        const viewport = svg.querySelector("[data-kg-viewport]");
        if (!viewport) return;
        viewport.setAttribute(
          "transform",
          "translate(" + currentTransform.x + " " + currentTransform.y + ") scale(" + currentTransform.scale + ")",
        );
      }

      function setTransform(next) {
        currentTransform = {
          scale: clampScale(next.scale),
          x: next.x,
          y: next.y,
        };
        applyViewportTransform();
      }

      function resetTransform() {
        setTransform({ scale: 1, x: 0, y: 0 });
      }

      function zoomAt(delta, anchorX, anchorY) {
        const nextScale = clampScale(currentTransform.scale * delta);
        const scaleRatio = nextScale / currentTransform.scale;
        const nextX = anchorX - (anchorX - currentTransform.x) * scaleRatio;
        const nextY = anchorY - (anchorY - currentTransform.y) * scaleRatio;
        setTransform({ scale: nextScale, x: nextX, y: nextY });
      }

      function bezierPath(start, end) {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const curve = Math.max(24, Math.min(90, Math.abs(dx) * 0.25 + Math.abs(dy) * 0.12));
        const c1x = start.x + dx * 0.35;
        const c1y = start.y - curve;
        const c2x = end.x - dx * 0.35;
        const c2y = end.y + curve * 0.2;
        return "M " + start.x + " " + start.y + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + end.x + " " + end.y;
      }

      function renderGraph(key) {
        const graph = explorer[key] || { nodes: [], edges: [], hypotheses: [] };
        activeSelection = null;
        renderInspector(null);
        tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.graphTarget === key));
        titleEl.textContent = key === "literature_graph" ? "Literature Knowledge Graph" : "Data Knowledge Graph";
        statsEl.textContent = "nodes " + (graph.nodes || []).length + " | edges " + (graph.edges || []).length + " | hypotheses " + (graph.hypotheses || []).length;

        const layout = buildLayout(graph);
        const edgeMarkup = (graph.edges || []).map((edge) => {
          const start = layout.get(edge.source);
          const end = layout.get(edge.target);
          if (!start || !end) return "";
          const midX = (start.x + end.x) / 2;
          const midY = (start.y + end.y) / 2 - 10;
          const path = bezierPath(start, end);
          const edgeId = escape(edge.source + "|" + (edge.relation || "related") + "|" + edge.target);
          return '<g class="kg-edge" data-edge-id="' + edgeId + '">' +
            '<path d="' + path + '" class="kg-edge-line"></path>' +
            '<text x="' + midX + '" y="' + midY + '" text-anchor="middle" class="kg-edge-label">' + escape(edge.relation || "related") + '</text>' +
            '</g>';
        }).join("");

        const nodeMarkup = (graph.nodes || []).map((node) => {
          const point = layout.get(node.node_id) || { x: 100, y: 100 };
          const fill = palette[node.type] || "#334155";
          const width = node.type === "hypothesis" ? 164 : 120;
          const height = node.type === "hypothesis" ? 42 : 34;
          const x = point.x - width / 2;
          const y = point.y - height / 2;
          return '<g class="kg-node" data-node-id="' + escape(node.node_id) + '">' +
            '<rect x="' + (x + 4) + '" y="' + (y + 6) + '" width="' + width + '" height="' + height + '" rx="16" class="kg-node-shadow"></rect>' +
            '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" rx="16" fill="' + fill + '" class="kg-node-shape"></rect>' +
            '<text x="' + point.x + '" y="' + (point.y - 2) + '" text-anchor="middle" class="kg-node-label">' + escape(truncate(node.label || node.node_id, node.type === "hypothesis" ? 24 : 18)) + '</text>' +
            '<text x="' + point.x + '" y="' + (point.y + 12) + '" text-anchor="middle" class="kg-node-meta">' + escape(node.type || "node") + '</text>' +
            '</g>';
        }).join("");

        svg.innerHTML =
          '<defs><linearGradient id="kg-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f8fafc"></stop><stop offset="100%" stop-color="#eef6f4"></stop></linearGradient></defs>' +
          '<rect x="0" y="0" width="' + KG_WIDTH + '" height="' + KG_HEIGHT + '" fill="url(#kg-bg)"></rect>' +
          '<g data-kg-viewport="true">' + edgeMarkup + nodeMarkup + '</g>';
        resetTransform();

        hypothesesEl.innerHTML = (graph.hypotheses || []).length
          ? '<div class="kg-list">' + graph.hypotheses.map((item) =>
              '<div class="kg-list-item"><strong>' + escape(item.hypothesis_id || "hypothesis") + '</strong><div class="meta">' +
              escape(item.state || "unknown") + ' | score ' + escape(item.score || 0) + '</div><div class="meta">' +
              escape(item.statement || "") + '</div></div>'
            ).join("") + '</div>'
          : '<p class="empty">No hypotheses connected to this graph yet.</p>';

        nodesEl.innerHTML = (graph.nodes || []).length
          ? '<div class="kg-list">' + graph.nodes.map((node) =>
              '<div class="kg-list-item"><strong>' + escape(node.label || node.node_id) + '</strong><div class="meta">' +
              escape(node.type || "node") + ' | linked hypotheses ' + escape((node.linked_hypotheses || []).length) + '</div></div>'
            ).join("") + '</div>'
          : '<p class="empty">No nodes yet.</p>';

        edgesEl.innerHTML = (graph.edges || []).length
          ? '<div class="kg-list">' + graph.edges.map((edge) =>
              '<div class="kg-list-item"><strong>' + escape(edge.relation || "related") + '</strong><div class="meta">' +
              escape(edge.source) + ' -> ' + escape(edge.target) + '</div><div class="meta">linked hypotheses ' +
              escape((edge.linked_hypotheses || []).length) + '</div></div>'
            ).join("") + '</div>'
          : '<p class="empty">No edges yet.</p>';

        Array.from(svg.querySelectorAll(".kg-node")).forEach((el) => {
          el.addEventListener("click", function () {
            const nodeId = el.getAttribute("data-node-id");
            const node = (graph.nodes || []).find((item) => item.node_id === nodeId);
            activeSelection = { kind: "node", item: node };
            renderInspector(activeSelection);
            Array.from(svg.querySelectorAll(".kg-node-shape")).forEach((shape) => shape.classList.remove("active"));
            Array.from(svg.querySelectorAll(".kg-edge-line")).forEach((shape) => shape.classList.remove("active"));
            const shape = el.querySelector(".kg-node-shape");
            if (shape) shape.classList.add("active");
          });
        });

        Array.from(svg.querySelectorAll(".kg-edge")).forEach((el) => {
          el.addEventListener("click", function () {
            const edgeId = el.getAttribute("data-edge-id");
            const edge = (graph.edges || []).find((item) => (item.source + "|" + (item.relation || "related") + "|" + item.target) === edgeId);
            activeSelection = { kind: "edge", item: edge };
            renderInspector(activeSelection);
            Array.from(svg.querySelectorAll(".kg-node-shape")).forEach((shape) => shape.classList.remove("active"));
            Array.from(svg.querySelectorAll(".kg-edge-line")).forEach((shape) => shape.classList.remove("active"));
            const shape = el.querySelector(".kg-edge-line");
            if (shape) shape.classList.add("active");
          });
        });
      }

      svg.addEventListener("wheel", function (event) {
        event.preventDefault();
        const rect = svg.getBoundingClientRect();
        const anchorX = ((event.clientX - rect.left) / rect.width) * KG_WIDTH;
        const anchorY = ((event.clientY - rect.top) / rect.height) * KG_HEIGHT;
        zoomAt(event.deltaY < 0 ? 1.12 : 0.9, anchorX, anchorY);
      }, { passive: false });

      svg.addEventListener("pointerdown", function (event) {
        if (event.target.closest(".kg-node") || event.target.closest(".kg-edge")) return;
        dragState = {
          startX: event.clientX,
          startY: event.clientY,
          originX: currentTransform.x,
          originY: currentTransform.y,
        };
      });

      window.addEventListener("pointermove", function (event) {
        if (!dragState) return;
        setTransform({
          scale: currentTransform.scale,
          x: dragState.originX + (event.clientX - dragState.startX),
          y: dragState.originY + (event.clientY - dragState.startY),
        });
      });

      window.addEventListener("pointerup", function () {
        dragState = null;
      });

      zoomInEl.addEventListener("click", function () {
        zoomAt(1.16, KG_WIDTH / 2, KG_HEIGHT / 2);
      });

      zoomOutEl.addEventListener("click", function () {
        zoomAt(0.86, KG_WIDTH / 2, KG_HEIGHT / 2);
      });

      resetViewEl.addEventListener("click", function () {
        resetTransform();
      });

      tabs.forEach((tab) => {
        tab.addEventListener("click", function () {
          renderGraph(tab.dataset.graphTarget);
        });
      });

      viewTabs.forEach((tab) => {
        tab.addEventListener("click", function () {
          const target = tab.dataset.viewTarget;
          viewTabs.forEach((item) => item.classList.toggle("active", item === tab));
          Array.from(document.querySelectorAll(".view-panel")).forEach((panel) => {
            panel.classList.toggle("hidden", panel.id !== target);
          });
        });
      });

      buildLegend();
      renderGraph("literature_graph");
    }());
  </script>
</body>
</html>`;
  return html;
}

module.exports = {
  renderResearcherViewHtml,
};
