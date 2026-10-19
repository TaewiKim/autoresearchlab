"use strict";

// Canonical reference corpus — the "Data Foundations" layer adapted from
// Anthropic's self-service data-analytics design.
//
// The sources_of_truth_policy the analyst now carries points at a "semantic
// definitions" tier and "curated per-domain reference notes". This module
// materializes that layer deterministically from the cycle data graph so it
// is a real, pinned object instead of an aspirational pointer:
//
//   * datasets        — canonical discovered sources with a trust tier and
//                        freshness, so a concept resolves to one governed
//                        accession instead of a raw guess
//   * families        — incumbent / rival family registry with evidence state
//   * hypothesis_to_family / family_to_lanes — routing so a question maps to
//                        the family (and prior analysis lanes) it belongs to
//   * reference_notes — distilled per-family gotchas / routing triggers seeded
//                        from challenged edges and unresolved data gaps
//
// Everything is derived deterministically (no clock / randomness) so the same
// graph snapshot always yields the same pinned reference — which is what makes
// it usable as stable eval ground truth and as the target the harvester edits.

const crypto = require("crypto");

const TIER_VERIFIED = "verified_semantic";
const TIER_DISCOVERED = "discovered_unverified";

const TIER_LEGEND = {
  [TIER_VERIFIED]:
    "registry-verified canonical source (verification_method present); resolve concepts here first",
  [TIER_DISCOVERED]:
    "discovered but unverified candidate; usable only when no verified source covers the concept, and must be flagged in provenance",
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function str(value) {
  return String(value || "").trim();
}

function nodeIdPrefix(id) {
  return str(id).split(":")[0];
}

function datasetTier(metadata) {
  return str(metadata.verification_method) ? TIER_VERIFIED : TIER_DISCOVERED;
}

function buildDatasets(nodes) {
  const datasets = [];
  for (const node of nodes) {
    if (nodeIdPrefix(node?.id) !== "dataset") continue;
    const metadata = node?.metadata || {};
    const accession = str(metadata.accession) || null;
    datasets.push({
      canonical_id: str(node.id),
      accession,
      repository: str(metadata.repository) || null,
      url: str(metadata.url) || null,
      label: str(node.label) || null,
      tier: datasetTier(metadata),
      verification_method: str(metadata.verification_method) || null,
      // Freshness is the discovery timestamp recorded in the graph, not a
      // wall-clock read here — keeps the pinned reference reproducible.
      freshness: str(metadata.discovered_at) || null,
      state: str(node.state) || null,
      provenance_count: asArray(node.provenance).length,
    });
  }
  datasets.sort((a, b) => {
    // Verified sources first, then most-provenanced, then stable id order.
    if (a.tier !== b.tier) return a.tier === TIER_VERIFIED ? -1 : 1;
    return (
      b.provenance_count - a.provenance_count ||
      String(a.canonical_id).localeCompare(String(b.canonical_id))
    );
  });
  return datasets;
}

function buildFamilyRouting(nodes, edges, digest) {
  const rivalDigest = new Map(
    asArray(digest?.rival_family_digest).map((item) => [str(item.family_root), item]),
  );
  const incumbent = str(digest?.incumbent_family) || null;

  const hypothesisToFamily = {};
  const familyToLanes = {};
  for (const edge of edges) {
    const relation = str(edge?.relation || edge?.type);
    const from = str(edge?.source || edge?.from);
    const to = str(edge?.target || edge?.to);
    if (relation === "belongs_to_family" && from && to) {
      hypothesisToFamily[from] = to;
    } else if (relation === "analysis_result" && from && to) {
      const metadata = edge?.metadata || {};
      (familyToLanes[from] = familyToLanes[from] || []).push({
        lane: to,
        verdict: str(metadata.verdict) || null,
        identification_strategy: str(metadata.identification_strategy) || null,
        status: str(edge?.status) || null,
      });
    }
  }

  const families = [];
  for (const node of nodes) {
    if (nodeIdPrefix(node?.id) !== "family") continue;
    const metadata = node?.metadata || {};
    const familyRoot = str(metadata.family_root) || str(node.label) || str(node.id);
    const rival = rivalDigest.get(familyRoot) || {};
    const memberHypotheses = Object.keys(hypothesisToFamily).filter(
      (hyp) => hypothesisToFamily[hyp] === str(node.id),
    );
    families.push({
      family_id: str(node.id),
      family_root: familyRoot,
      incumbent: familyRoot === incumbent,
      last_update_operation: str(metadata.last_update_operation) || null,
      supported_edge_count: Number(rival.supported_edge_count || 0),
      challenged_edge_count: Number(rival.challenged_edge_count || 0),
      validated_edge_count: Number(rival.validated_edge_count || 0),
      priority_action: rival.priority_action || null,
      member_hypotheses: memberHypotheses,
      analysis_lanes: familyToLanes[str(node.id)] || [],
    });
  }
  families.sort((a, b) => {
    if (a.incumbent !== b.incumbent) return a.incumbent ? -1 : 1;
    return String(a.family_root).localeCompare(String(b.family_root));
  });

  return { families, hypothesisToFamily, incumbent };
}

function buildReferenceNotes(digest, families) {
  // Distilled per-family notes — gotchas and routing triggers — rather than a
  // prescriptive recipe. Seeded from the challenge/gap signals the lab already
  // tracks; the harvester (step 3) appends to these over time.
  const notes = {};
  const ensure = (familyRoot) => {
    if (!familyRoot) return null;
    return (notes[familyRoot] = notes[familyRoot] || {
      family_root: familyRoot,
      gotchas: [],
      routing_triggers: [],
    });
  };
  for (const family of families) {
    const note = ensure(family.family_root);
    if (!note) continue;
    if (family.challenged_edge_count > 0) {
      note.gotchas.push(
        `family has ${family.challenged_edge_count} challenged edge(s); confirm the resolution is not relying on a weakened link`,
      );
    }
    if (family.incumbent) {
      note.routing_triggers.push("incumbent family — a rival resolution must clear a higher bar to displace it");
    }
  }
  for (const gap of asArray(digest?.unresolved_data_gaps)) {
    const note = ensure(str(gap?.family_root));
    if (!note) continue;
    const rationale = str(gap?.rationale);
    note.gotchas.push(
      `unresolved data gap (${str(gap?.op) || "challenge"})${rationale ? `: ${rationale}` : ""}`,
    );
  }
  return notes;
}

function deterministicSnapshotId({ cycleId, datasets, families, nodeCount, edgeCount }) {
  // Content hash, not a timestamp — identical graph snapshots pin identically,
  // which is what lets eval ground truth stay stable across reruns.
  const material = JSON.stringify({
    cycleId: str(cycleId) || null,
    accessions: datasets.map((d) => d.accession || d.canonical_id).sort(),
    families: families.map((f) => f.family_root).sort(),
    nodeCount,
    edgeCount,
  });
  return crypto.createHash("sha1").update(material).digest("hex").slice(0, 16);
}

function maxFreshness(datasets) {
  // ISO-8601 strings sort lexically, so the max string is the newest snapshot.
  let latest = null;
  for (const dataset of datasets) {
    if (dataset.freshness && (!latest || dataset.freshness > latest)) {
      latest = dataset.freshness;
    }
  }
  return latest;
}

// Merge a governed, persisted reference-notes overlay on top of the notes
// derived from the graph. The overlay is what the correction harvester edits
// (via PR), so curated gotchas/routing triggers survive graph rebuilds — the
// blog's "metadata as product, updated by the same PR that changes the model".
function mergeReferenceNotesOverlay(derived, overlay) {
  if (!overlay || typeof overlay !== "object") return derived;
  const out = JSON.parse(JSON.stringify(derived));
  const union = (a, b) => Array.from(new Set([...asArray(a), ...asArray(b)].map(str).filter(Boolean)));
  for (const [familyRoot, note] of Object.entries(overlay)) {
    const root = str(familyRoot);
    if (!root) continue;
    const base = out[root] || { family_root: root, gotchas: [], routing_triggers: [] };
    out[root] = {
      family_root: root,
      gotchas: union(base.gotchas, note?.gotchas),
      routing_triggers: union(base.routing_triggers, note?.routing_triggers),
      curated: true,
    };
  }
  return out;
}

function buildCanonicalReference({
  dataGraph,
  dataGraphDigest = null,
  cycleId = null,
  referenceNotesOverlay = null,
} = {}) {
  const nodes = asArray(dataGraph?.nodes);
  const edges = asArray(dataGraph?.edges);
  const datasets = buildDatasets(nodes);
  const { families, hypothesisToFamily, incumbent } = buildFamilyRouting(
    nodes,
    edges,
    dataGraphDigest,
  );
  const referenceNotes = mergeReferenceNotesOverlay(
    buildReferenceNotes(dataGraphDigest, families),
    referenceNotesOverlay,
  );
  const snapshotId = deterministicSnapshotId({
    cycleId,
    datasets,
    families,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  return {
    schema_version: 1,
    cycle_id: str(cycleId) || null,
    snapshot_id: snapshotId,
    pinned_freshness: maxFreshness(datasets),
    incumbent_family: incumbent,
    tier_legend: TIER_LEGEND,
    counts: {
      datasets: datasets.length,
      verified_datasets: datasets.filter((d) => d.tier === TIER_VERIFIED).length,
      families: families.length,
    },
    datasets,
    families,
    hypothesis_to_family: hypothesisToFamily,
    reference_notes: referenceNotes,
  };
}

function summarizeCanonicalReference(reference, { maxDatasets = 8, maxFamilies = 6 } = {}) {
  // Compact, retrieval-shaped projection embedded into the analyst role plan so
  // the plan stays small even when the full graph is large.
  if (!reference || typeof reference !== "object") return null;
  return {
    snapshot_id: reference.snapshot_id || null,
    pinned_freshness: reference.pinned_freshness || null,
    incumbent_family: reference.incumbent_family || null,
    tier_legend: reference.tier_legend || TIER_LEGEND,
    counts: reference.counts || null,
    datasets: asArray(reference.datasets)
      .slice(0, maxDatasets)
      .map((d) => ({
        canonical_id: d.canonical_id,
        accession: d.accession,
        repository: d.repository,
        tier: d.tier,
        freshness: d.freshness,
      })),
    families: asArray(reference.families)
      .slice(0, maxFamilies)
      .map((f) => ({
        family_root: f.family_root,
        incumbent: f.incumbent,
        challenged_edge_count: f.challenged_edge_count,
        member_hypotheses: f.member_hypotheses,
      })),
    reference_notes: reference.reference_notes || {},
  };
}

module.exports = {
  buildCanonicalReference,
  summarizeCanonicalReference,
  mergeReferenceNotesOverlay,
  TIER_VERIFIED,
  TIER_DISCOVERED,
};
