"use strict";

const fs = require("fs");
const path = require("path");

// Vocabulary lint — runs at the tail of a cycle once the final data-graph
// snapshot has been written. We chose auto-grown vocabulary (no up-front
// declaration), so this pass exists to surface drift the producers may have
// introduced without realising:
//
//   - near_duplicate: two type/relation strings that are almost the same
//     (e.g. ``dataset:climate-record`` vs ``dataset:climate_record``,
//     ``predicts`` vs ``predict``). Often a typo or competing slugifier.
//   - singleton_type: a node type that appears on exactly one node across
//     the entire cycle. Legitimate for genuinely-unique domain types, so
//     it's a *soft* warning — surfaces but does not block.
//   - empty_vocabulary: graph.vocabulary missing or empty even though the
//     graph contains nodes/edges. Indicates a producer regressed and
//     forgot to register types.
//
// All warnings are advisory; nothing in the pipeline is blocked.

function _normalize(value) {
  return String(value || "").toLowerCase().replace(/[-_:]/g, "");
}

function _levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const prev = new Array(t.length + 1);
  const curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j += 1) prev[j] = curr[j];
  }
  return prev[t.length];
}

function _findNearDuplicates(values, category, distanceLimit = 2) {
  const list = Array.from(new Set(values || []))
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const warnings = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a === b) continue;
      const collapsedSame = _normalize(a) === _normalize(b);
      const distance = _levenshtein(a, b);
      if (collapsedSame || distance <= distanceLimit) {
        warnings.push({
          kind: "near_duplicate",
          category,
          pair: [a, b],
          distance,
          collapsed_same: collapsedSame,
        });
      }
    }
  }
  return warnings;
}

function _countTypeUsage(graph) {
  const usage = new Map();
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
    const type = String(node?.type || "").trim();
    if (!type) continue;
    usage.set(type, (usage.get(type) || 0) + 1);
  }
  return usage;
}

function _findSingletons(graph) {
  const usage = _countTypeUsage(graph);
  const warnings = [];
  for (const [type, count] of usage.entries()) {
    if (count === 1) {
      warnings.push({
        kind: "singleton_type",
        category: "node_type",
        type,
        count,
      });
    }
  }
  return warnings;
}

function lintVocabulary(graph, { distance_limit = 2 } = {}) {
  const vocab = graph?.vocabulary || {};
  const node_types = Array.isArray(vocab.node_types) ? vocab.node_types : [];
  const edge_relations = Array.isArray(vocab.edge_relations) ? vocab.edge_relations : [];
  const hasContent =
    (Array.isArray(graph?.nodes) && graph.nodes.length > 0) ||
    (Array.isArray(graph?.edges) && graph.edges.length > 0);

  const warnings = [];
  if (!node_types.length && !edge_relations.length && hasContent) {
    warnings.push({
      kind: "empty_vocabulary",
      category: "graph",
      message: "graph.vocabulary is missing or empty even though the graph carries nodes/edges; producer likely forgot to auto-register.",
    });
  }
  warnings.push(..._findNearDuplicates(node_types, "node_type", distance_limit));
  warnings.push(..._findNearDuplicates(edge_relations, "edge_relation", distance_limit));
  warnings.push(..._findSingletons(graph));

  return {
    node_types,
    edge_relations,
    warnings,
  };
}

function lintCycleArtifact(graphPath, { cycleId = null, outputPath = null, distance_limit = 2 } = {}) {
  // Defensive parse: lint should NEVER abort the cycle on a partially
  // written graph. Treat unreadable graphs as empty and surface a
  // single warning so callers can decide what to do.
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
  } catch (err) {
    return {
      cycle_id: cycleId || null,
      graph_path: path.resolve(graphPath),
      generated_at: new Date().toISOString(),
      node_types: [],
      edge_relations: [],
      warnings: [{ kind: "graph_parse_error", message: String(err?.message || err) }],
    };
  }
  const result = lintVocabulary(graph, { distance_limit });
  const payload = {
    cycle_id: cycleId || null,
    graph_path: path.resolve(graphPath),
    generated_at: new Date().toISOString(),
    ...result,
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  }
  return payload;
}

if (require.main === module) {
  // CLI: node data_graph_vocabulary_lint.js <graph_path> [<output_path>] [--cycle <id>]
  const [, , graphArg, ...rest] = process.argv;
  if (!graphArg) {
    process.stderr.write("usage: data_graph_vocabulary_lint.js <graph_path> [<output_path>] [--cycle <id>]\n");
    process.exit(2);
  }
  const cycleIdx = rest.indexOf("--cycle");
  const cycleId = cycleIdx >= 0 ? rest[cycleIdx + 1] : null;
  const outputPath = rest.find((arg, i) => i !== cycleIdx && i !== cycleIdx + 1 && !arg.startsWith("--")) || null;
  const result = lintCycleArtifact(graphArg, { cycleId, outputPath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  lintVocabulary,
  lintCycleArtifact,
};
