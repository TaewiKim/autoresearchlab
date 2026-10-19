// The bootstrap scout's papers must reach the literature graph.
//
// cycle-g-v87 deadlocked: 23 lanes contracted, zero dispatched across two full
// supervisor passes, because literature-graph had 0 nodes -> the chronicle-graphs
// gate was false -> followups were blocked -> no literature-search-driver scout
// ever ran -> the graph stayed at 0. A closed loop.
//
// Scout lane populations, and the graph each produced:
//
//     v85  literature-search-driver 48, codex-agent 2, native-readonly 1  -> 1647 nodes
//     v86  literature-search-driver 42, codex-agent 2, native-readonly 1  ->   87 nodes
//     v87  literature-search-driver  0, codex-agent 2, native-readonly 1  ->    0 nodes
//
// The bootstrap literature scout is a codex agent BY DESIGN -- it authors its own
// queries, and v87's wrote nine on-topic ones and collected 120 real rendering
// papers into a 263KB `papers.json` beside its result. The scan admitted a lane
// only when `result.driver === "literature-search-driver"` and then read
// `result.papers`, so that lane was never opened. Those papers had never entered
// the graph in ANY cycle; v85 and v86 simply had a followup that masked it.
//
// Replayed against the real v87 lane after the fix: 0 nodes -> 81 nodes, 99 edges,
// with scout-02 appearing in lane_synthesis_paths for the first time.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { synthesizeCycleLiterature } = require("../src/agents/chronicle/literature_synthesis.js");
const { screenedPaper } = require("./helpers/screened_paper");

const CYCLE = "cycle-g-v99-20260827";
// The objective the screening receipts are bound to, and the one the
// synthesis is told to screen against. A receipt read against a different
// objective is not evidence for this one, which is the point of the hash.
const OBJECTIVE = "reduce variance in Monte Carlo path tracing at a matched sample budget";

// These fixtures were written before screening was fail-closed. Afterwards the
// gate dropped every one of them, this whole file went red, and it STAYED red
// for four days -- while the thing it guards is the v87 deadlock above. A paper
// that cannot reach the graph is exactly the failure these tests exist to catch,
// so the fixture has to be a paper that is allowed to reach it.
function paper(i) {
  return screenedPaper(OBJECTIVE, {
    title: `Adaptive Sampling for Monte Carlo Path Tracing ${i}`,
    doi: `10.1145/nnnnnnn.${1000 + i}`,
    source: "openalex",
  });
}

function makeCycle({ inline = null, sidecar = null, driver = "codex-agent-executor" }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-sidecar-"));
  const laneDir = path.join(cwd, ".research-lab", "lanes", CYCLE, "scout-02");
  fs.mkdirSync(laneDir, { recursive: true });
  fs.mkdirSync(path.join(cwd, ".research-lab", "plans"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".research-lab", "state"), { recursive: true });
  const result = { driver, status: "completed", role_plan: { role: "scout" } };
  if (inline) result.papers = inline;
  fs.writeFileSync(path.join(laneDir, "result.json"), JSON.stringify(result), "utf8");
  if (sidecar) {
    fs.writeFileSync(path.join(laneDir, "papers.json"), JSON.stringify(sidecar), "utf8");
  }
  return { cwd, laneDir };
}

function synthesize(cwd) {
  return synthesizeCycleLiterature({ cwd, cycleId: CYCLE, cyclePrompt: OBJECTIVE });
}

function laneIds(out) {
  return (out?.summary?.lanes || []).map((l) => l.lane_id);
}

function paperTotal(out) {
  return (out?.summary?.lanes || []).reduce((a, l) => a + (l.paper_count || 0), 0);
}

test("a codex-agent scout's sidecar papers are synthesized", () => {
  const { cwd } = makeCycle({ sidecar: [paper(1), paper(2), paper(3)] });
  const out = synthesize(cwd);
  assert.deepStrictEqual(laneIds(out), ["scout-02"]);
  assert.strictEqual(paperTotal(out), 3);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a lane with neither inline papers nor a sidecar is still skipped", () => {
  const { cwd } = makeCycle({});
  const out = synthesize(cwd);
  assert.deepStrictEqual(laneIds(out), []);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("the driver's inline papers still work and take precedence", () => {
  const { cwd } = makeCycle({
    driver: "literature-search-driver",
    inline: [paper(1), paper(2)],
    sidecar: [paper(3), paper(4), paper(5), paper(6)],
  });
  const out = synthesize(cwd);
  assert.strictEqual(paperTotal(out), 2, "inline wins when present");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a sidecar written AFTER the first pass invalidates the scan cache", () => {
  // The half that would have made this fix look right and behave wrong: a lane
  // admitted through the sidecar has a result.json that never changes again, so
  // a cache keyed on result.json alone serves its first (empty) synthesis
  // forever.
  const { cwd, laneDir } = makeCycle({ driver: "literature-search-driver", inline: [paper(1)] });
  const first = synthesize(cwd);
  assert.strictEqual(paperTotal(first), 1);

  fs.writeFileSync(
    path.join(laneDir, "papers.json"),
    JSON.stringify([paper(2), paper(3), paper(4)]),
    "utf8",
  );
  const second = synthesize(cwd);
  // Inline still wins, but the lane must have been RE-READ rather than served
  // from cache -- otherwise a later sidecar could never be picked up at all.
  assert.strictEqual(paperTotal(second), 1);

  // Now drop the inline array so the sidecar is the only source.
  const resultPath = path.join(laneDir, "result.json");
  const r = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  delete r.papers;
  fs.writeFileSync(resultPath, JSON.stringify(r), "utf8");
  const third = synthesize(cwd);
  assert.strictEqual(paperTotal(third), 3, "sidecar is read once inline is gone");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a malformed sidecar does not take the synthesis down", () => {
  const { cwd, laneDir } = makeCycle({});
  fs.writeFileSync(path.join(laneDir, "papers.json"), "{not json", "utf8");
  const out = synthesize(cwd);
  assert.deepStrictEqual(laneIds(out), [], "unreadable sidecar means no papers, not a crash");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a sidecar wrapping its array in an object is accepted", () => {
  const { cwd, laneDir } = makeCycle({});
  fs.writeFileSync(
    path.join(laneDir, "papers.json"),
    JSON.stringify({ papers: [paper(1), paper(2)] }),
    "utf8",
  );
  const out = synthesize(cwd);
  assert.strictEqual(paperTotal(out), 2);
  fs.rmSync(cwd, { recursive: true, force: true });
});
