"use strict";

// What a write to cycle state has to leave behind, and what it does not.
//
// The rule is MBM-Core's own criterion -- can a decision be reconstructed --
// applied per artifact:
//
//   Delete it, re-run aggregation over the lane tree and the event log. If it
//   comes back identical it is DERIVED: its sources are its provenance, and a
//   record of each rewrite would be noise about something already recoverable.
//   If it cannot come back, this file is the only trace of a decision taken or
//   a moment measured. That is AUTHORITATIVE, and a write to it that leaves no
//   record is a decision nobody can reconstruct.
//
// Why the scope had to be drawn at all: "every write is recorded" was measured
// at 316 write sites across 53 files in three runtimes, which is not a rule
// anybody can keep. Applying the criterion leaves 45 authoritative kinds of the
// 109 named, and that is a rule that can be kept.
//
// Out of scope by construction, and deliberately:
//   - derived artifacts: `generated_by` + `updated_at` + source refs already say
//     where they came from
//   - the event log itself, or the record of recording recurses forever
//   - logs, caches, temp and scratch, and the .bak/archive files this produces
//   - files inside a lane directory: a lane's record is its result and its
//     final-status, and those are already audited by the lane lifecycle
//
// Reads are not in scope either. Admission into a decision is the memory gate's
// job; this is about what a WRITE destroys.
//
// The table is this system's own vocabulary, not any field's, and it is
// enforced rather than trusted: `tests/state_provenance.test.js` scans all three
// runtimes for cycle-scoped artifact names and fails when one is not classified
// here. A new state kind cannot be added silently.

const fs = require("fs");
const NEWLINE = String.fromCharCode(10);
const path = require("path");
const { writeFileAtomic } = require("../shared/json");

const STATE_PROVENANCE = {
  "agent-plan": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "aggregate-metrics": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "analysis-contract": { class: "derived", why: "recomputed from the selected hypothesis and the contract policy each time it is read (src/policy/analysis_contract.js)" },
  "analysis-contract-policy": { class: "authoritative", why: "whether contracts bind analysis for this cycle and the operational spec registered for each family; nothing regenerates a registration" },
  "analyst-research-notes": { class: "authoritative", why: "a role's durable notebook; nothing regenerates what it chose to write down" },
  "approval-review": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "approval-review-history": { class: "authoritative", why: "the trajectory a rewritten review destroys" },
  "artifact-review-map": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "brief-index": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "checkpoint-schedule": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "chronicle-checkpoint": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "chronicle-dci-checkpoint": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "chronicle-dci-corpus-map": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "chronicle-dci-evidence-ledger": { class: "authoritative", why: "append-only evidence ledger" },
  "chronicle-decision-digest": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "chronicle-dialogue": { class: "authoritative", why: "what was actually said between roles" },
  "chronicle-literature-relevance": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "chronicle-research-notes": { class: "authoritative", why: "a role's durable notebook" },
  "chronicle-schedule": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "claim-ledger-summary": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "claim-traces": { class: "authoritative", why: "the trace a claim was admitted on" },
  "codex-pacing": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "conclusion-review": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "conclusion-review-history": { class: "authoritative", why: "the trajectory a rewritten review destroys" },
  "contract-queue": { class: "authoritative", why: "queued work whose enqueue order is not re-derivable" },
  "contracts": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "controller": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "cycle-aggregate-metrics": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "cycle-events": { class: "authoritative", why: "the audit log itself" },
  "cycle-plan": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "cycle-run-state": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "data-acquisition-completed": { class: "authoritative", why: "a record that a fetch happened" },
  "data-bundles": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "data-graph": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "data-request": { class: "authoritative", why: "a request between roles" },
  "dependency-gate-overrides": { class: "authoritative", why: "a recorded release of a gate, and by whom" },
  "dependency-stall": { class: "authoritative", why: "the first-seen time of a stall; a later pass cannot recover it" },
  "document-authorization": { class: "authoritative", why: "an owner authorisation" },
  "document-only": { class: "authoritative", why: "an owner scope decision" },
  "document-reference-context": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "document-supplement-context": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "engineering-capability": { class: "authoritative", why: "a measurement of what was provisioned at one moment" },
  "evidence-packets": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "experiment-requests": { class: "authoritative", why: "requests between roles; delivery is not re-derivable" },
  "external-validation-failed-attempt": { class: "authoritative", why: "a failed attempt that no successful rerun reproduces" },
  "external-validation-results": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "family-nomination": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "family-package-ledger": { class: "authoritative", why: "append-only ledger" },
  "figure-verification": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "final-claim-package": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "gate-review": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "gate-review-history": { class: "authoritative", why: "the trajectory a rewritten review destroys" },
  "graph-snapshot": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "graph-update-log": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "hypotheses": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "hypothesis-frontier": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "hypothesis-ledger": { class: "authoritative", why: "append-only; a lead that vanished from it cannot be recovered" },
  "hypothesis-progress": { class: "authoritative", why: "the append-only progress event graph; suppression here is unrecoverable" },
  "independent-validation-results": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "instrument-inventory": { class: "authoritative", why: "a measurement of what this container could do at one moment" },
  "instrument-probe-attempts": { class: "authoritative", why: "how many runner lanes this cycle has already spent re-measuring; a reset would let a failing probe consume every one of them" },
  "knowledge-graph": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "lab-director-hypothesis": { class: "authoritative", why: "the director's decision for the cycle" },
  "field-landscape": { class: "derived", why: "published by the harness from the newest landscape scout whose field landscape validated; the gate the lead selection must cite" },
  "field-landscape-attempts": { class: "authoritative", why: "every landscape attempt and why it failed validation; the retry cap and the next scout's feedback read it" },
  "lead-selection-rejections": { class: "authoritative", why: "lead selections the field-landscape gate refused and why; fed back to the LabDirector" },
  "harness-notices": { class: "authoritative", why: "the harness's own append-only record of what it noticed or did to the cycle (a revoked login, a stale director decision, agent files moved out of state); nothing else holds it" },
  "codex-login-required": { class: "derived", why: "written by a lane whose Codex login was revoked and removed by the next lane that runs a turn; read by the owner and the supervisor" },
  // The expert problem selection (labdirector::problem_selection). Every stage
  // artifact is published by the harness from a stage lane's own output; the
  // owner's choice and the pipeline's own record are the only decisions here.
  "pipeline-health": { class: "derived", why: "recomputed by the supervisor from the lane tree and state on every pass" },
  "sota-cards": { class: "derived", why: "published by the harness from the sota_deep_read scout's cards; read by the expert selection" },
  "frontier-harvest": { class: "derived", why: "published by the harness from the frontier_harvest lane's frontier-candidates.json, with each top-K candidate's review state re-read from the cycle's screening artifacts; holds the deep read, expert selection and the lead while any is unreviewed" },
  "sota-cards-attempts": { class: "authoritative", why: "every deep-read attempt and which cards failed validation; the retry cap and the next deep-read scout's feedback read it" },
  "field-beliefs": { class: "derived", why: "published by the harness from the field-beliefs lane whose map validated against the SOTA cards" },
  "candidate-slate": { class: "derived", why: "published by the harness from the instrument-blind slate lane whose candidates validated" },
  "expert-panel-submissions": { class: "derived", why: "each panel reviewer lane's validated scores, sealed until every persona has submitted" },
  "expert-panel-personas": { class: "derived", why: "the reviewers the expert panel was dispatched with, fixed so a refreshed field map never changes who must still submit" },
  "expert-panel": { class: "derived", why: "the deterministic aggregate of the sealed panel submissions" },
  "novelty-audit": { class: "derived", why: "merged from the novelty scouts' validated audits; a struck candidate carries its citation" },
  "candidate-feasibility": { class: "derived", why: "merged from the feasibility lanes' validated pass/fail verdicts, with the harness's downgrades" },
  "owner-candidates": { class: "derived", why: "the surviving candidates in panel order, assembled from every stage artifact" },
  "owner-selection": { class: "authoritative", why: "the owner's choice among the expert-selected candidates; nothing regenerates it" },
  "expert-selection": { class: "authoritative", why: "when the pipeline engaged for the cycle and which candidate the owner picked; the lead gate reads it" },
  "expert-selection-attempts": { class: "authoritative", why: "every stage attempt and why it failed validation; the retry caps and the next lane's feedback read it" },
  "lead-hold": { class: "authoritative", why: "the lead the harness last projected, held against replacement until its own evidence is gated" },
  "lab-director-literature": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "lab-director-query-plan": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "lab-director-research-notes": { class: "authoritative", why: "a role's durable notebook, and the record a pivot is judged against" },
  "labdirector-cursor": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "labdirector-decisions": { class: "authoritative", why: "the decision ledger" },
  "labdirector-dialogue": { class: "authoritative", why: "what was actually said between roles" },
  "labdirector-inbox": { class: "authoritative", why: "messages addressed to a role; delivery is not re-derivable" },
  "labdirector-pause": { class: "authoritative", why: "a verdict that suspends the cycle" },
  "labdirector-plan": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "lane-manifest": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "lane-timeline": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "lead-protection": { class: "authoritative", why: "a decision to protect a lead from churn" },
  "literature-graph": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "literature-summary": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "literature-synthesis-scan-cache": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "maintainer": { class: "authoritative", why: "the maintainer's runs, caps and attempted signatures; losing it re-spends the budget on blockers already diagnosed" },
  "maintainer-catch-up": { class: "authoritative", why: "a maintainer pass a reload skipped and the next process owes; losing it delays that pass to the next run-plan" },
  "memory-gate-audit": { class: "authoritative", why: "the audit log of admissions" },
  "negative-control-results": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "next-cycle-plan": { class: "authoritative", why: "a decision carried forward past this cycle" },
  "owner-directives": { class: "authoritative", why: "the owner's instruction; no run produces it" },
  "paper-review": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "paper-review-history": { class: "authoritative", why: "the trajectory a rewritten review destroys" },
  "progress": { class: "derived", why: "the supervisor's pipeline position, re-derived every pass from the cycle's own published stage artifacts and the lane tree" },
  "budget": { class: "authoritative", why: "spend actually incurred, aggregated once from each lane log and never re-readable after the logs are rotated; the cursors that make it incremental cannot be reconstructed" },
  "prompt": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "reasoning-graph": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "reference-resources": { class: "authoritative", why: "what was actually retrieved" },
  "report-review": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "report-review-history": { class: "authoritative", why: "the trajectory a rewritten review destroys" },
  "report-workflow": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "reports": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "research-trend-analysis": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "researcher-view": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "rubric-followup-attempts": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "run-summary": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "sensitivity-validation-results": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "simulation-orders": { class: "derived", why: "projected from the newest completed LabDirector lane result that answered simulation_orders (generated_by names it)" },
  "strategy-decision": { class: "authoritative", why: "a decision about how the cycle proceeds" },
  "submission-package": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "supervisor-actions": { class: "authoritative", why: "what the supervisor did" },
  "supervisor-history": { class: "authoritative", why: "append-only supervisor record" },
  "termination-code": { class: "authoritative", why: "a verdict that ends the cycle" },
  "token-budget": { class: "authoritative", why: "spend actually incurred; it cannot be re-measured" },
  "transportability-decision": { class: "authoritative", why: "a decision" },
  "trend-summary": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "validation-plan": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "validation-results": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "vocabulary-lint": { class: "derived", why: "rebuilt from the lane tree and the event log" },
  "watchdog-halt": { class: "authoritative", why: "a verdict that stops the cycle, and the reason it was cleared" },
  "watchdog-history": { class: "authoritative", why: "append-only observation record" },
  "watchdog-policy": { class: "authoritative", why: "an operating decision" },
  "workgraph": { class: "derived", why: "rebuilt from the lane tree and the event log" },
"agent-communication-digest": { class: "derived", why: "rebuilt from the lane tree and the event log" },
};

function classifyStateKind(kind) {
  const entry = STATE_PROVENANCE[String(kind || "")];
  return entry ? entry.class : undefined;
}

function isAuthoritative(kind) {
  return classifyStateKind(kind) === "authoritative";
}

/**
 * Record that an authoritative artifact was created, replaced or removed.
 *
 * Refuses what it cannot record honestly: an unclassified kind (the table is
 * the scope, and something outside it has not been thought about), a derived
 * kind (recording those is the noise this scope exists to avoid), and a write
 * with no actor or no reason -- which is the shape that made 1,478 scores at or
 * above 85 unaccountable.
 *
 * Never throws into the caller's path. A write that happened must not be undone
 * by the failure to note it; the refusal is the return value, and the caller
 * decides. An observation that becomes the outage is worse than no observation.
 */
function recordStateWrite({ root, cycleId, kind, operation, actor, reason, previous = null, now = new Date() }) {
  const classification = classifyStateKind(kind);
  if (classification === undefined) {
    return { recorded: false, refused: "unclassified_state_kind" };
  }
  if (classification !== "authoritative") {
    return { recorded: false, refused: "derived_state_needs_no_record" };
  }
  if (!["create", "replace", "remove"].includes(String(operation))) {
    return { recorded: false, refused: "unknown_operation" };
  }
  if (!String(actor || "").trim()) return { recorded: false, refused: "no_actor" };
  if (!String(reason || "").trim()) return { recorded: false, refused: "no_reason" };
  if (operation === "replace" && !String(previous || "").trim()) {
    // A replacement that cannot point at what it replaced has destroyed the
    // only copy, which is the thing this rule exists to prevent.
    return { recorded: false, refused: "replacement_without_prior_version" };
  }
  const record = {
    ts: now.toISOString(),
    event_type: "authoritative-state-write",
    payload: {
      cycle_id: cycleId,
      kind,
      operation,
      actor,
      reason,
      previous_version_path: previous || null,
      why_authoritative: STATE_PROVENANCE[kind].why,
    },
  };
  try {
    const eventsDir = path.join(root, ".research-lab", "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.appendFileSync(
      path.join(eventsDir, `${cycleId}-cycle-events.jsonl`),
      JSON.stringify(record) + NEWLINE,
    );
  } catch (error) {
    return { recorded: false, refused: "append_failed", error: String(error && error.message) };
  }
  return { recorded: true, record };
}

/**
 * Where the copy of an authoritative artifact goes before it is replaced.
 *
 * Outside `state/`, so a reader listing the cycle's state does not see three
 * hundred dated siblings, and named by the moment the copy was taken rather
 * than by a counter -- a counter needs a reader to know what came before it,
 * which is the property being restored here.
 */
function archiveStatePath(root, cycleId, kind, now) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(root, ".research-lab", "state-archive", cycleId, kind, `${stamp}.json`);
}

/**
 * Write an authoritative artifact, keeping the version it replaces.
 *
 * `recordStateWrite` refuses a replacement that cannot point at its prior
 * version, which is right and was unreachable: nothing in the repository made
 * that copy, so the only caller wired to it was a create. This closes that.
 *
 * Fail-closed on the archive, deliberately. If the prior version cannot be
 * copied, the new one is NOT written and the caller is told; overwriting the
 * only copy of a decision because the copy step failed is precisely the loss
 * this exists to prevent. Everything else returns rather than throws -- a
 * failure to observe must not become the outage.
 *
 * A derived or unclassified kind is written plainly and not recorded: the
 * scope in the table above is the scope here too.
 */
function writeAuthoritativeState({ root, cycleId, kind, filePath, value, actor, reason, now = new Date() }) {
  const serialized = `${JSON.stringify(value, null, 2)}${NEWLINE}`;
  const authoritative = isAuthoritative(kind);
  let previous = null;
  let operation = "create";

  if (fs.existsSync(filePath)) {
    operation = "replace";
    if (authoritative) {
      const archivePath = archiveStatePath(root, cycleId, kind, now);
      try {
        fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.copyFileSync(filePath, archivePath);
        previous = archivePath;
      } catch (error) {
        return {
          written: false,
          recorded: false,
          refused: "archive_failed",
          error: String(error && error.message),
        };
      }
    }
  }

  try {
    writeFileAtomic(filePath, serialized);
  } catch (error) {
    return { written: false, recorded: false, refused: "write_failed", error: String(error && error.message) };
  }

  const record = recordStateWrite({ root, cycleId, kind, operation, actor, reason, previous, now });
  return { written: true, operation, previous_version_path: previous, ...record };
}

module.exports = { STATE_PROVENANCE, classifyStateKind, isAuthoritative, recordStateWrite, writeAuthoritativeState, archiveStatePath };
