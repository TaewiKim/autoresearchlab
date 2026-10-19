"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { enrichCitationWithScholarlyMetadata } = require("../src/agents/chronicle/scholarly_metadata_lookup");

// These tests describe the default literature path. The Docker image sets the
// approved scholarly network policy, which the test process must not inherit.
delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;

test("scholarly metadata lookup enriches citation via injected provider and caches result", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-scholar-"));
  const root = path.join(cwd, ".research-lab");
  fs.mkdirSync(root, { recursive: true });

  const paper = {
    title: "Coverage and Survival",
    doi: "10.1000/example-cache",
    year: 2024,
  };
  const baseCitation = {
    title: "Coverage and Survival",
    doi: "10.1000/example-cache",
    year: 2024,
    verification_score: 6,
    verification_status: "partial",
    verification_method: "persistent_identifier",
    trusted_source_count: 1,
    metadata_consistency_score: 3,
  };

  let calls = 0;
  const requestJson = () => {
    calls += 1;
    return {
      message: {
        DOI: "10.1000/example-cache",
        title: ["Coverage and Survival"],
        issued: { "date-parts": [[2024]] },
        "container-title": ["The Lancet"],
        author: [{ given: "A.", family: "Author" }],
        URL: "https://doi.org/10.1000/example-cache",
      },
    };
  };

  const first = enrichCitationWithScholarlyMetadata({
    paper,
    citation: baseCitation,
    root,
    requestJson,
    allowExternal: true,
  });
  const second = enrichCitationWithScholarlyMetadata({
    paper,
    citation: baseCitation,
    root,
    requestJson,
    allowExternal: true,
  });

  assert.equal(first.scholarly_metadata_lookup, "crossref");
  assert.equal(first.verification_method, "persistent_identifier+crossref");
  assert.equal(first.verification_status, "verified");
  assert.equal(second.scholarly_metadata_lookup, "cache-hit");
  assert.equal(calls, 1);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("approved scholarly policy leaves existing citation evidence intact and never calls legacy curl lookup", () => {
  const previousPolicy = process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
  process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = "approved-scholarly-metadata-v1";
  const citation = {
    title: "Existing Driver Evidence",
    doi: "10.1000/existing",
    verification_score: 8,
    verification_status: "verified",
    trusted_source_count: 2,
    metadata_consistency_score: 4,
  };
  let calls = 0;
  try {
    const result = enrichCitationWithScholarlyMetadata({
      paper: citation,
      citation,
      root: os.tmpdir(),
      allowExternal: true,
      requestJson: () => {
        calls += 1;
        return {};
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.scholarly_metadata_lookup, "pending");
    assert.equal(result.verification_status, "verified");
    assert.equal(result.verification_score, 8);
    assert.equal(result.trusted_source_count, 2);
    assert.equal(result.metadata_consistency_score, 4);
  } finally {
    if (previousPolicy == null) delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
    else process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = previousPolicy;
  }
});
