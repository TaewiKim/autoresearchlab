"use strict";

// OWNER DECISION 2026-11-12: run Codex in fast mode.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { codexServiceTier, codexServiceTierArgs } = require("../src/policy/codex_service_tier");

test("only a tier known to work is passed to codex", () => {
  assert.deepStrictEqual(codexServiceTierArgs({ RESEARCHLAB_CODEX_SERVICE_TIER: "fast" }), ["--config", 'service_tier="fast"']);
  assert.strictEqual(codexServiceTier({ RESEARCHLAB_CODEX_SERVICE_TIER: " Priority " }), "priority");
  for (const refused of ["flex", "ultrafast", "", 'fast" --sandbox danger-full-access']) {
    assert.deepStrictEqual(codexServiceTierArgs({ RESEARCHLAB_CODEX_SERVICE_TIER: refused }), [], refused);
  }
  assert.deepStrictEqual(codexServiceTierArgs({}), [], "unset: codex keeps its own default");
});

test("every codex process Node starts carries the tier", () => {
  for (const file of ["src/orchestrator/maintainer.js", "src/reporting/live_view/chat_agent.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(source, /codexServiceTierArgs\(/, `${file} spawns codex without the service tier`);
  }
});
