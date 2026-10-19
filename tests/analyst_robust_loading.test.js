"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAnalystQueryPlan } = require("../src/agents/analyst/query_plan");

// Regression guard for the promotion-bottleneck fix: 170/203 master-table
// blueprints in cycle-d-20260604-fresh crashed on a naive
// pd.read_csv() of a non-CSV (GEO series-matrix / TSV), cascading into every
// downstream check failing → degraded → support_count 0 → promotion 0%. The
// analyst contract must instruct robust, format-sniffing data loading.

// Robust, format-sniffing data loading is universal — it must be present for
// every domain, since "guess the delimiter wrong" is a cross-domain failure.
test("analyst blueprint_rules mandate robust, format-sniffing data loading (all domains)", () => {
  for (const prompt of ["test", "single-cell RNA-seq differential expression", "real-time ray tracing renderer"]) {
    const plan = buildAnalystQueryPlan({ prompt, laneId: "analyst-01", cyclePlanningContext: null });
    const rules = plan?.code_generation_protocol?.blueprint_rules || [];
    const joined = rules.join("\n").toLowerCase();
    assert.ok(rules.length > 0, `blueprint_rules should be present for ${prompt}`);
    assert.match(joined, /robust data loading|sniff/, "must instruct robust/sniffing data loading");
    assert.match(joined, /tsv|geo|delimiter|sep=none/, "must reference non-CSV formats / delimiter sniffing");
    assert.match(joined, /read_csv/, "must explicitly warn about the bare read_csv failure mode");
  }
});

// Both halves of this file's second and third tests are gone, and the removal is
// what they were guarding for.
//
// They asserted that a biomedical objective received a wide-expression-matrix
// contract and the omics helper, and that a graphics objective received the
// render helper and NOT the omics scaffolding -- a per-field branch, correct for
// the two fields listed and silently wrong for every other. There is no branch
// now: no profile names a toolkit, so no objective can be steered into another
// field's scaffolding, and the blueprint is told to DISCOVER the helper modules
// beside it rather than to import one by name.
test("no objective is steered into any field's scaffolding", () => {
  for (const prompt of [
    "single-cell RNA-seq transcriptomic differential expression",
    "computer graphics rendering algorithm research",
    "compiler optimization under repeated trials",
  ]) {
    const plan = buildAnalystQueryPlan({ prompt, laneId: "analyst-01", cyclePlanningContext: null });
    const joined = (plan?.code_generation_protocol?.blueprint_rules || []).join("\n");
    assert.doesNotMatch(
      joined,
      /omics_helpers|cs_helpers|wide expression matrix|mitsuba|pbrt/i,
      `a field's scaffolding reached: ${prompt}`,
    );
    assert.match(joined, /list the blueprint's own directory/i, "nothing tells the blueprint the helpers are there");
  }
});
