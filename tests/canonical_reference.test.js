"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCanonicalReference,
  summarizeCanonicalReference,
  TIER_VERIFIED,
  TIER_DISCOVERED,
} = require("../src/agents/shared/canonical_reference");
const { buildAnalystQueryPlan } = require("../src/agents/analyst/query_plan");

// Fixture matching the real cycle data-graph shape (dataset / family /
// hypothesis nodes; belongs_to_family + analysis_result edges).
function fixtureGraph() {
  return {
    nodes: [
      {
        id: "dataset:somalogic:geo:gse318067",
        label: "SLE peripheral-blood proteomics",
        state: "open",
        metadata: {
          repository: "GEO",
          accession: "GSE318067",
          url: "https://example/gse318067",
          verification_method: "ncbi_geo_registry",
          discovered_at: "2026-06-04T10:00:00Z",
        },
        provenance: ["lane:a", "lane:b", "lane:c"],
      },
      {
        id: "dataset:somalogic:geo:gse282742",
        label: "MCI->AD transcriptomics",
        state: "open",
        metadata: {
          repository: "GEO",
          accession: "GSE282742",
          url: "https://example/gse282742",
          // no verification_method -> discovered/unverified tier
          discovered_at: "2026-06-06T17:54:39Z",
        },
        provenance: ["lane:a"],
      },
      {
        id: "family:autoimmune proteomic severity gradient",
        label: "autoimmune proteomic severity gradient",
        metadata: {
          family_root: "autoimmune proteomic severity gradient",
          last_update_operation: "challenge",
        },
      },
      {
        id: "hypothesis:HYP-GSE318067-SLE-01",
        label: "SLE severity hypothesis",
        metadata: {},
      },
    ],
    edges: [
      {
        relation: "belongs_to_family",
        source: "hypothesis:HYP-GSE318067-SLE-01",
        target: "family:autoimmune proteomic severity gradient",
      },
      {
        relation: "analysis_result",
        source: "family:autoimmune proteomic severity gradient",
        target: "analysis_lane:followup-analyst-170",
        status: "pending_lab_runner",
        metadata: { verdict: "supported", identification_strategy: "cross-sectional" },
      },
    ],
  };
}

function fixtureDigest() {
  return {
    incumbent_family: "autoimmune proteomic severity gradient",
    rival_family_digest: [
      {
        family_root: "autoimmune proteomic severity gradient",
        supported_edge_count: 2,
        challenged_edge_count: 1,
        validated_edge_count: 1,
      },
    ],
    unresolved_data_gaps: [
      {
        family_root: "autoimmune proteomic severity gradient",
        op: "challenge",
        rationale: "batch effect not controlled",
      },
    ],
  };
}

test("canonical reference registers datasets with trust tiers and freshness", () => {
  const ref = buildCanonicalReference({
    dataGraph: fixtureGraph(),
    dataGraphDigest: fixtureDigest(),
    cycleId: "cycle-x",
  });

  assert.equal(ref.counts.datasets, 2);
  assert.equal(ref.counts.verified_datasets, 1);
  // Verified source is sorted first.
  assert.equal(ref.datasets[0].accession, "GSE318067");
  assert.equal(ref.datasets[0].tier, TIER_VERIFIED);
  assert.equal(ref.datasets[1].tier, TIER_DISCOVERED);
  // Freshness is pinned to the newest discovery timestamp in the graph.
  assert.equal(ref.pinned_freshness, "2026-06-06T17:54:39Z");
});

test("canonical reference routes hypotheses to families and lanes", () => {
  const ref = buildCanonicalReference({
    dataGraph: fixtureGraph(),
    dataGraphDigest: fixtureDigest(),
    cycleId: "cycle-x",
  });

  assert.equal(
    ref.hypothesis_to_family["hypothesis:HYP-GSE318067-SLE-01"],
    "family:autoimmune proteomic severity gradient",
  );
  const family = ref.families[0];
  assert.equal(family.incumbent, true);
  assert.deepEqual(family.member_hypotheses, ["hypothesis:HYP-GSE318067-SLE-01"]);
  assert.equal(family.analysis_lanes[0].verdict, "supported");
  // Reference notes distil the challenge + data-gap signals into gotchas.
  const notes = ref.reference_notes["autoimmune proteomic severity gradient"];
  assert.match(notes.gotchas.join("\n"), /challenged edge/i);
  assert.match(notes.gotchas.join("\n"), /batch effect/i);
});

test("canonical reference snapshot id is deterministic and content-addressed", () => {
  const a = buildCanonicalReference({ dataGraph: fixtureGraph(), dataGraphDigest: fixtureDigest(), cycleId: "cycle-x" });
  const b = buildCanonicalReference({ dataGraph: fixtureGraph(), dataGraphDigest: fixtureDigest(), cycleId: "cycle-x" });
  assert.equal(a.snapshot_id, b.snapshot_id);

  const mutated = fixtureGraph();
  mutated.nodes.push({
    id: "dataset:somalogic:geo:gse999999",
    metadata: { accession: "GSE999999", verification_method: "ncbi_geo_registry", discovered_at: "2026-06-07T00:00:00Z" },
    provenance: [],
  });
  const c = buildCanonicalReference({ dataGraph: mutated, dataGraphDigest: fixtureDigest(), cycleId: "cycle-x" });
  assert.notEqual(a.snapshot_id, c.snapshot_id);
});

test("empty/missing graph yields a safe empty reference", () => {
  const ref = buildCanonicalReference({});
  assert.equal(ref.counts.datasets, 0);
  assert.equal(ref.counts.families, 0);
  assert.ok(ref.snapshot_id);
  assert.equal(summarizeCanonicalReference(null), null);
});

test("analyst plan surfaces a compact canonical_reference from cycle context", () => {
  const reference = buildCanonicalReference({
    dataGraph: fixtureGraph(),
    dataGraphDigest: fixtureDigest(),
    cycleId: "cycle-x",
  });
  const analyst = buildAnalystQueryPlan({
    prompt: "Validate the SLE severity hypothesis",
    laneId: "followup-analyst-010",
    cyclePlanningContext: { canonical_reference: reference },
  });

  assert.ok(analyst.canonical_reference, "compact reference attached to plan");
  assert.equal(analyst.canonical_reference.snapshot_id, reference.snapshot_id);
  assert.equal(analyst.canonical_reference.datasets[0].accession, "GSE318067");
  // The semantic tier of the sources-of-truth policy points at it.
  const semanticTier = analyst.sources_of_truth_policy.consult_in_trust_order[0];
  assert.equal(semanticTier.tier, "semantic_definitions");
  assert.match(semanticTier.what, /canonical_reference/i);
  // Plans on cycles without a graph still build (reference simply null).
  const bare = buildAnalystQueryPlan({ prompt: "x", laneId: "l" });
  assert.equal(bare.canonical_reference, null);
});
