"use strict";

const { createDataGraph } = require("../data_graph_artifacts");
const { slug } = require("../graph_schema");
const { inferFamilyRootFromVariable, rivalFamiliesFor } = require("./codebook");

function buildDataGraph(frontierCatalog, hypotheses) {
  const nodes = [];
  const edges = [];
  const familyIds = new Set();
  const mechanismIds = new Set();

  const frontierFamilies = Array.isArray(frontierCatalog?.candidate_primary_variable_families)
    ? frontierCatalog.candidate_primary_variable_families
    : [];
  for (const family of frontierFamilies) {
    const familyId = String(family?.family_id || "").trim();
    if (!familyId || familyIds.has(familyId)) continue;
    familyIds.add(familyId);
    nodes.push({
      id: `family:${familyId}`,
      type: "family",
      label: family.label || familyId,
      score: {
        literature_support: Number(family.support_count || 0),
      },
      state: family.status || "candidate_primary",
      metadata: {
        members: Array.isArray(family.members) ? family.members : [],
      },
      provenance: family.provenance || [],
    });
    for (const mechanismId of Array.isArray(family.mechanism_ids) ? family.mechanism_ids : []) {
      if (!mechanismId || mechanismIds.has(mechanismId)) continue;
      mechanismIds.add(mechanismId);
      nodes.push({
        id: `mechanism:${mechanismId}`,
        type: "mechanism",
        label: mechanismId,
        metadata: {},
        provenance: Array.isArray(family.provenance) ? family.provenance : [],
      });
      edges.push({
        id: `edge:family:${familyId}:mechanism:${mechanismId}:represents_mechanism`,
        from: `family:${familyId}`,
        to: `mechanism:${mechanismId}`,
        relation: "represents_mechanism",
        provenance: Array.isArray(family.provenance) ? family.provenance : [],
      });
    }
  }

  for (const item of hypotheses || []) {
    const hypothesisId = String(item?.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    const familyRoot = String(item?.family_root || inferFamilyRootFromVariable(item?.x_variable, item?.hypothesis_family)).trim();
    nodes.push({
      id: `hypothesis:${hypothesisId}`,
      type: "hypothesis",
      label: item.statement || hypothesisId,
      score: {
        support_count: Number(item.support_count || 0),
      },
      state: item.status || item.latest_status || "candidate",
      metadata: {
        primary_exposure: item.primary_exposure || item.x_variable || null,
        outcome: item.y_variable || null,
      },
      provenance: item.supporting_papers || item.paper_support || [],
    });
    if (familyRoot) {
      edges.push({
        id: `edge:hypothesis:${hypothesisId}:family:${familyRoot}:belongs_to_family`,
        from: `hypothesis:${hypothesisId}`,
        to: `family:${familyRoot}`,
        relation: "belongs_to_family",
        status: "family_membership_asserted",
        score: {
          support_score: Number(item.support_count || 0),
        },
        metadata: {
          source_kind: "literature",
          family_root: familyRoot,
          evidence_stage: "literature",
          confidence_tier: "literature_supported",
        },
        provenance: Array.isArray(item.supporting_papers) ? item.supporting_papers : Array.isArray(item.paper_support) ? item.paper_support : [],
      });
    }
    if (item.y_variable) {
      const variableId = `variable:${slug(item.y_variable, "outcome")}`;
      nodes.push({
        id: variableId,
        type: "variable",
        label: item.y_variable,
        metadata: {
          variable_role: "outcome",
        },
        provenance: Array.isArray(item.supporting_papers) ? item.supporting_papers : Array.isArray(item.paper_support) ? item.paper_support : [],
      });
      edges.push({
        id: `edge:hypothesis:${hypothesisId}:${variableId}:predicts`,
        from: `hypothesis:${hypothesisId}`,
        to: variableId,
        relation: "predicts",
        status: Number(item.support_count || 0) > 0 ? "literature_supported" : "literature_nominated",
        score: {
          support_score: Number(item.support_count || 0),
          update_count: 0,
          evidence_rank: Number(item.support_count || 0) > 0 ? 45 + Math.min(20, Number(item.support_count || 0)) : 30,
        },
        metadata: {
          source_kind: "literature",
          hypothesis_id: hypothesisId,
          family_root: familyRoot || null,
          evidence_stage: "literature",
          confidence_tier: Number(item.support_count || 0) > 0 ? "literature_supported" : "literature_nominated",
        },
        provenance: Array.isArray(item.supporting_papers) ? item.supporting_papers : Array.isArray(item.paper_support) ? item.paper_support : [],
      });
    }
    for (const rivalFamily of rivalFamiliesFor(familyRoot)) {
      edges.push({
        id: `edge:family:${familyRoot}:family:${rivalFamily}:competes_with`,
        from: `family:${familyRoot}`,
        to: `family:${rivalFamily}`,
        relation: "competes_with",
        status: "rivalry_nominated",
        metadata: {
          source_kind: "literature",
          evidence_stage: "literature",
          confidence_tier: "literature_nominated",
        },
        provenance: Array.isArray(item.supporting_papers) ? item.supporting_papers : Array.isArray(item.paper_support) ? item.paper_support : [],
      });
    }
  }

  return createDataGraph({ nodes, edges });
}

function aggregateDataGraphs(lanes = []) {
  const nodes = new Map();
  const edges = new Map();
  for (const lane of lanes) {
    const graph = lane?.data_graph || {};
    for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!node?.id) continue;
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
    for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
      const key = edge?.id || `${edge?.from}:${edge?.relation}:${edge?.to}`;
      if (!edge?.from || !edge?.to || !edge?.relation || edges.has(key)) continue;
      edges.set(key, edge);
    }
  }
  return createDataGraph({
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  });
}

function buildCycleFamilyTournament(lanes, familyNomination) {
  const familyScores = new Map();
  for (const item of familyNomination || []) {
    const familyRoot = String(item?.family_root || "").trim();
    if (!familyRoot) continue;
    if (!familyScores.has(familyRoot)) {
      familyScores.set(familyRoot, {
        family_root: familyRoot,
        nomination_count: 0,
        support_count: 0,
        hypothesis_count: 0,
      });
    }
    const entry = familyScores.get(familyRoot);
    entry.nomination_count += item.nominated ? 1 : 0;
    entry.support_count += Number(item.support_count || 0);
    entry.hypothesis_count += Number(item.hypothesis_count || 0);
  }

  const ranking = Array.from(familyScores.values())
    .map((entry) => ({
      ...entry,
      tournament_score: entry.support_count * 3 + entry.hypothesis_count * 5 + entry.nomination_count * 7,
    }))
    .sort((a, b) => b.tournament_score - a.tournament_score || a.family_root.localeCompare(b.family_root));

  const pairwise_matrix = [];
  for (let index = 0; index < ranking.length; index += 1) {
    for (let inner = index + 1; inner < ranking.length; inner += 1) {
      const left = ranking[index];
      const right = ranking[inner];
      pairwise_matrix.push({
        family_a: left.family_root,
        family_b: right.family_root,
        winner:
          left.tournament_score === right.tournament_score
            ? "tie"
            : left.tournament_score > right.tournament_score
              ? left.family_root
              : right.family_root,
        score_delta: Math.abs(left.tournament_score - right.tournament_score),
      });
    }
  }

  const topFamilies = ranking.slice(0, 5);
  return {
    family_count: ranking.length,
    ranking,
    top_k_family_diversity: new Set(topFamilies.map((item) => item.family_root)).size,
    pairwise_matrix,
    incumbent_family: ranking[0]?.family_root || null,
    incumbent_family_dominance_ratio:
      ranking.length > 0
        ? Number((topFamilies.filter((item) => item.family_root === ranking[0].family_root).length / topFamilies.length).toFixed(3))
        : 0,
    explored_family_count: ranking.filter((item) => item.hypothesis_count > 0).length,
    underexplored_family_count: ranking.filter((item) => item.hypothesis_count === 0).length,
    lane_count: Array.isArray(lanes) ? lanes.length : 0,
  };
}

function aggregateFamilyNomination(items) {
  const families = new Map();
  for (const item of items || []) {
    const familyRoot = String(item?.family_root || "").trim();
    if (!familyRoot) continue;
    if (!families.has(familyRoot)) {
      families.set(familyRoot, {
        family_root: familyRoot,
        support_count: 0,
        hypothesis_count: 0,
        nomination_count: 0,
        nominated: false,
        primary_exposures: new Set(),
        sample_claims: [],
        mechanisms: new Set(),
      });
    }
    const entry = families.get(familyRoot);
    entry.support_count += Number(item.support_count || 0);
    entry.hypothesis_count += Number(item.hypothesis_count || 0);
    entry.nomination_count += item.nominated ? 1 : 0;
    entry.nominated = entry.nominated || item.nominated === true;
    for (const exposure of Array.isArray(item.primary_exposures) ? item.primary_exposures : []) {
      if (entry.primary_exposures.size < 8) entry.primary_exposures.add(exposure);
    }
    for (const claim of Array.isArray(item.sample_claims) ? item.sample_claims : []) {
      if (entry.sample_claims.length >= 5) break;
      if (!entry.sample_claims.includes(claim)) entry.sample_claims.push(claim);
    }
    for (const mechanism of Array.isArray(item.mechanisms) ? item.mechanisms : []) {
      if (entry.mechanisms.size < 6) entry.mechanisms.add(mechanism);
    }
  }
  return Array.from(families.values())
    .map((entry) => ({
      family_root: entry.family_root,
      support_count: entry.support_count,
      hypothesis_count: entry.hypothesis_count,
      nomination_count: entry.nomination_count,
      nominated: entry.nominated,
      primary_exposures: Array.from(entry.primary_exposures),
      sample_claims: entry.sample_claims,
      mechanisms: Array.from(entry.mechanisms),
    }))
    .sort((a, b) => b.support_count - a.support_count || b.hypothesis_count - a.hypothesis_count || a.family_root.localeCompare(b.family_root));
}

module.exports = {
  buildDataGraph,
  aggregateDataGraphs,
  buildCycleFamilyTournament,
  aggregateFamilyNomination,
};
