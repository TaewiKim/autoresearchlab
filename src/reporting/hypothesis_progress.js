"use strict";

// Hypothesis-progress coupled memory (ACM-CP/1.0 Core applied to the science
// loop). The graphics gate never converged not because of scoring thresholds but
// because hypothesis progress was UNCOUPLED memory: the best-so-far lead and its
// gatekeeper reviews were read/dropped without binding to the active round + an
// append-only event graph. That is exactly the paper's failure model — a pivot
// SUPPRESSES the critical memory (best lead), and the "why is this the lead"
// decision is unreconstructable.
//
// This module makes hypothesis progress a message-bound, append-only shared
// memory, mirroring the ACM-CP reference (benchmarks/coupled_memory/runtime.mjs):
//   * every gatekeeper-reviewed round is a MemoryRecord written to an append-only
//     EventGraph (`<cycle>-hypothesis-progress.jsonl`), integrity-hashed and
//     provenance-bound to the review lane (source_message_id);
//   * the best-so-far lead is a CRITICAL record (memory_type "decision", scope
//     "run", status "active") that a pivot may not silently forget;
//   * dropping / superseding the best lead is a guarded memory op that FAILS
//     CLOSED: it is denied unless the event graph shows the lead genuinely
//     STALLED (its binding — lowest — rubric best-score did not improve across
//     STALL_ROUNDS rounds). This is the anti-thrash engine, grounded as
//     "critical memory must not be suppressed", not an arbitrary pivot cap;
//   * the current lead is reconstructable by replaying the log.
//
// Pure functions (record building, hashing, best-so-far, supersession guard,
// reconstruction) are exported for unit tests; IO is a thin append/read on the
// jsonl event graph.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = "acmcp.hypothesis_progress/1";
// A lead is "stalled" (pivot permitted) only after this many consecutive review
// rounds for the SAME hypothesis with no improvement on its binding rubric.
// Raised 3 -> 6 (2026-07-13): STALL_ROUNDS was SHORTER than a lead's validation
// turnaround. A promoted lead's soundness rubrics (technical_quality /
// reproducibility) only move once its runner validation lands, which takes
// several gate rounds; with the window at 3 the binding rubric read flat for 3
// rounds and the guard permitted a pivot BEFORE the evidence arrived (measured on
// cycle-g-v59: lead_stalled_pivot_permitted fired 57x, soft-churning through five
// graphics leads and burning the gatekeeper budget to its 192 ceiling without any
// lead accumulating soundness). 6 gives a promoted lead time for its own
// validation to land and move the binding rubric before it can be abandoned; a
// lead that IS improving is protected indefinitely regardless of this value.
//
// LEVEL-3 ADAPTIVE OVERRIDE: the progress watchdog measures the cycle's actual
// evidence latency (rounds until a lead's soundness first moves) and publishes a
// derived stall window to its policy file; the launch wrapper injects it here via
// RESEARCHLAB_STALL_ROUNDS on each supervisor (re)launch. Clamped [3..12]; any
// unset/invalid value falls back to the measured-safe default of 6.
function resolveStallRounds() {
  const raw = Number.parseInt(process.env.RESEARCHLAB_STALL_ROUNDS || "", 10);
  if (Number.isFinite(raw) && raw >= 3 && raw <= 12) return raw;
  return 6;
}
const STALL_ROUNDS = resolveStallRounds();
// Anti-churn COMMIT WINDOW. A lead that has produced a statistically STRONG,
// completed validation of its OWN must be given at least this many gatekeeper
// NOVELTY-scoring rounds to consolidate/reframe (raise novelty in place) BEFORE
// the director may abandon it for a fresh unvalidated idea — even when the binding
// blocker is novelty/impact. This is the specific fix for the observed pathology:
// every graphics lead caps at novelty ~44 in a saturated field, the novelty-binding
// pivot escape fires every round, so a genuinely strong cross-domain lead with a
// p<0.01 validated result is dropped before its novelty is ever consolidated
// (MBM critical-memory suppression). Bounded — the window clears once the lead has
// accrued this many novelty rounds, after which the normal novelty-pivot rules
// resume.
const COMMIT_NOVELTY_ROUNDS = 2;
// Minimum binding-rubric best-score gain that counts as real improvement.
const IMPROVEMENT_EPSILON = 1;
// Soundness (correctness) rubrics — fail-closed per MBM-Core. Contribution
// rubrics (novelty, impact) are climbed, not vetoed, but still tracked.
const SOUNDNESS_RUBRICS = new Set(["technical_quality", "reproducibility", "clarity"]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Integrity hash over content + binding provenance (ACM-CP audit_hash / M5
// tamper-evidence): a record whose content no longer matches this hash is denied
// on read.
function recordHash(record) {
  // The hash must cover EVERY field that admission or rollup depends on, so a
  // tamper that flips any of them (e.g. status -> "superseded"/"banked" to hide
  // the true lead, or writer/scope/memory_type to change how it is read) is
  // caught as an integrity mismatch on read. Omitting these fields let a tampered
  // record keep a "valid" hash while changing behaviour (adversarial finding).
  const material = canonical({
    schema: record.schema,
    memory_id: record.memory_id,
    run_id: record.run_id,
    task_id: record.task_id,
    trace_id: record.trace_id,
    source_message_id: record.source_message_id,
    writer: record.writer,
    memory_type: record.memory_type,
    scope: record.scope,
    status: record.status,
    supersedes: record.supersedes === undefined ? null : record.supersedes,
    valid_from_event: record.valid_from_event ?? null,
    event_id: record.event_id ?? null,
    content: record.content,
  });
  return `sha256:${crypto.createHash("sha256").update(material).digest("hex")}`;
}

// Stable identity for a hypothesis so its rounds accrue to ONE lead memory rather
// than thrashing as fresh ids. Prefer an explicit family/lead id; else hash the
// normalized statement.
const STOPWORDS = new Set([
  "a", "an", "the", "of", "on", "in", "to", "for", "and", "or", "is", "are", "be", "with",
  "that", "this", "at", "by", "as", "than", "then", "will", "would", "can", "more", "less",
  "significantly", "substantially", "shows", "show", "under", "over", "into", "its", "their",
]);

// Content-token SET signature of a statement: lowercase, strip punctuation, drop
// stopwords + very short tokens, light singularization, dedupe + SORT. Two
// rewordings of the same hypothesis (word order, a synonym-free reword, an added
// filler word, plural/singular) collapse to the same signature so their rounds
// accrue to ONE lead memory. Order-independent + inflection-tolerant.
function statementSignature(statement) {
  const tokens = String(statement || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/(ies)$/, "y").replace(/s$/, "")) // light singularize
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens)).sort().join(" ");
}

// Jaccard similarity of two statements' token signatures — used by the guard to
// recognise "a paraphrase of the current lead" (which must NOT be treated as a
// different, better candidate).
function statementSimilarity(a, b) {
  const sa = new Set(statementSignature(a).split(" ").filter(Boolean));
  const sb = new Set(statementSignature(b).split(" ").filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter || 1);
}

// Fraction of the LEAD's content tokens retained by a candidate statement
// (asymmetric coverage of the lead by the candidate). A HEAVY reword of the same
// hypothesis keeps the lead's SUBJECT tokens even as its predicate is reworded
// (e.g. "anisotropic specular ... inverse-rendering gradient instability" ->
// "anisotropic BRDF specular lobes drive inverse-rendering convergence failure"
// still retains anisotropic/specular/inverse/rendering). Such a reword can fall
// below the symmetric Jaccard paraphrase threshold (0.6) yet is NOT a different
// hypothesis — it is the SAME improving lead. Jaccard alone under-counts it
// because the added predicate tokens inflate the union. This asymmetric ratio is
// the complementary signal the guard uses so a below-Jaccard reword on the
// null-id fallback path is still recognised as the lead (and protected), while a
// genuinely disjoint alternative — which retains ~none of the lead's tokens —
// is not (adversarial finding: lens false-suppression via heavy reword).
function statementLeadCoverage(candidate, lead) {
  const cand = new Set(statementSignature(candidate).split(" ").filter(Boolean));
  const leadTokens = new Set(statementSignature(lead).split(" ").filter(Boolean));
  if (leadTokens.size === 0) return 0;
  let inter = 0;
  for (const t of leadTokens) if (cand.has(t)) inter += 1;
  return inter / leadTokens.size;
}
// A candidate is a reword of the current lead — not a different candidate — if it
// is a symmetric paraphrase (Jaccard >= PARAPHRASE_SIMILARITY) OR it retains at
// least REWORD_LEAD_COVERAGE of the lead's own content tokens (subject continuity
// under a heavy predicate reword). The coverage bar sits WELL above the ~0 overlap
// of a genuinely distinct hypothesis, so legitimate different-candidate promotions
// are unaffected.
const PARAPHRASE_SIMILARITY = 0.6;
const REWORD_LEAD_COVERAGE = 0.5;
function isRewordOfLead(candidateStatement, leadStatement) {
  if (candidateStatement == null || !leadStatement) return false;
  return (
    statementSimilarity(candidateStatement, leadStatement) >= PARAPHRASE_SIMILARITY ||
    statementLeadCoverage(candidateStatement, leadStatement) >= REWORD_LEAD_COVERAGE
  );
}

// What the LabDirector itself declared this lead to be.
//
// The director writes `primary_family=<name>` and `dataset=<uri>` into the lead
// statement, and its contract requires the family to stay constant while it keeps
// refining the same lead (lead_family_declaration_directive). Measured on
// cycle-g-v75: 37 of 39 recorded leads carried a family and 35 carried a dataset,
// so this is the handle the director actually provides.
// The director declares its family in prose as often as in the key=value form.
//
// MEASURED on cycle-g-v84: of the eight distinct lead statements in the ledger,
// `primary_family=X` matched exactly ONE. The others read "Primary family
// light_transport_estimators:", "Primary family residual_rerendering:",
// "Selected-light_transport_estimators on procedural://...", or opened with a
// preamble ("PROVISIONAL, NOT PROMOTED:", "Rank 1 -", "Provisional inversion
// candidate:") and declared the family later or not at all.
//
// Every miss falls through to statementSignature, which is a signature of prose
// nobody controls, so each rewording mints a new lead. One idea -- bright-outlier
// morphology predicting post-edit tail RMSE -- was filed as FOUR leads
// (hyp:d600a4c5, hyp:3ed36acb, path_space_robustness_diagnostics,
// hyp:c824f0d9), and low-spp residual autocorrelation as two. 13 recorded leads
// were roughly 7 ideas. That is the v75 fragmentation again in a different
// surface form, and it starves the anti-churn guard of the round history it is
// supposed to reason over.
const DECLARED_FAMILY_RE = /primary[_\s-]*family\s*[=:]?\s*([A-Za-z0-9_]+)/i;
// "Selected-light_transport_estimators on procedural://..." - a bare declaration
// with no "family" keyword. Snake_case is required so this cannot swallow
// ordinary prose ("Selected - the best option"); every family this repo has used
// is snake_case.
const SELECTED_FAMILY_RE = /\bselected\b\s*[=:—–-]\s*([a-z0-9]+(?:_[a-z0-9]+)+)/i;
// A bare id that is itself a family name, e.g. hypothesis_id "path_guiding". It
// must key to the SAME lead as a statement declaring that family, or the two
// spellings of one idea stay two leads - which is how light_transport_estimators
// and hyp:8adfd938 (statement: "Primary family light_transport_estimators: ...")
// ended up as separate leads in v84.
const BARE_FAMILY_ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)+$/i;
const DECLARED_DATASET_RE = /dataset\s*=\s*([A-Za-z0-9_+.-]+:\/\/[^\s;,)]+)/;

// An identity slot holding a STATUS instead of a lead.
//
// cycle-g-v84 spent a whole gate round on a lead called
// `unselected_pending_chronicle` -- scored 18/4/3/42/12 -- because the director
// emitted that string as `hypothesis_id` while it was still deferring, and an
// explicit id is authoritative here. It became the eighth distinct lead of the
// cycle, took a round away from the real ones, and invalidated the reviews
// briefed on whatever preceded it. Every lead change costs the cycle a round that
// can only score the rubrics a fresh reviewer covers, which is how
// rounds_since_improvement reached 5 and the stagnation rule fired.
//
// This is the same leak as the literature search running on "selected pending
// chronicle" (fixed in the scout query derivation): a placeholder escaping the
// field it was written in and being treated as content. Blocking it in one place
// does not block it in the others - they read different fields.
const PLACEHOLDER_IDENTITY_RE = /(?:^|[\s_-])(?:un)?selected[\s_-]*(?:pending|awaiting)|(?:^|[\s_-])(?:no|not)[\s_-]+(?:hypothesis|lead|selected)|withheld|deferred[\s_-]*pending|pending[\s_-]*chronicle|awaiting[\s_-]*(?:chronicle|evidence)|terminal[\s_-]*no[\s_-]*survivor/i;

function isPlaceholderIdentity(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  return PLACEHOLDER_IDENTITY_RE.test(text);
}

function declaredLeadIdentity(statement) {
  const text = String(statement || "");
  const family =
    (text.match(DECLARED_FAMILY_RE) || [])[1] || (text.match(SELECTED_FAMILY_RE) || [])[1];
  if (!family) return null;
  // Trailing sentence punctuation is not part of the URI. `...-v1.` and `...-v1`
  // are the same dataset, and letting a full stop through would fragment a lead
  // exactly the way the drifting prose already did.
  const dataset = ((text.match(DECLARED_DATASET_RE) || [])[1] || "").replace(/[.,;:)\]]+$/, "");
  // Family AND dataset, when both are declared. Family alone would merge two
  // genuinely different experiments that happen to share a method family; adding
  // the dataset keeps them apart at the cost of splitting a family that legitimately
  // moves to new data, which is the safer error for a guard that decides whether a
  // lead may be abandoned.
  return dataset ? `${family.toLowerCase()}|${dataset.toLowerCase()}` : family.toLowerCase();
}

function hypothesisKey({ hypothesisId, familyRoot, statement, primaryFamily } = {}) {
  // THE FAMILY THE DIRECTOR ALREADY DECLARED, IN A FIELD, NOT IN PROSE.
  //
  // `selected_hypothesis.primary_family` is part of the lab-director output
  // contract and the director fills it: 12 of 13 director lanes on cycle-g-v84
  // carried it, naming FIVE distinct families. The ledger recorded SIXTEEN leads
  // over the same 28 rounds, because it never read that field - it parsed the
  // statement prose instead, and 21 of 28 statements declare no family anywhere
  // in their text ("PROVISIONAL-NOT PROMOTED: spatial bright-outlier morphology
  // predicts ...", "Rank 1 - On three frozen Mitsuba edit-pair strata ..."). Each
  // time the director reworded its preamble the signature moved and a new lead
  // was minted for the same idea; one idea was filed as four leads.
  //
  // So the anti-churn guard was reasoning over a ledger where no lead could
  // accumulate rounds - the same failure as v75, with the structured answer
  // sitting unread in the artifact the whole time. Widening the prose regex does
  // not help and was measured not to: 16 leads before, 16 after. You cannot parse
  // what was never written down. This reads the field that was.
  const declaredFamily = String(primaryFamily || "").trim();
  if (declaredFamily && !isPlaceholderIdentity(declaredFamily)) {
    return `hyp:${crypto.createHash("sha256").update(declaredFamily.toLowerCase()).digest("hex").slice(0, 16)}`;
  }
  // An explicit hypothesis id is authoritative. Otherwise the key must be
  // DISCRIMINATIVE per distinct hypothesis yet STABLE across trivial rewordings
  // (the LabDirector paraphrases the lead every round).
  //
  // THE FRAGMENTATION THIS FIXES (cycle-g-v75). The `statement` this receives is
  // not the hypothesis statement: it is `currentIdentity.primary_text`, a
  // concatenation of ~18 hypothesis-artifact fields truncated to 600 characters —
  // every one of the cycle's 39 recorded leads had a signed statement of exactly
  // 600 chars. A dataset resolving, `selected_hypothesis` filling in, or the
  // director changing its preamble ("SELECTED —" / "PROVISIONAL RANK 1 —" /
  // "Provisional first replacement:") shifts that window, changes the signature and
  // mints a NEW lead for the same hypothesis. 38 recorded leads were 23 distinct
  // ideas; `rare_event_splitting` was filed as five separate leads across rounds
  // 3-9. No lead could accumulate rounds, so the ledger had no history to judge,
  // and the whole anti-churn apparatus — protection, stall detection, commit lock —
  // was built on data that never existed.
  //
  // The director's own declaration is stable by construction and is the thing it is
  // contractually required to hold constant while refining, so it is preferred over
  // any signature of prose that nobody controls. The signature remains the fallback
  // for a lead that declares no family.
  const explicit = String(hypothesisId || "").trim();
  // An explicit id is authoritative only if it names a hypothesis. A status
  // string ("unselected_pending_chronicle") falls through to the declared family
  // or the statement signature, so a deferring round joins the lead it is actually
  // about instead of minting a new one.
  if (explicit && !isPlaceholderIdentity(explicit)) {
    // A bare family name as the id goes through the same derivation as a declared
    // family, so "path_guiding" and "primary_family=path_guiding: ..." are one lead.
    if (BARE_FAMILY_ID_RE.test(explicit)) {
      return `hyp:${crypto.createHash("sha256").update(explicit.toLowerCase()).digest("hex").slice(0, 16)}`;
    }
    return explicit;
  }
  const declared = declaredLeadIdentity(statement);
  if (declared) {
    return `hyp:${crypto.createHash("sha256").update(declared).digest("hex").slice(0, 16)}`;
  }
  const sig = statementSignature(statement);
  const ns = String(familyRoot || "").trim();
  const material = ns ? `${ns}|${sig}` : sig;
  return `hyp:${crypto.createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

// Clamp a reviewer score into the valid [0,100] band (guards against out-of-range
// or injected scores that would pump/negate the composite).
function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function applicableRubric(rubric) {
  // Exclude not-yet-observed placeholders (a gatekeeper lane that did not return
  // this round, tagged focused_review_missing): a transiently-missing lane's
  // phantom score:0 must NOT enter the binding/composite/stall accounting, or it
  // would false-stall and drop a still-improving lead (adversarial finding — the
  // missing-lane condition is a first-class production event in this harness).
  return (Array.isArray(rubric) ? rubric : []).filter(
    (it) => it && it.applicable !== false && it.focused_review_missing !== true,
  );
}

// Composite = mean of applicable rubric scores (the lead's overall standing).
function compositeScore(rubric) {
  const items = applicableRubric(rubric);
  if (items.length === 0) return 0;
  return items.reduce((s, it) => s + clampScore(it.score), 0) / items.length;
}

// The binding rubric is the lowest applicable one — the single constraint the
// next round must raise (curriculum). Returns { name, score }.
function bindingRubric(rubric) {
  const items = applicableRubric(rubric);
  if (items.length === 0) return { name: null, score: 0 };
  return items
    .map((it) => ({ name: String(it.name || ""), score: clampScore(it.score) }))
    .reduce((low, it) => (it.score < low.score ? it : low));
}

// Build a MemoryRecord for one gatekeeper-reviewed round. `event_id` is the
// append position; `now` is injected for determinism/testability.
function buildProgressRecord({
  cycleId,
  round,
  reviewLaneId,
  statement,
  hypothesisId,
  familyRoot,
  primaryFamily,
  rubric,
  verdict,
  gatePassed = false,
  now,
  eventId,
}) {
  const key = hypothesisKey({ hypothesisId, familyRoot, statement, primaryFamily });
  // Clamp every score to [0,100] at write time so an out-of-range reviewer score
  // (or an injected huge value) cannot "pump" the composite unboundedly and
  // create an infinite false-lock, nor push it negative (adversarial finding).
  const clampedRubric = applicableRubric(rubric).map((it) => ({
    name: String(it.name || ""),
    score: clampScore(it.score),
    applicable: it.applicable !== false,
  }));
  const content = {
    statement: String(statement || "").slice(0, 600),
    rubric: clampedRubric,
    verdict: verdict || null,
    gate_passed: gatePassed === true,
    composite: compositeScore(clampedRubric),
    binding_rubric: bindingRubric(clampedRubric),
  };
  const record = {
    schema: SCHEMA,
    memory_id: key,
    run_id: cycleId,
    task_id: `round-${round}`,
    trace_id: cycleId,
    source_message_id: reviewLaneId || null,
    writer: "gatekeeper",
    memory_type: "decision",
    scope: "run",
    status: "active",
    supersedes: [],
    valid_from_event: eventId || null,
    event_id: eventId || null,
    ts: now || null,
    content,
  };
  record.audit_hash = recordHash(record);
  return record;
}

// --- Event-graph IO (append-only jsonl) --------------------------------------

function progressLogPath(root, cycleId) {
  return path.join(root, "state", `${cycleId}-hypothesis-progress.jsonl`);
}

function readProgressLog(root, cycleId, fsImpl = fs) {
  const p = progressLogPath(root, cycleId);
  let raw = "";
  try {
    if (!fsImpl.existsSync(p)) return [];
    raw = fsImpl.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip a torn tail line */
    }
  }
  return out;
}

function appendProgressRecord(root, cycleId, record, fsImpl = fs) {
  const p = progressLogPath(root, cycleId);
  try {
    fsImpl.mkdirSync(path.dirname(p), { recursive: true });
    fsImpl.appendFileSync(p, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* append is best-effort; the log is a ledger, not the source of truth cache */
  }
  return record;
}

// Append a guard DECISION as its own event in the append-only graph (ACM-CP
// causal-policy trace). Decision events are tamper-evident (hashed) and carry an
// event_type so they are trivially separable from memory (progress) records; they
// are NOT progress records (no rubric) so rollupByHypothesis ignores them, but
// readDecisionTrail replays them for reconstructability.
const DECISION_EVENT_TYPE = "lead_supersession_decision";
// Integrity hash of a decision event over its OWN material (event_type is INSIDE
// this envelope — unlike a progress record's audit_hash, which does not cover
// event_type). A record only counts as a decision if this hash is present and
// matches, so a progress record with an injected event_type (whose audit_hash is
// a PROGRESS hash, not a decision hash) can never masquerade as a decision.
function decisionHash(event) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(canonical({ event_type: event.event_type, run_id: event.run_id, decision: event.decision }))
    .digest("hex")}`;
}
// A well-formed decision event: right event_type, same run, and its own decision
// audit_hash validates. Fail-closed — this is the ONLY way into the decision trail.
function isDecisionEvent(record, cycleId) {
  return (
    !!record &&
    record.event_type === DECISION_EVENT_TYPE &&
    String(record.run_id) === String(cycleId) &&
    !!record.audit_hash &&
    decisionHash(record) === record.audit_hash
  );
}
function appendDecisionEvent(root, cycleId, decision, fsImpl = fs, now = null) {
  const event = {
    schema: "acmcp.hypothesis_progress.decision/1",
    event_type: DECISION_EVENT_TYPE,
    run_id: cycleId,
    ts: now,
    decision: decision || null,
  };
  event.audit_hash = decisionHash(event);
  return appendProgressRecord(root, cycleId, event, fsImpl);
}

function readDecisionTrail(root, cycleId, fsImpl = fs) {
  return readProgressLog(root, cycleId, fsImpl).filter((r) => isDecisionEvent(r, cycleId));
}

// Integrity + provenance gate on READ (ACM-CP CouplingGuard, fail-closed): a
// record is admitted only if same-run, its content still matches its audit_hash,
// and it declares a provenance source. Denied records read as absent.
// Lifecycle statuses that may legitimately appear in the ledger and be READ (the
// rollup interprets superseded/banked). Anything else (revoked/redacted/expired/
// unknown) is a removal/tamper state and is denied on read — the ACM-CP freshness
// check. `active` is the normal case.
const READABLE_STATUSES = new Set(["active", "superseded", "banked"]);

function admitProgressRecord(record, cycleId) {
  if (!record || typeof record !== "object") return false;
  if (String(record.run_id) !== String(cycleId)) return false; // run binding
  // A progress record NEVER carries an event_type (buildProgressRecord does not
  // set one, and event_type is OUTSIDE the audit_hash envelope). Any event_type
  // present is therefore an out-of-envelope injection whose only purpose is to
  // make an admitted progress record ALSO read as a decision event — muddying the
  // memory-record vs decision-event separation. Deny it (fail-closed).
  if (record.event_type != null) return false;
  // Integrity FAIL-CLOSED: the audit_hash must be PRESENT and match. A missing
  // hash is not a free pass — an omitted-hash record is exactly the injection an
  // attacker would use to poison the progress history (hashless flat/low rounds
  // that force a false stall), so it is denied, not admitted unchecked.
  if (!record.audit_hash || recordHash(record) !== record.audit_hash) return false; // integrity
  if (!record.source_message_id) return false; // provenance (fail-closed)
  // Freshness (ACM-CP status check): revoked/redacted/expired/unknown are denied.
  if (!READABLE_STATUSES.has(String(record.status || "active"))) return false;
  return true;
}

// --- Best-so-far (critical memory) + reconstruction --------------------------

// Per-hypothesis rollup: best composite seen, best-per-rubric seen, round count,
// and the rounds where its binding rubric last improved (for stall detection).
function rollupByHypothesis(records, cycleId) {
  // Admit only valid records, then DEDUPE by audit_hash: a double-appended or
  // replayed identical round (same memory_id + task_id + content => same hash) is
  // counted ONCE, so a refresh pass that writes the same round 2-3x, or a replay
  // of a validly-signed record, cannot inflate round counts / poison stall
  // accounting (adversarial finding). Distinct rounds differ in task_id => differ
  // in hash => kept.
  const seenHash = new Set();
  const admitted = records.filter((r) => {
    if (!admitProgressRecord(r, cycleId)) return false;
    const h = String(r.audit_hash);
    if (seenHash.has(h)) return false;
    seenHash.add(h);
    return true;
  });
  const map = new Map();
  for (const r of admitted) {
    const key = r.memory_id;
    const cur =
      map.get(key) ||
      {
        memory_id: key,
        statement: r.content?.statement || "",
        rounds: 0,
        last_round_index: 0,
        best_composite: -Infinity,
        best_by_rubric: {},
        binding_best_history: [],
        composite_history: [],
        rubric_history: {},
        last_verdict: null,
        gate_passed: false,
        latest: null,
        superseded: false,
        banked: false,
      };
    cur.rounds += 1;
    cur.latest = r;
    // Which review round this lead was last SCORED in. `rounds` counts a lead's
    // own records and cannot distinguish "young, two rounds old" from "scored
    // twice, forty rounds ago" — the distinction leadIsStalled needs.
    const roundIndex = Number(String(r.task_id || "").replace(/^round-/, ""));
    if (Number.isFinite(roundIndex)) {
      cur.last_round_index = Math.max(cur.last_round_index ?? 0, roundIndex);
    }
    cur.last_verdict = r.content?.verdict ?? cur.last_verdict;
    cur.gate_passed = cur.gate_passed || r.content?.gate_passed === true;
    if (r.status === "superseded") cur.superseded = true;
    if (r.status === "banked") cur.banked = true;
    // A rubric at 100 is an aggregation placeholder, not a reviewer's score, and
    // it must not become a lead's high-water mark. progress_watchdog.js already
    // refuses these ("a reasonless aggregation placeholder must not convince the
    // watchdog that soundness is fine"); the ledger did not, and that asymmetry
    // is what let one bad round decide which lead the anti-churn guard protects.
    //
    // MEASURED ON cycle-g-v81. Round 44 of lead hyp:67888a39d950443e scored
    // novelty=100, technical_quality=100, impact=100 - the next round of the same
    // lead came back 25 / 18 / 12. The placeholder round set best_composite=90
    // and best_by_rubric novelty/technical_quality/impact = 100, so that lead
    // stayed `bestSoFarLead` for the rest of the cycle even though it was
    // abandoned at round 44 of 57. Being both the protected lead AND permanently
    // dormant, it answered every pivot request with
    // `lead_stalled_pivot_permitted` - 95 times - while the genuinely strongest
    // active lead (composite 86.6, last scored at round 49) was never protected.
    // Leads got 2.04 rounds each.
    const placeholder = (value) => !Number.isFinite(value) || value >= 100;
    const roundHasPlaceholder = (r.content?.rubric || []).some(
      (it) => it?.applicable !== false && placeholder(Number(it?.score)),
    );
    const comp = Number(r.content?.composite || 0);
    // A composite computed from a placeholder round inherits the fiction.
    if (!roundHasPlaceholder && comp > cur.best_composite) cur.best_composite = comp;
    for (const it of r.content?.rubric || []) {
      const score = Number(it.score);
      if (placeholder(score)) continue;
      const prev = cur.best_by_rubric[it.name];
      if (prev == null || score > prev) cur.best_by_rubric[it.name] = score;
      // per-rubric per-round series, so stall can be judged on a rubric's OWN
      // trajectory (a newly-entered climbing rubric vs its own baseline), immune
      // to the binding-rubric IDENTITY changing round-to-round as the set grows.
      (cur.rubric_history[it.name] ||= []).push(score);
    }
    const b = r.content?.binding_rubric || { name: null, score: 0 };
    cur.binding_best_history.push(Number(b.score || 0));
    cur.composite_history.push(comp);
    map.set(key, cur);
  }
  return map;
}

// The best-so-far ACTIVE lead is the critical memory. It is the non-superseded
// hypothesis with the highest best_composite (ties broken by most rounds of
// sustained work).
// `declined`: leads the director was asked to resume and declined with a reason
// (directorResumeDeclines). They are no longer "the best lead to protect": the
// question was put and answered, so the guard ranks the leads still in play.
function bestSoFarLead(records, cycleId, declined = null) {
  const roll = rollupByHypothesis(records, cycleId);
  let best = null;
  for (const cur of roll.values()) {
    if (cur.superseded || cur.banked) continue;
    if (declined && declinedResumeFor(declined, cur.memory_id)) continue;
    if (
      !best ||
      cur.best_composite > best.best_composite ||
      (cur.best_composite === best.best_composite && cur.rounds > best.rounds)
    ) {
      best = cur;
    }
  }
  return best;
}

// Which lead should the LAST of the review budget be spent on?
//
// `bestSoFarLead` ranks by best_composite — the mean of all rubrics. That is the
// right "who is furthest along" signal while exploring, but it is the wrong one
// at the budget wall, because composite mostly measures HOW MUCH VALIDATION HAS
// ALREADY RUN, not how much the lead is worth finishing. Measured on v66: the
// most novel lead scored novelty 73 / tech 31 / repro 12 (composite ~38) purely
// because its experiment had not run yet ("no validation artifact ... supplied"),
// while a lead with named prior art (Neural Control Variates) scored 48/38/64
// (composite ~50) and won the hold — so the remaining budget consolidated the
// UNORIGINAL lead and the novel one was never validated. Every axis was reachable
// (novelty 73, repro 64) but never on the same hypothesis.
//
// At the wall we therefore concentrate on the most NOVEL surviving lead: novelty
// is the axis that cannot be manufactured by spending more budget (prior art
// either exists or it does not), whereas technical_quality/reproducibility are
// exactly what the remaining runner budget can still buy. Ties fall back to
// composite, then to sustained rounds.
// The lead's own hypothesis TEXT, which every guard decision must carry.
//
// WHY THIS EXISTS. The anti-churn decisions tell the LabDirector "keep refining
// THIS lead" but identified it only by `memory_id` — an opaque `hyp:<hash>`
// token. With no statement, the director cannot tell which hypothesis it is
// being held to, and on v72 it wrote the meta-message itself into the lead:
// "attempt 42 currently exposes only unauditable token hyp:54495e4f4f542acd, so
// no rendering claim may be inferred". The gatekeeper then scored a lead with no
// scientific content ("The lead is unidentified, preventing claim-specific
// comparison with prior art", novelty 0), and novelty fell from a peak of 64 to
// single digits — not because the science got worse, but because the hypothesis
// had been lost in transit. The statement is already stored on every progress
// record; it just was not being handed back.
function leadStatement(lead) {
  return (
    lead?.statement ||
    lead?.latest?.content?.statement ||
    null
  );
}

function exploitFocusLead(records, cycleId) {
  const roll = rollupByHypothesis(records, cycleId);
  const noveltyOf = (cur) => clampScore(cur?.best_by_rubric?.novelty);
  let best = null;
  for (const cur of roll.values()) {
    if (cur.superseded || cur.banked) continue;
    if (!best) {
      best = cur;
      continue;
    }
    const a = noveltyOf(cur);
    const b = noveltyOf(best);
    if (
      a > b ||
      (a === b && cur.best_composite > best.best_composite) ||
      (a === b && cur.best_composite === best.best_composite && cur.rounds > best.rounds)
    ) {
      best = cur;
    }
  }
  return best;
}

// Is the lead genuinely stalled over the last STALL_ROUNDS rounds? A lead counts
// as making progress — and is therefore PROTECTED (not stalled) — if EITHER its
// binding (lowest) rubric OR its overall composite advanced. It is stalled only
// when BOTH are flat/regressing. This is critical: a lead can raise its other
// rubrics (composite climbs) while its lowest rubric temporarily plateaus; judging
// stall on the binding rubric alone would falsely drop a still-improving lead
// (adversarial finding). Requiring a real (>= epsilon) gain on BOTH axes also
// prevents an infinite micro-jitter lock (a lead nudging +0.1 forever is stalled).
// WHY a lead is stalled, because the two reasons deserve opposite answers.
//
// `plateau` - the lead was worked on and stopped improving. Pivoting away is the
// right call.
//
// `dormant` - nobody has scored it for stallRounds rounds. It did not fail; it
// was dropped. Treating that as a licence to pivot is how the guard disarms
// itself: the best lead gets abandoned, goes dormant, and from then on answers
// every pivot request with "permitted", forever.
//
// MEASURED ON cycle-g-v81: 95 of 190 ledger decisions were
// lead_stalled_pivot_permitted, all naming hyp:67888a39d950443e - the best lead,
// last scored at round 44 of 57. Leads averaged 2.04 rounds each.
//
// A dormant best lead still returns `allow`, because refusing would rebuild the
// v75 deadlock where an abandoned lead was protected for 141 consecutive denies.
// What changes is that the allow carries the lead back with it.
function leadStallKind(
  leadRollup,
  stallRounds = STALL_ROUNDS,
  epsilon = IMPROVEMENT_EPSILON,
  currentRound = 0,
) {
  if (!leadRollup) return "dormant";
  const lastRound = Number(leadRollup.last_round_index || 0);
  if (currentRound > 0 && lastRound > 0 && currentRound - lastRound > stallRounds) {
    return "dormant";
  }
  return leadIsStalled(leadRollup, stallRounds, epsilon, currentRound) ? "plateau" : null;
}

function leadIsStalled(leadRollup, stallRounds = STALL_ROUNDS, epsilon = IMPROVEMENT_EPSILON, currentRound = 0) {
  if (!leadRollup) return true; // no lead => nothing to protect
  // Stall is judged on the BINDING (gate-blocking, lowest) rubric only. That is
  // the dimension that actually decides whether the lead can pass; progress on
  // OTHER rubrics (a rising composite) does NOT advance the gate, so it must NOT
  // rescue a lead whose blocker is stuck — doing so false-LOCKS an unpassable lead
  // forever (adversarial finding). Conversely a lead whose binding rubric is only
  // TEMPORARILY plateaued is protected by the grace window: an axis is "still
  // progressing" iff the last `stallRounds` rounds set a NEW high versus all
  // earlier rounds (new-high, not window[0], so saw-tooth / dip-then-recover
  // jitter is not mistaken for progress). Needs > stallRounds rounds to judge, so
  // a brief plateau is never punished.
  const hist = Array.isArray(leadRollup.binding_best_history) ? leadRollup.binding_best_history : [];
  // STALLED BY ABSENCE. "Too early to judge" is the right call for a lead being
  // actively worked on; it is the wrong call for one nobody has touched in
  // dozens of rounds, and the two are indistinguishable by history LENGTH alone.
  //
  // MEASURED ON cycle-g-v75. hyp:f199ba08 was scored in rounds 1 and 2 and never
  // again. At round 43 it still held the protection: 2 <= stallRounds(4), so the
  // guard returned "not stalled" and denied every pivot -- 141 denies. Its
  // history could never grow past 2, because growing it requires the lead to be
  // reviewed and the reviews were all going to other hypotheses. A deadlock: it
  // could not be declared stalled because it was not being worked on, and the
  // reason it was not being worked on was that it had been abandoned 41 rounds
  // earlier. Nine consecutive LabDirectors, each handed the protection text and
  // the lead's name, all chose `replace` -- the sane response to being told to
  // keep refining something the cycle left behind.
  //
  // A lead that has gone `stallRounds` full review rounds without being scored
  // is not improving, whatever its history looks like. currentRound is the
  // cycle's newest round; a lead whose own last round trails it by more than the
  // window has stalled by absence.
  const lastRound = Number(leadRollup.last_round_index || 0);
  if (currentRound > 0 && lastRound > 0 && currentRound - lastRound > stallRounds) return true;
  if (hist.length <= stallRounds) return false; // too early — protect (not stalled)
  // An axis "sets a new high" if its last `stallRounds` rounds reach at least
  // `epsilon` above every earlier round. Strict `<` so a genuine +epsilon integer
  // gain to an unprecedented high counts as progress (only sub-epsilon jitter is
  // stalled). Empty prior => -Infinity, so a just-entered climbing rubric reads as
  // a new high against its own (empty) baseline.
  const setsNewHigh = (series, allowShortClimb) => {
    const s = Array.isArray(series) ? series : [];
    if (s.length <= stallRounds) {
      // Too short for the windowed test. A short series counts as progress ONLY as
      // a genuine MULTI-ROUND monotonic climb (>=2 rounds, strictly increasing) —
      // this recognises a legitimately late-entering rubric that is climbing on its
      // OWN axis, while a reviewer that emits a FRESH lowest-rubric name every round
      // (each own-series length 1) cannot masquerade as progress and false-lock a
      // dead-flat unpassable lead forever (adversarial finding).
      if (!allowShortClimb) return false;
      return s.length >= 2 && s.every((v, i) => i === 0 || v > s[i - 1]);
    }
    const priorMax = s.slice(0, -stallRounds).length ? Math.max(...s.slice(0, -stallRounds)) : -Infinity;
    return Math.max(...s.slice(-stallRounds)) >= priorMax + epsilon;
  };
  // TWO-SIGNAL, churn-safe: the lead is stalled only if NEITHER the floor history
  // (min-rubric-per-round) NOR the CURRENT binding rubric's OWN per-rubric series
  // sets a new high. Signal 1 keeps the correct behaviour when the rubric SET is
  // constant (the floor rises while WHICH rubric is weakest rotates). Signal 2 is
  // the churn fix: when a new soundness rubric enters low and climbs, its own
  // trajectory shows progress even though the mixed floor history looks flat. It
  // is the binding rubric's OWN scores (not the composite), so a rising composite
  // on non-binding axes still cannot rescue a genuinely unpassable lead.
  //
  // BOTH signals pass shortIsProgress=false: a too-short series is NOT counted as
  // progress. Signal 1's own young-lead grace is already provided by the earlier
  // `hist.length <= stallRounds => false` guard; and for signal 2 a free-pass on a
  // short own-series would let a reviewer that emits a FRESH lowest-rubric name
  // every round keep every own-series at length 1 and false-lock a dead-flat,
  // unpassable lead forever (adversarial finding). A genuinely late-entering rubric
  // is instead recognised as progress once its own series exceeds STALL_ROUNDS.
  const bindingName = leadRollup.latest?.content?.binding_rubric?.name || null;
  const bindingSeries = bindingName ? leadRollup.rubric_history?.[bindingName] : null;
  // Signal 1 (floor): no short free-pass (the early hist-length guard already gives
  // the young-lead grace). Signal 2 (binding own-series): a short series counts ONLY
  // as a genuine multi-round monotonic climb — protects a late-entering climbing
  // rubric (C22) while a fresh-name-every-round single-round series (each length 1)
  // cannot masquerade as progress (C25).
  return !(setsNewHigh(hist, false) || setsNewHigh(bindingSeries, true));
}

// --- Strong-validation commit lock (anti-churn) ------------------------------

// Does a validation-summary-like object report a statistically STRONG PASS? The
// runner emits heterogeneous shapes (validation_summary, top-level pass_fail,
// correlations/notes with embedded p-values), so this is deliberately tolerant: it
// scans the serialized object for a non-negative outcome plus a small p-value
// (p or perm_p < 0.01) OR a large effect (|correlation/slope/r| >= 0.7). It is a
// PROTECT-ONE-ROUND gate, not a scientific verdict — a false positive costs only an
// extra novelty-scoring round (cheap); a false negative just leaves the status quo.
function validationIsStatisticallyStrong(validation) {
  if (!validation || typeof validation !== "object") return false;
  const text = JSON.stringify(validation).toLowerCase();
  const status = String(validation.overall_status || validation.pass_fail || "").toLowerCase();
  // HARD-negative outcomes never produced a trustworthy statistic — veto. NOTE
  // "degraded"/"inconclusive"/"partial" are NOT here: this harness routinely marks
  // a run "degraded" for render-pipeline/materialization reasons while the PRIMARY
  // statistic (e.g. the p=2.26e-07 caustic/crossover result) is genuinely strong.
  // Vetoing on "degraded" is exactly what left the strong result unprotected and the
  // commit lock inert — the render degradation must not veto a robust statistic.
  if (/\b(failed|errored|error|aborted|not[_ ]?executed|no[_ ]?result|no[_ ]?data|empty)\b/.test(status)) {
    return false;
  }
  const positive =
    validation.pass_fail === "pass" ||
    /"pass_fail"\s*:\s*"pass"/.test(text) ||
    /\b(pass|passed|ok|completed|significant)\b/.test(status) ||
    /"overall_status"\s*:\s*"(pass|passed|ok|completed)"/.test(text);
  // Smallest p / perm_p present anywhere in the summary.
  let minP = Infinity;
  for (const m of text.matchAll(/(?:perm_?p|p[\s_-]?value|p)\s*[=:]\s*([0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && v <= 1) minP = Math.min(minP, v);
  }
  let strongEffect = false;
  for (const m of text.matchAll(/(?:correlation|corr|rho|slope|r2|auc|effect[_ ]?size|cohen)[^0-9-]{0,24}(-?[0-9]*\.?[0-9]+)/g)) {
    const v = Math.abs(Number(m[1]));
    if (Number.isFinite(v) && v >= 0.7 && v <= 1.0000001) strongEffect = true;
  }
  const strongP = minP < 0.01;
  // Clean PASS: either a small p OR a large effect. A non-positive-but-not-hard-
  // negative outcome (degraded/partial, pass_fail null) is protected only on a
  // ROBUST statistic — a very small p (<1e-3) or p<0.01 together with a large
  // effect — so a fluky single borderline p on a broken run does not lock a lead.
  if (positive) return strongP || strongEffect;
  return minP < 1e-3 || (strongP && strongEffect);
}

// How many admitted gate ROUNDS for `leadKey` actually SCORED novelty (novelty was
// an applicable rubric that round)? The commit lock releases once this reaches
// COMMIT_NOVELTY_ROUNDS — i.e. the strong lead has had its fair chance at the
// novelty scoring table.
function noveltyReviewRoundCount(records, cycleId, leadKey) {
  if (!leadKey) return 0;
  const roll = rollupByHypothesis(records, cycleId);
  const cur = roll.get(String(leadKey));
  if (!cur) return 0;
  const series = cur.rubric_history && cur.rubric_history.novelty;
  return Array.isArray(series) ? series.length : 0;
}

// --- The guarded pivot decision (fail-closed anti-suppression) ----------------

// Should the lab-director be ALLOWED to pivot away from / supersede the current
// best-so-far lead this round? Fail-closed: deny (keep refining the lead) unless
// the event graph justifies it. Returns an ACM-CP-style structured decision that
// is itself meant to be written to the event graph.
// LEVEL-2 STRATEGY POLICY (watchdog-driven). The progress watchdog publishes a
// declarative policy file (state/<cycle>-watchdog-policy.json); the launch
// wrapper exposes its path via RESEARCHLAB_WATCHDOG_POLICY. mode="exploit" means
// the review budget is running low WITHOUT convergence: stop exploring (no more
// lead swaps, no stall pivots) and spend what remains consolidating the best
// lead. Every deny issued here is appended to the supersession ledger, so the
// Rust dispatchers (ledger_denies_pivot) inherit the strategy change with zero
// Rust-side changes. Fail-open to "explore" (current behaviour) on any
// missing/unreadable policy — the watchdog's budget-wall HALT stays the backstop.
function readWatchdogPolicy(policyPathOverride = null) {
  const policyPath = policyPathOverride || process.env.RESEARCHLAB_WATCHDOG_POLICY || null;
  if (!policyPath) return { mode: "explore" };
  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.mode === "exploit") {
      return { mode: "exploit", reason: parsed.exploit_reason || null };
    }
  } catch {
    // unreadable/absent => explore
  }
  return { mode: "explore" };
}

// What the cycle has already paid for churn, and what this particular lead is
// worth. Facts off the ledger: no judgement, no new authority -- the director
// still owns the pivot, and now owns it knowing the price.
//
// cycle-g-v85 halted at 28 rounds / 12 lead changes / 2.33 rounds per lead. The
// lead it abandoned at 07:34 held novelty 72 and technical_quality 52, both the
// cycle's best, and after the pivot they fell to 55 and 22 and never came back.
// The directive at the time said only that prior leads "died this way".
function churnCost(records, cycleId, leadKey) {
  const rollups = rollupByHypothesis(records, cycleId);
  const rounds = [];
  for (const record of records || []) {
    if (!admitProgressRecord(record, cycleId)) continue;
    if (!Array.isArray(record?.content?.rubric)) continue;
    rounds.push(String(record.memory_id || ""));
  }
  const leadChanges = rounds.filter((id, i) => i > 0 && id !== rounds[i - 1]).length;
  const distinct = new Set(rounds.filter(Boolean)).size;

  // Which rubrics does the protected lead hold the cycle record on?
  const cycleBest = new Map();
  for (const rollup of rollups.values()) {
    for (const [name, score] of Object.entries(rollup?.best_by_rubric || {})) {
      if (!Number.isFinite(score)) continue;
      if (!cycleBest.has(name) || score > cycleBest.get(name).score) {
        cycleBest.set(name, { score, lead: rollup.memory_id });
      }
    }
  }
  const holdsBest = [];
  for (const [name, entry] of cycleBest.entries()) {
    if (leadKey && entry.lead === leadKey) holdsBest.push({ rubric: name, score: entry.score });
  }
  holdsBest.sort((a, b) => b.score - a.score);

  // How did past pivots actually turn out? Compare each new lead's best
  // composite against the composite of the lead it replaced.
  let pivotsWorse = 0;
  let pivotsBetter = 0;
  for (let i = 1; i < rounds.length; i += 1) {
    if (!rounds[i] || rounds[i] === rounds[i - 1]) continue;
    const before = rollups.get(rounds[i - 1]);
    const after = rollups.get(rounds[i]);
    const b = Number(before?.best_composite);
    const a = Number(after?.best_composite);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a < b) pivotsWorse += 1;
    else if (a > b) pivotsBetter += 1;
  }

  return {
    gate_rounds: rounds.length,
    lead_changes: leadChanges,
    distinct_leads: distinct,
    rounds_per_lead: distinct > 0 ? Number((rounds.length / distinct).toFixed(2)) : null,
    lead_holds_cycle_best: holdsBest,
    pivots_that_scored_worse: pivotsWorse,
    pivots_that_scored_better: pivotsBetter,
  };
}

// A completed run that FALSIFIED the current lead is not churn.
//
// MEASURED ON cycle-g-v89: 108 denies of
// `critical_memory_suppression_blocked_lead_still_improving` while the directors
// pivoted anyway, each citing the lead's own preregistered kill condition. The
// deny was delivered and answered, not bypassed -- see the shipped decision trail.
// `leadIsStalled` judges whether the binding rubric is still setting new highs, so
// a lead can read as "still improving" while its experiment has already returned a
// verdict against it. This is the fact the ledger was missing.
//
// The shape is taken from v89's real runner results, not assumed: the driver
// copies each check's resolution onto validation_summary.handoff_check_resolutions,
// and the blueprint's own metrics carry it one level down. Both are read.
const FALSIFICATION_STATUS = "valid_falsification";

function validationDeclaresFalsification(validationSummary) {
  if (!validationSummary || typeof validationSummary !== "object") return false;
  const declares = (item) => {
    if (!item || typeof item !== "object") return false;
    if (String(item.resolution_status || "").trim() === FALSIFICATION_STATUS) return true;
    return item.valid_falsification_result === true;
  };
  for (const resolution of asArrayLike(validationSummary.handoff_check_resolutions)) {
    if (declares(resolution)) return true;
  }
  for (const execution of asArrayLike(validationSummary.blueprint_executions)) {
    if (execution && typeof execution === "object" && declares(execution.metrics)) return true;
  }
  return false;
}

function asArrayLike(value) {
  return Array.isArray(value) ? value : [];
}

// The director's answers to "resume the strongest lead".
//
// MEASURED ON cycle-a-20260919, 2026-10-19: the best-scoring lead
// (hyp:74b518f1105b020b) was dormant, so every pivot decision carried "resume
// it" into the director's prompt. Its data were confirmed unobtainable and its
// one bound execution failed the preregistered balance gate, so no estimate
// existed. Seven of the last 40 director lanes said exactly that and chose
// another lead. The guard kept no record of the answer, asked again, and the
// lead changed eight times in a day on that branch alone. A decline with a
// reason is an answer: it is recorded, and the lead stops being the one the
// guard protects. A resume needs no record; the director simply selects it.
const MIN_DECLINE_REASON_CHARS = 40;

function normalizedLeadId(id) {
  return String(id || "").trim().toLowerCase();
}

function declinedResumeFor(declined, memoryId) {
  if (!declined || !memoryId) return null;
  const key = normalizedLeadId(memoryId);
  if (declined instanceof Map) return declined.get(key) || null;
  return declined[key] || null;
}

function withoutLead(declined, memoryId) {
  if (!declined || !memoryId) return declined;
  const copy = new Map(declined instanceof Map ? declined : Object.entries(declined));
  copy.delete(normalizedLeadId(memoryId));
  return copy;
}

function directorResumeDeclines({ root, cycleId }) {
  const declines = new Map();
  const lanesDir = path.join(root, "lanes", cycleId);
  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir).filter((name) => name.includes("lab-director"));
  } catch {
    return declines;
  }
  for (const laneId of entries) {
    const resultPath = path.join(lanesDir, laneId, "result.json");
    let extracted = null;
    try {
      extracted = JSON.parse(fs.readFileSync(resultPath, "utf8"))?.extracted_json || null;
    } catch {
      continue;
    }
    const answer = extracted?.resume_lead_decision;
    if (!answer || typeof answer !== "object") continue;
    const verdict = String(answer.decision || "").trim().toLowerCase();
    const reason = String(answer.reason || "").trim();
    const leadId = normalizedLeadId(answer.lead_id);
    if (verdict !== "decline" || !leadId || reason.length < MIN_DECLINE_REASON_CHARS) continue;
    declines.set(leadId, {
      lead_id: leadId,
      lane_id: laneId,
      reason: reason.slice(0, 600),
      evidence_refs: Array.isArray(answer.evidence_refs) ? answer.evidence_refs.slice(0, 10).map(String) : [],
    });
  }
  return declines;
}

// How many gate rounds a lead has held, from the append-only ledger.
function leadRoundsHeld(records, cycleId, leadKey) {
  if (!leadKey) return 0;
  const roll = rollupByHypothesis(records, cycleId);
  const entry = roll.get(leadKey);
  return Number(entry?.rounds || 0);
}

// Whether the decision trail already released this lead because a completed run
// falsified it. Only verified decision events count, so an injected record cannot
// retire a lead.
function leadFalsificationRelease(records, cycleId, memoryId) {
  if (!memoryId) return null;
  let releases = 0;
  let firstReleasedAt = null;
  for (const event of readDecisionTrailFromRecords(records, cycleId)) {
    const decision = event.decision || {};
    if (decision.reason !== "lead_falsified_by_completed_run") continue;
    if (String(decision.lead || "") !== String(memoryId)) continue;
    releases += 1;
    if (firstReleasedAt == null) firstReleasedAt = event.ts || null;
  }
  return releases ? { releases, first_released_at: firstReleasedAt } : null;
}

// Minimum gate rounds a lead must hold before an UNFALSIFIED pivot is allowed.
// Two rounds mirrors COMMIT_NOVELTY_ROUNDS: enough for a second, independent
// reading of the same lead, and short enough that a genuinely wrong lead is not
// carried for long. v89 held 9 of its 21 leads for exactly one round.
const MIN_LEAD_ROUNDS = Number(process.env.RESEARCHLAB_MIN_LEAD_ROUNDS || 2);

// Whether a proposed replacement can be judged against the method floor at all.
//
// The rule -- a valid falsification retires the method, not the question, and a
// question may not be retired until three distinct methods have been spent on it
// -- was unenforceable because the pivot path carried neither field. It carries
// them now, and this is what makes them load-bearing: a replacement that does not
// say which question it answers cannot supersede the lead, so the field costs
// something to omit.
//
// The deny reason is written to be read by the director, because the alternative
// to guidance here is a cycle that cannot pivot at all.
function questionAccountability({ proposedQuestion, proposedMethodsTried, currentQuestion }) {
  const question = String(proposedQuestion == null ? "" : proposedQuestion).trim();
  if (!question) {
    return {
      ok: false,
      reason: "replacement_states_no_research_question",
      evidence: { proposed_question: null },
      guidance:
        "This replacement names no research_problem_question, so whether it keeps the current "
        + "question or abandons it cannot be determined and the three-methods-per-question floor "
        + "cannot be counted. Restate the question this hypothesis answers -- verbatim if it is the "
        + "same question, which is the normal case after a falsification -- and list what has "
        + "already been tried against it in methods_tried.",
    };
  }

  const normalize = (value) => String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 240);
  const changesQuestion = Boolean(normalize(currentQuestion))
    && normalize(question) !== normalize(currentQuestion);
  if (!changesQuestion) {
    // A different method for the same question: exactly what the rule wants.
    return { ok: true };
  }

  const approaches = new Set(
    (Array.isArray(proposedMethodsTried) ? proposedMethodsTried : [])
      .map((entry) => normalize(typeof entry === "string" ? entry : entry?.approach))
      .filter(Boolean),
  );
  if (approaches.size >= METHODS_BEFORE_RETIRING_QUESTION) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "question_retired_before_method_floor",
    evidence: {
      proposed_question: question.slice(0, 200),
      distinct_methods_tried: approaches.size,
      methods_required: METHODS_BEFORE_RETIRING_QUESTION,
    },
    guidance:
      `This replacement moves to a different question with ${approaches.size} distinct approach(es) `
      + `recorded against the current one, below the floor of ${METHODS_BEFORE_RETIRING_QUESTION}. `
      + "The falsification retired the METHOD: bring a different approach to the same question and "
      + "record the dead one in methods_tried with what it rules out. If the question really is "
      + "exhausted, list the three approaches already spent on it and set retires_the_question.",
  };
}

const METHODS_BEFORE_RETIRING_QUESTION = 3;

function evaluateLeadSupersession({
  records,
  cycleId,
  proposedComposite = null,
  proposedRubric = null,
  proposedHypothesisKey = null,
  proposedStatement = null,
  // The lead whose evidence this gate round is reviewing. This can differ from
  // the historical best-so-far lead, which remains useful for anti-churn holds
  // but must never receive another lead's falsification verdict.
  currentLeadKey = null,
  currentLeadStatement = null,
  // What question the replacement still answers, and what has already been spent
  // on it. The contract has asked for three methods per question since cd64ba8;
  // this is the first time the guard can see either. Null means the director did
  // not say, which is the case the enforcement below exists for.
  proposedQuestion = null,
  proposedMethodsTried = null,
  currentQuestion = null,
  // The director's own replacement record. Its presence is what switches the
  // question requirement on, so an unwired caller stays permissive.
  proposedReplacement = null,
  // Did the caller actually look for the director's replacement? A caller that
  // looked and found nothing has learned something; a caller that never looked
  // has not, and must not have its silence read as the director's.
  replacementLookupPerformed = false,
  stallRounds = STALL_ROUNDS,
  // Anti-churn commit lock: set active when the CURRENT lead has a statistically
  // strong completed validation of its own. `leadKey` identifies that lead; the
  // lock holds until it has accrued COMMIT_NOVELTY_ROUNDS novelty-scoring rounds.
  strongValidationCommit = null,
  // Level-2 policy injection for tests; runtime falls back to the env-named file.
  policy = null,
  // The current lead's newest completed validation. When it reports a valid
  // falsification the pivot is released: the ledger cannot ask a director to keep
  // refining a method its own preregistered kill condition has already retired.
  leadValidationSummary = null,
  // Experiment requests this director has been SHOWN repeatedly and never
  // answered. Empty by default, so an unwired caller denies nothing -- the same
  // rule the question guard follows, and for the same reason: denying every
  // pivot for my omission would look exactly like a director refusing to answer.
  //
  // The threshold lives at the call site, not here. One silent lane is a lane
  // being busy; the caller decides how many times counts as a refusal, so this
  // cannot deadlock a cycle the way v82 did when the director was told to cite
  // something that did not exist.
  ignoredExperimentRequests = [],
  // Dormant best leads the director was told to resume and declined, with a
  // reason, in `resume_lead_decision` (directorResumeDeclines). Empty by default.
  declinedResumes = null,
}) {
  // A director that will not answer the author's request does not get to change
  // the subject. The author asked for the run that would settle a claim the
  // manuscript is making without support; ignoring it and pivoting instead is
  // how a cycle spends its budget without ever testing what it claims.
  const ignoredRequests = Array.isArray(ignoredExperimentRequests) ? ignoredExperimentRequests : [];
  if (ignoredRequests.length) {
    const first = ignoredRequests[0] || {};
    return {
      decision: "deny",
      reason: "unanswered_experiment_request",
      unanswered_experiment_requests: ignoredRequests.length,
      unanswered_example: String(first.experiment || "").slice(0, 200),
      director_guidance:
        `Answer the ${ignoredRequests.length} experiment request(s) you have been shown and not `
        + "decided, in `experiment_request_decisions`: adopt or decline, with a reason either way. "
        + "Declining is a perfectly good answer and releases this immediately; silence is not, because it "
        + "is indistinguishable from not having read it.",
    };
  }

  // COMMIT LOCK (highest priority, evaluated before the best-so-far lookup so it
  // still holds when the strong lead has not yet accrued a ledger round). While a
  // strong-validated lead is inside its novelty commit window, deny the pivot even
  // if the binding blocker is novelty/impact — the director must consolidate/raise
  // this validated lead's novelty IN PLACE rather than abandon it for a fresh
  // unvalidated idea. Fail-closed against churn; bounded by COMMIT_NOVELTY_ROUNDS.
  // Evaluated before every hold, including the commit lock: no guard may require
  // refining a method that has been measured dead.
  if (validationDeclaresFalsification(leadValidationSummary)) {
    // MEASURED ON cycle-a-20260919, 2026-10-07: the current
    // support-boundary lead was validly falsified, but this branch labelled the
    // release with the cycle's historical best lead (hyp:bee8...). Directors
    // therefore kept upholding the current method while conclusion followups
    // and gate reviews churned. Bind a current-lead validation to the current
    // lead identity; fall back only for callers that have not supplied it yet.
    const currentRollup = currentLeadKey
      ? rollupByHypothesis(records, cycleId).get(String(currentLeadKey))
      : null;
    const lead = currentLeadKey
      ? currentRollup || {
        memory_id: String(currentLeadKey),
        statement: String(currentLeadStatement || proposedStatement || ""),
      }
      : bestSoFarLead(records, cycleId);
    // A falsification retires the METHOD. Releasing the hold without knowing
    // which question the replacement answers is what let 53 of 83 allowed pivots
    // through unexamined on cycle-g-v89 while the question moved underneath a
    // guard that only watched leads. The release still happens -- nobody is asked
    // to keep refining a method its own kill condition retired -- but it releases
    // the director to bring a different METHOD, and that requires saying to what.
    // Enforce whenever the caller looked. A call site that has not been wired
    // yet must still not deny every pivot -- that would halt the programme for MY
    // omission and look identical to a director refusing to answer, which is the
    // confusion this whole fix exists to end -- but a caller that DID look and
    // found no replacement has learned the director proposed none, and that is an
    // answer, not an omission.
    //
    // Measured before this changed: 335 of 365 allows were this rule, and the
    // check below fired zero times in 555 decisions, because every one of them
    // took the unwired branch.
    const questionCheck = proposedReplacement
      ? questionAccountability({
        proposedQuestion: proposedQuestion || proposedReplacement.research_problem_question,
        proposedMethodsTried: proposedMethodsTried || proposedReplacement.methods_tried,
        currentQuestion: currentQuestion || leadStatement(lead),
      })
      : replacementLookupPerformed
        ? {
          ok: false,
          reason: "falsification_pivot_states_no_replacement",
          evidence: { proposed_question: null, replacement_lookup_performed: true },
          guidance:
            "A completed run falsified this method, which releases the hold on the lead -- but "
            + "nothing in your result says what you are moving to, so whether the research question "
            + "survives the falsification cannot be determined. Emit `replacement_hypotheses` with "
            + "`research_problem_question` (verbatim if it is the same question, which is the normal "
            + "case after a falsification) and `methods_tried` listing what has already been tried "
            + "against it. A falsification retires the METHOD; the question survives it.",
        }
        : { ok: true, unwired: true };
    if (!questionCheck.ok) {
      return {
        decision: "deny",
        reason: questionCheck.reason,
        lead: lead?.memory_id || null,
        lead_statement: leadStatement(lead),
        falsification_released: true,
        ...questionCheck.evidence,
        director_guidance: questionCheck.guidance,
      };
    }
    return {
      decision: "allow",
      reason: "lead_falsified_by_completed_run",
      lead: lead?.memory_id || null,
      lead_statement: leadStatement(lead),
      churn_cost: lead?.memory_id ? churnCost(records, cycleId, lead.memory_id) : null,
      rounds_held: leadRoundsHeld(records, cycleId, lead?.memory_id),
    };
  }
  if (strongValidationCommit && strongValidationCommit.active === true) {
    const done = noveltyReviewRoundCount(records, cycleId, strongValidationCommit.leadKey);
    if (done < COMMIT_NOVELTY_ROUNDS) {
      return {
        decision: "deny",
        reason: strongValidationCommit.kind === "novelty_refinement"
          ? "novelty_refinement_window"
          : "strong_validation_commit_window",
        lead: strongValidationCommit.leadKey || null,
        churn_cost: churnCost(records, cycleId, strongValidationCommit.leadKey),
        lead_statement: leadStatement(
          rollupByHypothesis(records, cycleId).get(strongValidationCommit.leadKey),
        ),
        novelty_rounds_done: done,
        commit_novelty_rounds: COMMIT_NOVELTY_ROUNDS,
        validation_lane_id: strongValidationCommit.validationLaneId || null,
      };
    }
  }
  // A declined lead the director has since selected again is the current lead,
  // and is protected like any other.
  const lead = bestSoFarLead(records, cycleId, withoutLead(declinedResumes, currentLeadKey));
  if (!lead) {
    return { decision: "allow", reason: "no_active_lead_to_protect", lead: null };
  }
  // LEVEL-2 EXPLOIT MODE: budget is running out without convergence. Freeze
  // exploration entirely — neither a strictly-better candidate nor a stall may
  // displace the best lead; all remaining review budget consolidates it. This
  // intentionally accepts "we might hold a lead that cannot pass": with the
  // budget nearly spent, consolidating the best-known lead strictly dominates
  // starting a fresh unvalidated one (measured: every explore-to-the-wall cycle
  // v55-v59 died with NOTHING validated to the end). The watchdog's budget-wall
  // halt (90%) remains the backstop above this mode (70%).
  const activePolicy = policy || readWatchdogPolicy();
  if (activePolicy.mode === "exploit") {
    // Concentrate the remaining budget on the most NOVEL surviving lead rather
    // than the highest-composite one — see exploitFocusLead for why composite is
    // the wrong ranking at the wall.
    const focus = exploitFocusLead(records, cycleId) || lead;
    return {
      decision: "deny",
      reason: "budget_exploitation_mode_hold_most_novel_lead",
      lead: focus.memory_id,
      lead_statement: leadStatement(focus),
      focus_novelty: clampScore(focus.best_by_rubric?.novelty),
      displaced_composite_lead:
        focus.memory_id === lead.memory_id ? null : lead.memory_id,
      lead_best_composite: focus.best_composite,
      binding_rubric: focus.latest?.content?.binding_rubric || null,
      // The focused lead's weakest axis IS what the remaining runner budget must
      // buy (typically reproducibility on a novel-but-unvalidated lead).
      keep_refining: focus.latest?.content?.binding_rubric?.name || null,
      policy_reason: activePolicy.reason || null,
    };
  }
  // A genuinely BETTER *different* candidate is a natural promotion, not
  // suppression. CRITICAL: this must NOT fire for the lead against ITSELF — a
  // lead improving its own composite is exactly the case we must PROTECT. A
  // "different" candidate must (1) have a different key AND (2) not be a mere
  // PARAPHRASE of the current lead's statement — a reword desynchronizes the
  // statement-derived key from the lead's own key and would otherwise let the
  // improving lead promote against itself (adversarial finding). When the caller
  // gives no identity/statement we treat it as self/unknown and fall through to
  // the stall+deny protection (fail-safe).
  const keyDiffers =
    proposedHypothesisKey != null && String(proposedHypothesisKey) !== String(lead.memory_id);
  // A reword of the lead (symmetric paraphrase OR subject-continuity heavy reword)
  // desynchronizes the statement-derived key from the lead's own key on the null-id
  // path, but is NOT a different hypothesis — it is the SAME improving lead and must
  // stay protected, not promote against itself (adversarial finding).
  const paraphraseOfLead = isRewordOfLead(proposedStatement, lead.statement);
  const isDifferentCandidate = keyDiffers && !paraphraseOfLead;
  // "Strictly better" must be PER-RUBRIC, not mean-only: the gate is a per-rubric
  // bar, so a candidate with a higher MEAN but a worse WEAKEST (binding) rubric is
  // actually FARTHER from passing. Promoting toward it would abandon the closer
  // lead (adversarial mean-skew finding). Require the candidate's binding rubric to
  // be no worse than the lead's weakest best-so-far. FAIL-CLOSED: if the caller did
  // not supply the candidate's rubric we cannot verify per-rubric superiority, so
  // we do NOT promote (protect the lead).
  const leadBindingBest = Object.keys(lead.best_by_rubric || {}).length
    ? Math.min(...Object.values(lead.best_by_rubric))
    : -Infinity;
  const proposedBinding = proposedRubric ? bindingRubric(proposedRubric).score : null;
  const bindingNotWorse = proposedBinding != null && proposedBinding >= leadBindingBest;
  // The incumbent must have had a fair validation window before a strictly-better
  // DIFFERENT candidate may supersede it. Without this, the director proposes a
  // fresh "strictly better" candidate every few rounds and swaps the lead BEFORE
  // its runner validation lands, so soundness (technical_quality/reproducibility)
  // never compounds on ONE lead (observed on cycle-g-v60: 7 strictly-improves
  // supersessions, leads surviving ~3 rounds each, all rubrics oscillating instead
  // of climbing while the gatekeeper budget drained). A lead now gets stallRounds
  // rounds to prove itself; after that a genuinely better candidate may take over,
  // and a genuinely STALLED lead is still pivotable via the stall path below — so
  // this cannot deadlock. A too-young incumbent falls through to the improving-lead
  // deny (protected).
  const incumbentHadFairWindow = (lead.rounds || 0) >= stallRounds;
  if (
    isDifferentCandidate &&
    incumbentHadFairWindow &&
    proposedComposite != null &&
    Number(proposedComposite) > lead.best_composite + IMPROVEMENT_EPSILON &&
    bindingNotWorse
  ) {
    return {
      decision: "allow",
      reason: "candidate_strictly_improves_lead",
      lead: lead.memory_id,
      lead_best_composite: lead.best_composite,
      proposed_composite: Number(proposedComposite),
      proposed_binding: proposedBinding,
      lead_binding_best: leadBindingBest,
      proposed_hypothesis: String(proposedHypothesisKey),
      lead_rounds: lead.rounds,
    };
  }
  // The cycle's newest scored round, across ALL leads — the reference the
  // staleness check needs, since a dormant lead's own history stops growing.
  let currentRound = 0;
  for (const entry of rollupByHypothesis(records, cycleId).values()) {
    currentRound = Math.max(currentRound, Number(entry.last_round_index || 0));
  }
  // The lead has genuinely plateaued, or nobody has scored it in a long time.
  const stallKind = leadStallKind(lead, stallRounds, IMPROVEMENT_EPSILON, currentRound);
  // A stall is only meaningful once the lead has been READ more than once.
  //
  // MEASURED ON cycle-g-v89: 9 of its 21 leads were dropped after a single gate
  // round, and rounds_per_lead was 2.43 across 51 rounds. One scored round is one
  // reading, and one reading is not a trajectory to stall from -- the same mistake
  // the stagnation signature made about whole cycles (0a13f4c) one level down.
  //
  // This guards the two ALLOW branches only. Every existing deny keeps its own
  // reason: `still_improving` is what carries the anti-churn directive the
  // director reads, and replacing it here would strip the guidance from exactly
  // the leads that are young and improving.
  //
  // A falsified lead never reaches this point; it was released at the top.
  const roundsHeld = leadRoundsHeld(records, cycleId, lead.memory_id);
  if (
    (stallKind === "dormant" || stallKind === "plateau")
    && roundsHeld > 0
    && roundsHeld < MIN_LEAD_ROUNDS
  ) {
    return {
      decision: "deny",
      reason: "lead_held_fewer_rounds_than_floor",
      lead: lead.memory_id || null,
      lead_statement: leadStatement(lead),
      churn_cost: churnCost(records, cycleId, lead.memory_id),
      stall_kind: stallKind,
      rounds_held: roundsHeld,
      min_lead_rounds: MIN_LEAD_ROUNDS,
    };
  }
  if (stallKind === "dormant") {
    // Allowed, so nothing deadlocks - but the answer is "go back to it", not
    // "pick anything". See leadStallKind.
    //
    // Unless it was not abandoned. The falsification release above sees only the
    // CURRENT lead's newest validation, so once the cycle moves on, the guard
    // forgets that the best-so-far lead was retired by its own kill condition and
    // hands it back as "abandoned, not disproved". MEASURED ON cycle-g-v91:
    // hyp:4fafb0af6dd99ba4 was released 31 times by lead_falsified_by_completed_run
    // from 2026-09-13T10:52Z, then recommended for resumption 96 times into the
    // director prompts. The release is already in this log, so read it.
    const falsification = leadFalsificationRelease(records, cycleId, lead.memory_id);
    if (falsification) {
      return {
        decision: "allow",
        reason: "best_lead_falsified_pivot_permitted",
        lead: lead.memory_id,
        lead_statement: leadStatement(lead),
        falsified_at: falsification.first_released_at,
        falsification_releases: falsification.releases,
      };
    }
    return {
      decision: "allow",
      reason: "best_lead_dormant_resume_before_replacing",
      lead: lead.memory_id,
      binding_rubric: lead.latest?.content?.binding_rubric || null,
      rounds_without_improvement: (lead.binding_best_history || []).length,
      resume_lead: {
        memory_id: lead.memory_id,
        statement: lead.statement || lead.latest?.content?.statement || "",
        rounds: lead.rounds || 0,
        last_round_index: lead.last_round_index || 0,
        current_round: currentRound,
        best_by_rubric: lead.best_by_rubric || {},
        best_composite: Number.isFinite(lead.best_composite) ? lead.best_composite : null,
      },
    };
  }
  if (stallKind === "plateau") {
    return {
      decision: "allow",
      reason: "lead_stalled_pivot_permitted",
      lead: lead.memory_id,
      binding_rubric: lead.latest?.content?.binding_rubric || null,
      rounds_without_improvement: (lead.binding_best_history || []).length,
    };
  }
  // Otherwise: refining the lead is still making progress — do NOT suppress it.
  return {
    decision: "deny",
    reason: "critical_memory_suppression_blocked_lead_still_improving",
    lead: lead.memory_id,
    lead_statement: leadStatement(lead),
    churn_cost: churnCost(records, cycleId, lead.memory_id),
    lead_best_composite: lead.best_composite,
    binding_rubric: lead.latest?.content?.binding_rubric || null,
    keep_refining: lead.latest?.content?.binding_rubric?.name || null,
    rounds: lead.rounds,
  };
}

// Reconstruct WHY the current lead is the lead (ACM-CP reconstructability): the
// ordered chain of that hypothesis's rounds with binding-rubric trajectory.
function reconstructLead(records, cycleId) {
  const lead = bestSoFarLead(records, cycleId);
  if (!lead) return { lead: null, chain: [] };
  const admitted = records.filter(
    (r) => admitProgressRecord(r, cycleId) && r.memory_id === lead.memory_id,
  );
  const chain = admitted.map((r) => ({
    round: r.task_id,
    event_id: r.event_id,
    source_message_id: r.source_message_id,
    composite: r.content?.composite,
    binding_rubric: r.content?.binding_rubric,
    verdict: r.content?.verdict,
    audit_hash: r.audit_hash,
  }));
  return {
    lead: lead.memory_id,
    statement: lead.statement,
    best_composite: lead.best_composite,
    best_by_rubric: lead.best_by_rubric,
    rounds: lead.rounds,
    stalled: leadIsStalled(lead),
    chain,
    // The guard decisions that produced this lead are reconstructable from the
    // append-only event graph (ACM-CP causal-policy trace).
    decision_trail: readDecisionTrailFromRecords(records, cycleId),
  };
}

// Replay decision events out of an already-loaded record set (so reconstructLead
// works on in-memory logs in tests as well as on-disk).
function readDecisionTrailFromRecords(records, cycleId) {
  return (Array.isArray(records) ? records : []).filter((r) => isDecisionEvent(r, cycleId));
}

module.exports = {
  SCHEMA,
  isPlaceholderIdentity,
  STALL_ROUNDS,
  readWatchdogPolicy,
  COMMIT_NOVELTY_ROUNDS,
  SOUNDNESS_RUBRICS,
  DECISION_EVENT_TYPE,
  // pure
  canonical,
  clampScore,
  recordHash,
  validationIsStatisticallyStrong,
  noveltyReviewRoundCount,
  hypothesisKey,
  statementSignature,
  statementSimilarity,
  statementLeadCoverage,
  isRewordOfLead,
  declaredLeadIdentity,
  compositeScore,
  bindingRubric,
  decisionHash,
  isDecisionEvent,
  buildProgressRecord,
  admitProgressRecord,
  rollupByHypothesis,
  bestSoFarLead,
  exploitFocusLead,
  leadIsStalled,
  leadStallKind,
  churnCost,
  evaluateLeadSupersession,
  directorResumeDeclines,
  validationDeclaresFalsification,
  leadRoundsHeld,
  MIN_LEAD_ROUNDS,
  reconstructLead,
  readDecisionTrailFromRecords,
  // io
  progressLogPath,
  readProgressLog,
  appendProgressRecord,
  appendDecisionEvent,
  readDecisionTrail,
};
