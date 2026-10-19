"use strict";

const { uniqueStrings, formatSigned, formatPlain } = require("../shared");

function enrichClaimsWithLedgerSupport(claims, hypothesisLedger) {
  const hypothesisEntries = Array.isArray(hypothesisLedger?.hypotheses) ? hypothesisLedger.hypotheses : [];
  const supportByClaimId = new Map();
  const lexicalSupport = [];

  function normalizeTokens(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((item) => item && item.length > 2);
  }

  for (const item of hypothesisEntries) {
    const promoted = Array.isArray(item.promoted_claim_ids) ? item.promoted_claim_ids : [];
    const papers = Array.isArray(item.paper_examples) ? item.paper_examples.slice(0, 5) : [];
    const statementTokens = normalizeTokens(item.statement);
    for (const claimId of promoted) {
      const key = String(claimId || "").trim();
      if (!key) continue;
      if (!supportByClaimId.has(key)) {
        supportByClaimId.set(key, new Set());
      }
      const bucket = supportByClaimId.get(key);
      for (const paper of papers) {
        if (paper) bucket.add(String(paper).trim());
      }
    }
    lexicalSupport.push({
      papers,
      statementTokens,
      clusterKey: String(item.cluster_key || "").trim(),
      supportBasis: Array.isArray(item.support_basis) ? item.support_basis : [],
    });
  }

  return (claims || []).map((claim) => {
    const existing = Array.isArray(claim.supporting_papers) ? claim.supporting_papers.filter(Boolean) : [];
    if (existing.length > 0) {
      return claim;
    }
    const claimId = String(claim.claim_id || "").trim();
    let derived = Array.from(supportByClaimId.get(claimId) || []);
    if (!derived.length) {
      const claimTokens = new Set(normalizeTokens(claim.statement || claim.reason || claimId));
      const scored = lexicalSupport
        .map((item) => {
          const overlap = item.statementTokens.filter((token) => claimTokens.has(token)).length;
          const basisBonus = item.supportBasis.includes("literature") ? 1 : 0;
          return {
            papers: item.papers,
            score: overlap + basisBonus,
          };
        })
        .filter((item) => item.score >= 2)
        .sort((a, b) => b.score - a.score);
      derived = scored.flatMap((item) => item.papers).filter(Boolean);
    }
    derived = Array.from(new Set(derived.map((item) => String(item).trim()).filter(Boolean))).slice(0, 5);
    return {
      ...claim,
      supporting_papers: derived,
    };
  });
}

function normalizeReportClaims(report) {
  const primaryClaims = Array.isArray(report?.primary_claims) ? report.primary_claims : [];
  const supportingClaims = Array.isArray(report?.supporting_claims) ? report.supporting_claims : [];
  const legacyClaims = Array.isArray(report?.claims) ? report.claims : [];
  const claims = primaryClaims.length || supportingClaims.length
    ? [...primaryClaims, ...supportingClaims]
    : legacyClaims;

  return claims.map((claim, index) => ({
    ...claim,
    claim_id: claim.claim_id || `report-claim-${index + 1}`,
    current: claim.current || claim.status || null,
    status: claim.status || claim.current || null,
    reason: claim.reason || claim.statement || claim.takeaway || null,
    supporting_hypothesis_ids: Array.isArray(claim.supporting_hypothesis_ids)
      ? claim.supporting_hypothesis_ids
      : Array.isArray(claim.supporting_hypotheses)
        ? claim.supporting_hypotheses
        : [],
  }));
}

function selectPrimaryConclusions(claims) {
  function rankClaim(claim) {
    const claimId = String(claim?.claim_id || "");
    const status = String(claim?.current || claim?.status || "");
    const laneCount = Array.isArray(claim?.supporting_lanes) ? claim.supporting_lanes.length : 0;
    const hypothesisCount = Array.isArray(claim?.supporting_hypothesis_ids)
      ? claim.supporting_hypothesis_ids.length
      : Array.isArray(claim?.supporting_hypotheses)
        ? claim.supporting_hypotheses.length
        : 0;
    const paperCount = Array.isArray(claim?.supporting_papers) ? claim.supporting_papers.length : 0;
    const idBonus = claimId.startsWith("claim-") ? 40 : 0;
    const statusBonus = status === "robust" ? 30 : status === "supported" ? 24 : status === "exploratory" ? 12 : 0;
    return idBonus + statusBonus + laneCount + hypothesisCount * 2 + paperCount * 3;
  }

  return [...(claims || [])]
    .sort((a, b) => rankClaim(b) - rankClaim(a))
    .slice(0, 2);
}

function provisionalClaimsFromHypotheses(hypothesisLedger, limit = 2) {
  const entries = Array.isArray(hypothesisLedger?.hypotheses) ? hypothesisLedger.hypotheses : [];
  const ranked = [...entries].sort((a, b) => {
    const aq = Number(a?.evidence_quality_score || 0);
    const bq = Number(b?.evidence_quality_score || 0);
    const as = Number(a?.support_count || 0);
    const bs = Number(b?.support_count || 0);
    return bq - aq || bs - as;
  });

  function reasonWithMethodSignals(item) {
    const base = String(item?.statement || "provisional conclusion");
    const protocolText = JSON.stringify(item?.validation_protocol || {}).toLowerCase();
    const supportPathText = JSON.stringify(item?.support_paths || []).toLowerCase();
    const evidenceText = JSON.stringify(item?.evidence || []).toLowerCase();
    const methodSignals = [];
    if (/adjust|confound/.test(protocolText + " " + evidenceText)) {
      methodSignals.push("confound-adjusted");
    }
    if (/robust|sensitivity|leave-one-group-out/.test(protocolText + " " + evidenceText)) {
      methodSignals.push("robustness sensitivity");
    }
    if (/lag/.test(protocolText + " " + evidenceText)) {
      methodSignals.push("lag analysis");
    }
    if (/missing/.test(evidenceText)) {
      methodSignals.push("missingness check");
    }
    if (methodSignals.length === 0 && /condition|comparison/.test(protocolText + " " + supportPathText)) {
      methodSignals.push("conditional sensitivity");
    }
    return methodSignals.length ? `${base} (${methodSignals.join(", ")})` : base;
  }

  return ranked.slice(0, limit).map((item, index) => ({
    claim_id: item?.claims?.[0]?.claim_id || `provisional-claim-${index + 1}`,
    current: item.latest_status || "exploratory",
    status: item.latest_status || "exploratory",
    statement: item?.claims?.[0]?.statement || item.statement || null,
    reason: reasonWithMethodSignals(item),
    supporting_lanes: Array.isArray(item.validating_lanes) ? item.validating_lanes : [],
    supporting_hypothesis_ids: [item.hypothesis_id].filter(Boolean),
    supporting_hypotheses: [item.hypothesis_id].filter(Boolean),
    supporting_papers: Array.isArray(item.paper_examples) ? item.paper_examples : [],
  }));
}

function compactResearcherText(value, maxChars = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]` : text;
}

function canonicalFocusFromLabDirector(hypothesis) {
  if (!hypothesis || typeof hypothesis !== "object") return null;
  const selected = hypothesis.selected_hypothesis && typeof hypothesis.selected_hypothesis === "object"
    ? hypothesis.selected_hypothesis
    : {};
  const statement = compactResearcherText(
    hypothesis.statement ||
      selected.statement ||
      hypothesis.hypothesis ||
      hypothesis.claim,
    1800,
  );
  if (!statement) return null;
  const materializedDataset =
    hypothesis.identification_strategy?.materialized_dataset ||
    selected.materialized_dataset ||
    hypothesis.materialized_dataset ||
    null;
  const datasetOrAccession =
    hypothesis.dataset_or_accession ||
    selected.dataset_or_accession ||
    selected.accession ||
    materializedDataset?.candidate_accession ||
    null;
  return {
    hypothesis_id:
      hypothesis.hypothesis_id ||
      selected.hypothesis_id ||
      (datasetOrAccession ? `hyp-director-${String(datasetOrAccession).toLowerCase()}` : "hyp-lab-director-selected"),
    statement,
    kind: "data",
    family_root:
      hypothesis.primary_family ||
      hypothesis.family_root ||
      selected.primary_family ||
      selected.family_root ||
      null,
    primary_family:
      hypothesis.primary_family ||
      selected.primary_family ||
      hypothesis.family_root ||
      selected.family_root ||
      null,
    dataset_or_accession: datasetOrAccession,
    materialized_dataset: materializedDataset,
    latest_status: hypothesis.status || selected.status || "selected",
    status: hypothesis.status || selected.status || "selected",
    why_selected: compactResearcherText(hypothesis.why_selected || selected.why_selected, 1200) || null,
    identification_strategy: hypothesis.identification_strategy || selected.identification_strategy || null,
    source: "lab_director_hypothesis",
  };
}

function preferCanonicalFocusHypotheses(ledgerFocus, labDirectorHypothesis) {
  const canonical = canonicalFocusFromLabDirector(labDirectorHypothesis);
  const existing = Array.isArray(ledgerFocus) ? ledgerFocus : [];
  if (!canonical) return existing.slice(0, 6);
  // A LabDirector-selected hypothesis is the canonical lead for the cycle.
  // Older ledger focus rows can remain useful as candidate history, but
  // keeping them in ``focus_hypotheses`` causes gatekeepers to re-review
  // abandoned or placeholder claims as if they were still active.
  return [canonical];
}

function enrichClaimsWithTraceArtifacts(claims, claimTraces) {
  const traceRows = Array.isArray(claimTraces?.claim_traces) ? claimTraces.claim_traces : [];
  const traceByClaimId = new Map(
    traceRows
      .map((item) => [String(item?.claim_id || "").trim(), item])
      .filter(([key]) => key),
  );

  return (claims || []).map((claim) => {
    const trace = traceByClaimId.get(String(claim?.claim_id || "").trim());
    const currentSupportingHypothesisIds = Array.isArray(claim?.supporting_hypothesis_ids)
      ? claim.supporting_hypothesis_ids
      : Array.isArray(claim?.supporting_hypotheses)
        ? claim.supporting_hypotheses
        : [];
    if (!trace) {
      return {
        ...claim,
        supporting_hypothesis_ids: currentSupportingHypothesisIds,
      };
    }
    const supportingHypothesisIds = Array.from(new Set([
      ...currentSupportingHypothesisIds,
      ...(trace.supporting_hypothesis_ids || []),
    ].filter(Boolean)));
    return {
      ...claim,
      statement: claim.statement || trace.statement || null,
      status: claim.status || trace.claim_status || null,
      current: claim.current || trace.claim_status || null,
      supporting_lanes: Array.from(new Set([
        ...(Array.isArray(claim?.supporting_lanes) ? claim.supporting_lanes : []),
        ...(trace.source_lanes || []),
      ])),
      supporting_papers: Array.from(new Set([
        ...(Array.isArray(claim?.supporting_papers) ? claim.supporting_papers : []),
        ...(trace.supporting_papers || []),
      ])).slice(0, 8),
      supporting_hypothesis_ids: supportingHypothesisIds,
      supporting_hypotheses: supportingHypothesisIds,
      source_artifact_paths: Array.from(new Set([
        ...(trace.source_lane_artifact_paths || []),
      ])).slice(0, 8),
      evidence_trace_paths: Array.from(new Set([
        ...(trace.source_lane_artifact_paths || []),
        ...(trace.analysis_trace_paths || []),
        ...(trace.validation_output_paths || []),
        ...(trace.data_transform_paths || []),
      ])).slice(0, 8),
      data_transform_steps: trace.data_transform_steps || [],
    };
  });
}

module.exports = {
  enrichClaimsWithLedgerSupport,
  normalizeReportClaims,
  selectPrimaryConclusions,
  provisionalClaimsFromHypotheses,
  compactResearcherText,
  canonicalFocusFromLabDirector,
  preferCanonicalFocusHypotheses,
  enrichClaimsWithTraceArtifacts,
};
