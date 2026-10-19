# Incident catalog (measured diseases + verified fixes)

Reference for the on-halt reasoning responder (and humans). Every entry was
measured on a real cycle in 2026-07 and its fix verified end-to-end. When a halt
diagnosis matches an entry's signature, start from its root cause — but ALWAYS
verify against the actual state before applying anything (two past misdiagnoses
were caught only by checking real data first).

## How to use
1. Read the halt JSON (`state/<cycle>-watchdog-halt.json`): signature + evidence.
2. Find the matching genus below; verify its root cause hypothesis against live
   state (lanes/, state/, the progress ledger) BEFORE editing anything.
3. Fix the root cause (not the symptom), run the test gate, commit, then delete
   the halt file and relaunch.

## Genus: requery_storm (cycle-g-v58)
- **Symptom:** lab-director lanes explode (537) while gate rounds stay 0; heap
  relaunch churn; `current_lead_hypothesis` null.
- **Root cause:** the director SELECTED hypotheses but labelled every one
  "Future-cycle candidate only"/"not promoted", so the harness saw "no active
  lead" and re-dispatched `lab_director_requery_followup` unbounded. Prompt-side:
  STEP 4 narrowing loop had no termination and materializability raised the
  pre-commit bar.
- **Verified fix:** c2f7c16 — STEP 4 bounded (<=2 rounds), STEP 5 mandatory
  promotion of exactly one current-cycle lead. If a storm recurs DESPITE this,
  check whether the promotion actually reaches `current_lead_hypothesis`
  (binding boundary: lab_director_research_notes.js summarizeHypothesis).

## Genus: activity_without_gate_progress (cycle-g-v58 variant)
- **Symptom:** lanes complete steadily but zero gate rounds over a long window.
- **Check order:** (1) is a lead promoted? (2) do analyst handoffs exist and are
  they executable? (3) do runners run and reach the gate (materialization gate)?
  (4) do gatekeeper reviews aggregate (review starvation / dispatch priority)?
- **Known fixes in this genus:** gatekeeper dispatch priority (followup_priority
  rank), execution-based materialization gate, modality-aware quality standard
  (c187938: 92% auto-degraded chokepoint).

## Genus: budget_wall_without_convergence (v55, v56, v57, v59)
- **Symptom:** a review role's followups approach the exempt ceiling (192)
  without a gate pass.
- **Root causes seen (in order of discovery):**
  1. HARD churn: director abandons improving leads (fixed: ledger deny is
     authoritative — JS 43bcfd3/c8d12dc + Rust 8af8920).
  2. SOFT churn via stall: STALL_ROUNDS shorter than validation turnaround
     (fixed: ef12095 raise to 6; d610acc adaptive from measured latency).
  3. SOFT churn via strictly-better swaps before the incumbent's validation
     lands (fixed: e1548c7 fair-window guard).
- **If it recurs:** check the supersession ledger reason tally FIRST
  (`state/<cycle>-hypothesis-progress.jsonl`, lead_supersession_decision
  events) — the dominant reason names the leaking channel.

## Genus: budget_burn_without_soundness (cycle-g-v59)
- **Symptom:** heavy gatekeeper spend, best tech/repro never leaves the floor.
- **Root cause:** leads rotate before their runner evidence lands OR runner
  validations never reach the gate (materialization/prereq failures).
- **Check:** runner result.json `validation_summary.overall_status` distribution
  and `analyst_quality_standard.failed_requirements` (modality mismatch?), and
  whether recent runners target the CURRENT lead's hypothesis id.

## Genus: corpus/domain contamination (v44, v59)
- **Symptom:** gatekeeper novelty reasons say the literature set is off-topic
  for the objective's domain; or a bio family label (tumor_immune_resistance)
  appears on a non-bio lead.
- **Verified fixes:** domain-aware default_literature_sources (openalex/
  crossref/arxiv for non-bio; verified still correct), bio-family hardcode
  removal + non-bio-statement guard (ef12095: JS lab_director_research_notes.js
  + Rust lab_director_projection.rs).

## Genus: pre-gate placeholder confusion (recurring false alarm)
- **Symptom:** gate-review shows all-zero or reasonless 100 scores.
- **NOT A BUG in scoring:** transient aggregation snapshots. Live gate review
  converges to the minimum over per-lane evidence (fail-closed). Do NOT "fix"
  scoring based on these; check for `reasons` on each rubric item first.
  (A past misdiagnosis here nearly shipped a gate-blocking regression.)

## Hard invariants (NEVER change these to "fix" a halt)
- GATE_THRESHOLD=80 (owner decision 2026-10-12), soundness fail-closed.
- No score flooring/overriding of fresh independent gatekeeper reviews.
- Followup caps and the exempt multiplier (raising them caused node OOM).
- Governance: the director owns pivots; harness constrains and informs.
  Prompt-level guidance is fine; forcing scientific decisions in code is not.
- Audit artifacts (hypothesis-progress ledger, decision events) are append-only.
