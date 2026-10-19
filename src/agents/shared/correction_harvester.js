"use strict";

// Correction harvester — the "active correction harvesting" mitigation from
// Anthropic's self-service data-analytics design, scoped to this lab.
//
// The blog runs scheduled agents that scan stakeholder channels for correction
// language, draft fixes to reference docs, and open PRs. This lab already emits
// correction-shaped signals from gate review (challenge questions, objections,
// rejection reasons, missing validations, switch triggers), from validation
// summaries (failed checks), and now from the analyst eval telemetry (low
// canonical_resolution_rate / failed gates). This module distils those into
// proposed patches to the GOVERNED reference-notes overlay that
// canonical_reference merges in — closing the loop back onto the Data
// Foundations layer. PR creation is left to a thin outer shell.

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function str(value) {
  return String(value || "").trim();
}
function compact(value, max = 240) {
  const text = str(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Pick the family these signals should attach to. Gate review is about the
// current hypothesis, so default to the incumbent / first family.
function targetFamily(canonicalReference) {
  if (!canonicalReference) return "__unattributed__";
  if (str(canonicalReference.incumbent_family)) return str(canonicalReference.incumbent_family);
  const families = asArray(canonicalReference.families);
  if (families.length && str(families[0].family_root)) return str(families[0].family_root);
  return "__unattributed__";
}

function existingNotes(canonicalReference, family) {
  const notes = canonicalReference && canonicalReference.reference_notes;
  const entry = notes && notes[family];
  return {
    gotchas: new Set(asArray(entry?.gotchas).map((g) => str(g).toLowerCase())),
    routing_triggers: new Set(asArray(entry?.routing_triggers).map((g) => str(g).toLowerCase())),
  };
}

// Each raw signal -> { text, kind: "gotcha" | "routing_trigger", source }
function collectSignals({ gateReview, validationSummaries, evalTelemetry }) {
  const signals = [];
  const push = (text, kind, source) => {
    const value = compact(text);
    if (value) signals.push({ text: value, kind, source });
  };

  const gr = gateReview || {};
  for (const q of asArray(gr.challenge_questions)) push(q, "routing_trigger", "gate.challenge_questions");
  for (const o of asArray(gr.major_objections)) push(o, "gotcha", "gate.major_objections");
  for (const r of asArray(gr.incumbent_rejection_reasons)) push(r, "gotcha", "gate.incumbent_rejection_reasons");
  for (const m of asArray(gr.missing_validations)) push(m, "gotcha", "gate.missing_validations");
  for (const s of asArray(gr.switch_triggers)) push(s, "routing_trigger", "gate.switch_triggers");
  for (const b of asArray(gr.gate_scientific_blockers)) push(b, "gotcha", "gate.gate_scientific_blockers");

  for (const summary of asArray(validationSummaries)) {
    for (const check of asArray(summary?.failed_checks)) {
      push(`validation check keeps failing: ${str(check)}`, "gotcha", "validation.failed_checks");
    }
  }

  for (const row of asArray(evalTelemetry)) {
    if (row && row.passed === false) {
      push(
        `eval gate failed for ${str(row.domain) || "domain"} (accuracy ${row.accuracy}, canonical_resolution_rate ${row.canonical_resolution_rate})`,
        "gotcha",
        "eval.telemetry",
      );
    } else if (row && typeof row.canonical_resolution_rate === "number" && row.canonical_resolution_rate < 1) {
      push(
        `canonical_resolution_rate below target for ${str(row.domain) || "domain"} (${row.canonical_resolution_rate}); a concept is resolving below the semantic tier`,
        "routing_trigger",
        "eval.telemetry",
      );
    }
  }

  return signals;
}

// Distil raw signals into a deduped, evidence-weighted patch for one family.
function harvestCorrections({
  gateReview = {},
  validationSummaries = [],
  evalTelemetry = [],
  canonicalReference = null,
} = {}) {
  const family = targetFamily(canonicalReference);
  const have = existingNotes(canonicalReference, family);
  const signals = collectSignals({ gateReview, validationSummaries, evalTelemetry });

  // Group by normalized text (NOT kind::text) to count repeats and to collapse
  // a line the gate emits in more than one field. Real gate reviews carry the
  // same string under both a question field and a comment field. Keep the
  // source-declared kind; only when one text arrives under conflicting kinds do
  // we break the tie (a question is a routing trigger, a statement a gotcha).
  const grouped = new Map();
  for (const signal of signals) {
    const key = signal.text.toLowerCase();
    const bucket = grouped.get(key) || {
      text: signal.text,
      kinds: new Set(),
      count: 0,
      sources: new Set(),
    };
    bucket.kinds.add(signal.kind);
    bucket.count += 1;
    bucket.sources.add(signal.source);
    grouped.set(key, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.kind =
      bucket.kinds.size === 1
        ? [...bucket.kinds][0]
        : /\?\s*$/.test(bucket.text)
        ? "routing_trigger"
        : "gotcha";
  }

  const addGotchas = [];
  const addRoutingTriggers = [];
  const evidence = [];
  for (const bucket of grouped.values()) {
    const lower = bucket.text.toLowerCase();
    // Do not re-propose anything already curated, under either note list.
    if (have.gotchas.has(lower) || have.routing_triggers.has(lower)) continue;
    const line =
      bucket.count > 1 ? `${bucket.text} [recurring ×${bucket.count}]` : bucket.text;
    if (bucket.kind === "gotcha") addGotchas.push(line);
    else addRoutingTriggers.push(line);
    evidence.push({ text: bucket.text, kind: bucket.kind, count: bucket.count, sources: [...bucket.sources] });
  }

  const patches = {};
  if (addGotchas.length || addRoutingTriggers.length) {
    patches[family] = {
      family_root: family,
      add_gotchas: addGotchas,
      add_routing_triggers: addRoutingTriggers,
      evidence,
    };
  }
  return { patches, signals_seen: signals.length, target_family: family };
}

// Turn patches into the overlay shape canonical_reference merges, unioned on
// top of any existing overlay. Pure — returns a new overlay object.
function mergeIntoOverlay(existingOverlay, patches) {
  const overlay = existingOverlay && typeof existingOverlay === "object"
    ? JSON.parse(JSON.stringify(existingOverlay))
    : {};
  const union = (a, b) => Array.from(new Set([...asArray(a), ...asArray(b)].map(str).filter(Boolean)));
  for (const [family, patch] of Object.entries(patches || {})) {
    const base = overlay[family] || { family_root: family, gotchas: [], routing_triggers: [] };
    overlay[family] = {
      family_root: family,
      gotchas: union(base.gotchas, patch.add_gotchas),
      routing_triggers: union(base.routing_triggers, patch.add_routing_triggers),
    };
  }
  return overlay;
}

function renderPatchSummary(harvest) {
  const lines = ["# Proposed canonical reference-notes update", ""];
  lines.push(`Signals scanned: ${harvest.signals_seen}`);
  const entries = Object.values(harvest.patches || {});
  if (!entries.length) {
    lines.push("", "_No new correction signals — nothing to patch._");
    return lines.join("\n");
  }
  for (const patch of entries) {
    lines.push("", `## Family: ${patch.family_root}`);
    if (patch.add_routing_triggers.length) {
      lines.push("", "**New routing triggers**");
      for (const t of patch.add_routing_triggers) lines.push(`- ${t}`);
    }
    if (patch.add_gotchas.length) {
      lines.push("", "**New gotchas**");
      for (const g of patch.add_gotchas) lines.push(`- ${g}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  harvestCorrections,
  mergeIntoOverlay,
  renderPatchSummary,
  collectSignals,
};
