#!/usr/bin/env node
"use strict";

// DABStep solver routing each task through the researchlab stage pipeline,
// mirroring the harness's evidence-stage role policy
// (src/policy/stage_policy.js: ["chronicle","scout","analyst","lab-runner"]):
//
//   LAB-DIRECTOR  decides complexity + decomposes the question into checks and
//                 lane needs (does this task need scout retrieval?), like
//                 agent_plan.js's complexity_score + lane assignment.
//   SCOUT         goal-conditioned retrieval over the LOCAL corpus: names the
//                 manual.md sections / reference files the analyst needs; the
//                 solver extracts them mechanically (real retrieval, not LLM
//                 memory) — the benchmark analog of scout/query_plan.js.
//   ANALYST       emits the harness handoff contract (handoff_checks[] +
//                 validation_code_blueprints[]) per src/agents/analyst/query_plan.js.
//   LAB-RUNNER    drivers/analysis/python_stats.py executes the blueprints;
//                 its report (validation summary + stdout/stderr) goes back to
//                 the analyst for resubmission, capped at --rounds.
//
// The answer is taken ONLY from an executed blueprint's stdout ("FINAL
// ANSWER:" line), never from LLM text.
//
//   node scripts/dev/solve_dabstep_pipeline.js --tasks <dev.jsonl> \
//        --context-dir <dir> --out <dir> [--sample N] [--effort medium] [--rounds 4]

const fs = require("fs");
const path = require("path");
const {
  codexText,
  extractJsonBlock,
  extractHandoff,
  runLabRunner,
  formatFeedback,
  contextDigest,
  extractManualSections,
  readJsonSample,
  sha16,
  auditEvent,
} = require("./dabstep_stage_lib");

function parseArgs(argv) {
  const a = { effort: "medium", planEffort: "low", sample: 0, rounds: 4, out: "evals/dabstep/_real/responses_pipeline" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--tasks") a.tasks = argv[++i];
    else if (argv[i] === "--context-dir") a.ctx = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
    else if (argv[i] === "--plan-effort") a.planEffort = argv[++i];
    else if (argv[i] === "--rounds") a.rounds = Number(argv[++i]);
  }
  return a;
}

// --- LAB-DIRECTOR lane -------------------------------------------------------
function directorPlan(t, digest, effort, dir) {
  const prompt = [
    "You are the LAB-DIRECTOR lane of the researchlab harness. You do not analyze data yourself: you assess the task, decompose it into validation checks, and assign lanes for the scout and analyst.",
    "",
    `Data context:\n${digest}`,
    "",
    `Question: ${t.question}`,
    `Answer guidelines: ${t.guidelines || ""}`,
    "",
    "Respond with ONLY one fenced ```json block:",
    "```",
    `{"complexity_score": <1-5>,`,
    ` "scout_goal": "<one line: what rules/definitions the scout must retrieve>",`,
    ` "definition_questions": ["<every question term whose meaning must come from the manual, e.g. 'metric M: a count or a ratio, over what denominator?', 'is concept C explicitly defined anywhere?'>"],`,
    ` "checks": [{"check_id": "<slug>", "goal": "<single decisive sub-question this check settles>"}],`,
    ` "degrees_of_freedom": {"variable": ["<the single attribute the question allows to change, with its value domain>"], "held_fixed": ["<every other attribute of each observed row, the entity, and the time window>"]},`,
    ` "strategy_note": "<one or two sentences for the analyst: pitfalls, computation order>"}`,
    "```",
    "Keep checks minimal: one check for simple aggregations; split multi-step fee/rule questions into the natural sub-steps (usually 2-3).",
    "IMPORTANT: you decompose, you do NOT define. Never commit to an interpretation of an ambiguous domain term (a count vs a ratio, which denominator, whether a concept is defined at all...) in checks or strategy_note — list each such term in definition_questions instead; the scout resolves them against the manual.",
    "degrees_of_freedom must be exact and applies ONLY to what-if/optimization questions (something is allowed to change): the changeable dimension goes in variable, everything else observed is held_fixed. For purely descriptive/aggregate questions (counts, averages, 'which rules apply') set BOTH lists empty — aggregating over the population the question names is not a change.",
  ].join("\n");
  const out = codexText(prompt, effort, dir, "director_prompt");
  const parsed = extractJsonBlock(out);
  if (parsed.error || !parsed.value || !Array.isArray(parsed.value.checks)) {
    return { complexity_score: 3, scout_goal: "retrieve the manual sections relevant to the question", definition_questions: [t.question], checks: [{ check_id: "main", goal: t.question }], strategy_note: "" };
  }
  if (!Array.isArray(parsed.value.definition_questions)) parsed.value.definition_questions = [];
  return parsed.value;
}

// --- SCOUT lane ---------------------------------------------------------------
function scoutRetrieve(t, plan, digest, ctx, effort, dir) {
  const prompt = [
    "You are the SCOUT lane of the researchlab harness doing goal-conditioned retrieval over a LOCAL corpus. You do not answer the question and you do not interpret ambiguous terms: you name what to retrieve; the harness extracts it mechanically.",
    "",
    `Data context:\n${digest}`,
    "",
    `Question (the primary retrieval target — retrieve for the question itself, not only the director's framing): ${t.question}`,
    `Retrieval goal from the lab-director: ${plan.scout_goal || ""}`,
    `Open definition questions you MUST cover (for EACH one, include the manual section that contains its governing definition, if any): ${JSON.stringify(plan.definition_questions || [])}`,
    `Planned checks: ${JSON.stringify(plan.checks)}`,
    "",
    "Respond with ONLY one fenced ```json block:",
    "```",
    `{"manual_sections": ["<exact section titles from the manual.md sections list above that contain the needed rules/definitions — at least one per definition question when the manual covers it>"],`,
    ` "reference_samples": ["<filenames among the .json reference files whose structure the analyst must see, e.g. fees.json>"],`,
    ` "retrieval_note": "<one line: what the analyst should look for in the retrieved text; note any definition question the manual does NOT cover>"}`,
    "```",
  ].join("\n");
  const out = codexText(prompt, effort, dir, "scout_prompt");
  const parsed = extractJsonBlock(out);
  const spec = parsed.value && typeof parsed.value === "object" ? parsed.value : {};
  const sections = Array.isArray(spec.manual_sections) ? spec.manual_sections : [];
  const samples = Array.isArray(spec.reference_samples) ? spec.reference_samples : [];
  const parts = [];
  const manualText = extractManualSections(path.join(ctx, "manual.md"), sections, 12000);
  if (manualText) parts.push(`--- Retrieved manual.md sections (${sections.join("; ")}) ---\n${manualText}`);
  for (const f of samples.slice(0, 3)) {
    const p = path.join(ctx, path.basename(String(f)));
    if (p.endsWith(".json") && fs.existsSync(p)) {
      parts.push(`--- Sample of ${path.basename(p)} ---\n${readJsonSample(p, 2)}`);
    }
  }
  if (spec.retrieval_note) parts.push(`Scout note: ${spec.retrieval_note}`);
  const digestText = parts.join("\n\n");
  fs.writeFileSync(path.join(dir, "scout_digest.md"), digestText);
  return digestText;
}

// --- ANALYST lane -------------------------------------------------------------
function buildAnalystPrompt(t, digest, plan, scoutDigest, round, feedback) {
  const checkList = plan.checks.map((c) => `{"check_id": "${c.check_id}", "outcome": "${c.goal.replace(/"/g, "'")}", "success_criteria": {"description": "prints the facts this check establishes"}}`);
  const base = [
    `Active message binding: task ${t.task_id}, round ${round}. Everything below applies to this task/round only; ignore any other task you may have seen.`,
    "You are the ANALYST lane of the researchlab harness. You do not run code yourself: you emit a structured handoff and the lab-runner validation driver executes your blueprints against the real data, then reports results back to you for revision.",
    "",
    "Emit a handoff as ONE fenced ```json block with exactly this shape:",
    "```",
    `{"summary": "<one line>",`,
    ` "handoff_checks": [${checkList.join(", ")}],`,
    ` "validation_code_blueprints": [{"blueprint_id": "bp-<check_id>", "check_id": "<check_id>", "language": "python", "code": "@python-block"}]}`,
    "```",
    'Then append one fenced ```python block per blueprint, in the same order ("@python-block" binds them positionally). You may merge all checks into ONE blueprint/script when that is simpler — then emit one combined check_id.',
    "",
    "Blueprint code rules (the lab-runner executes it verbatim):",
    "- Read the data directory from the environment variable RESEARCHLAB_CSV_ROOT (the driver also passes --csv-root/--output-dir/--check-file argv; ignore argv).",
    "- Use pandas/json/re. Print intermediate facts you will want to see in the execution report.",
    "- NEVER print a guessed or hardcoded answer: the final answer must be computed from the loaded data. Parse domain rules from manual.md / fees.json in the data directory when needed.",
    "- manual.md is the source of truth for domain definitions. When a question term is ambiguous (e.g. a 'top X by Y' that could be a count or a ratio), use the manual's definition (see the scout retrieval below) and print the passage you relied on.",
    "- PRECEDENCE: the manual's definitions outrank the lab-director's strategy note. If the strategy note's interpretation conflicts with a retrieved manual definition, follow the manual and print both the passage and a line noting the conflict.",
    "- If the question depends on a concept the manual and data do NOT define (no applicable rule exists), do not invent a proxy: when the guidelines allow it, the computed conclusion should be FINAL ANSWER: Not Applicable.",
    "- Retrieved sections being topically related does NOT mean the question's concept is defined. Before computing, verify the EXACT concept the question hinges on (a specific named rule, threshold, or metric) is explicitly defined in the manual text; if only adjacent concepts are defined, that is 'not defined' and the Not Applicable rule above applies.",
    "- Never round intermediate values; carry full float precision through the computation and round ONLY the final printed answer to exactly the precision the guidelines demand.",
    "- NO-CONSTRAINT PRINCIPLE: in rule/filter tables, a field with no constraint content — null, an empty list [], an empty string — expresses no constraint and therefore matches ALL values, exactly like the manual's explicit null rule (absence of a constraint is not a constraint). Apply this consistently. When the manual is explicitly silent on such a semantic choice, compute BOTH interpretations, print both results labelled, and adopt the no-constraint reading; if the two differ, say so in the printout.",
    "- RANGE-ENCODED FIELDS: rule fields that encode comparisons or ranges as strings ('<3', '>5', '3-5', 'immediate', 'manual', '100k-1m', '7.7%-8.3%') must be PARSED and evaluated against the entity's value (numeric comparison for numbers, unit suffixes like k/m expanded, percent ranges as ratios); never compare a range string to a value by equality. Print, for at least two rules with range fields, the parsed constraint and the entity value used.",
    "- VALIDATED MATCHER: the data directory contains dabstep_helpers.py, a vetted implementation of the manual's rule-matching semantics (no-constraint fields, range parsing, monthly natural-month metrics, the fee formula). Import it (sys.path.insert(0, os.environ['RESEARCHLAB_CSV_ROOT'])) and use match_fee_rule / fee_amount / month_context / load_fees / load_merchant for ALL rule matching instead of reimplementing — reimplemented matchers have repeatedly diverged. Print the matched-rule counts it returns.",
    "- DOMAIN-FAITHFUL ARITHMETIC: when aggregating over OBSERVED transactions, compute charged quantities the way the domain charges them — per transaction (fee per row, then aggregate), as a straightforward pandas implementation would; do NOT algebraically refactor (e.g. rate * total_volume) even when mathematically equivalent, and print the unrounded aggregate before the rounded answer. For hypothetical 'what would X be' questions, compute over the set the question actually quantifies (e.g. the fee RULES applicable to the stated profile), not over observed rows.",
    "- VECTORIZE: implement per-row quantities as vectorized pandas column arithmetic and aggregate with Series.sum() — never Python-level row loops with running accumulators. At double precision the canonical vectorized operation order IS part of the expected answer for high-precision (>=10 decimal) questions; for such questions compute totals per scenario and subtract the totals (also print the per-row-delta variant for comparison).",
    "- Not Applicable is ONLY for concepts the manual genuinely does not define. It is NEVER the answer to a computational difficulty — rules that fail to match, coverage gaps, empty intermediate results all mean your matching semantics are wrong (recheck the no-constraint principle and your filters) and you must fix the computation, not punt to Not Applicable.",
    "- DEGREES OF FREEDOM: when (and only when) the lab-director's degrees_of_freedom contract has a non-empty variable list, vary ONLY that dimension over its value domain; every held_fixed dimension keeps its observed per-row value, and the final answer's entity must be a value of the variable dimension. When variable is empty (descriptive question), this contract imposes NOTHING: averaging/counting over the rule set or population the question itself names is the intended computation, never a violation.",
    "- When (and only when) the computed answer is ready, make the script's LAST printed line exactly: FINAL ANSWER: <answer formatted per the guidelines>",
    "- If you still need to inspect data first, print what you need and end stdout with the line CONTINUE; the lab-runner report will show you the output for your next handoff.",
    "",
    `Data context:\n${digest}`,
  ];
  if (plan.strategy_note) base.push("", `Lab-director strategy note: ${plan.strategy_note}`);
  if (plan.degrees_of_freedom) base.push("", `Lab-director degrees_of_freedom contract: ${JSON.stringify(plan.degrees_of_freedom)}`);
  if (scoutDigest) base.push("", `Scout retrieval:\n${scoutDigest}`);
  base.push("", `Question: ${t.question}`, `Answer guidelines: ${t.guidelines || ""}`);
  if (round > 0 && feedback) {
    base.push("", `--- Lab-runner report for your previous handoff (round ${round}) ---`, feedback, "Submit a revised handoff accordingly.");
  }
  base.push("", "Respond with the fenced ```json handoff block, then the fenced ```python block(s). Nothing else.");
  return base.join("\n");
}

// --- GATEKEEPER lane ------------------------------------------------------------
// Mirrors the harness gate stage: reviews the executed evidence against the
// question/guidelines and either passes the claim or returns blockers that send
// the analyst back for another round (gate_restart_followup).
function gatekeeperReview(t, scoutDigest, result, answer, effort, dir, plan) {
  const evidence = (result.observations || []).map((o) => `check ${o.check} stdout (tail):\n${o.stdout}`).join("\n\n").slice(0, 9000);
  const prompt = [
    "You are the GATEKEEPER lane of the researchlab harness. Review the executed validation evidence and the proposed answer. You do not compute new answers; you affirm or reject.",
    "",
    `Question: ${t.question}`,
    `Answer guidelines: ${t.guidelines || ""}`,
    plan && plan.degrees_of_freedom ? `Degrees-of-freedom contract: ${JSON.stringify(plan.degrees_of_freedom)}` : "",
    scoutDigest ? `Scout retrieval (domain definitions):\n${scoutDigest.slice(0, 5000)}` : "",
    "",
    `--- Executed evidence (lab-runner stdout) ---\n${evidence}`,
    "",
    `Proposed answer: ${answer}`,
    "",
    "Gate criteria:",
    "1. The answer is derived from the executed computation shown in the evidence (not asserted without support).",
    "2. The computation uses the manual's definitions for every domain term (if the manual defines a metric one way, any other reading fails this criterion). If the question depends on a concept the manual/data never explicitly define — topically adjacent sections do not count as a definition — the correct answer is 'Not Applicable' (when the guidelines allow it), not a proxy.",
    "3. The answer's TYPE and FORMAT follow the guidelines exactly (option letter form, list form, decimals, units, the kind of entity asked for).",
    "4. No contradiction between the evidence and the answer.",
    "5. Degrees of freedom respected — ONLY when the contract's variable list is non-empty: the computation varied only that dimension and the answer names a value from its domain. When variable is empty, this criterion is automatically satisfied; do NOT reject descriptive aggregates over the question's own population as violations.",
    "6. Rule/filter matching honoured the no-constraint principle: fields with no constraint content (null / empty list / empty string) match all values; a computation that silently dropped such rules fails this criterion.",
    "7. A 'Not Applicable' answer is only valid when the evidence shows the asked concept is genuinely undefined in the manual; if the evidence shows it arose from matching gaps, empty intermediates, or other computational difficulties, REJECT and tell the analyst to fix the matching semantics.",
    "",
    "Respond with ONLY one fenced ```json block:",
    "```",
    `{"gate_passed": <bool>, "blockers": ["<each concrete violated criterion, empty if passed>"], "revision_note": "<one or two sentences telling the analyst what to fix; empty if passed>"}`,
    "```",
  ].filter(Boolean).join("\n");
  // Fail CLOSED: an unparseable gate verdict is a denial with a reason code,
  // never a silent admission (an unaudited pass is exactly the
  // communication-memory-mismatch failure the gate exists to prevent).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = codexText(prompt, effort, dir, attempt ? "gatekeeper_prompt_retry" : "gatekeeper_prompt");
    const parsed = extractJsonBlock(out);
    if (!parsed.error && parsed.value && typeof parsed.value.gate_passed === "boolean") {
      return parsed.value;
    }
  }
  return { gate_passed: false, blockers: ["gate_unparseable"], revision_note: "gatekeeper verdict was unparseable twice; resubmit the handoff with clearer printed evidence" };
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.tasks || !a.ctx) {
    console.error("usage: solve_dabstep_pipeline.js --tasks <dev.jsonl> --context-dir <dir> --out <dir> [--sample N] [--effort medium] [--rounds 4]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  // Skills layer: place the vetted rule-matching helper module next to the data
  // so every blueprint can import it instead of reimplementing the semantics.
  fs.copyFileSync(path.join(__dirname, "dabstep_helpers.py"), path.join(a.ctx, "dabstep_helpers.py"));
  let rows = fs.readFileSync(a.tasks, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (a.sample) rows = rows.slice(0, a.sample);
  const digest = contextDigest(a.ctx);
  console.log(`solving ${rows.length} DABStep tasks via lab-director->scout->analyst->lab-runner (effort=${a.effort}, rounds<=${a.rounds})`);

  let done = 0;
  for (const t of rows) {
    const respPath = path.join(a.out, `${t.task_id}.json`);
    if (fs.existsSync(respPath)) {
      done += 1;
      continue;
    }
    const taskDir = path.join(a.out, `work_${t.task_id}`);
    const t0 = Date.now();

    // 1) lab-director: complexity + check decomposition + lane needs
    const plan = directorPlan(t, digest, a.planEffort, taskDir);
    fs.writeFileSync(path.join(taskDir, "director_plan.json"), JSON.stringify(plan, null, 2));
    auditEvent(taskDir, "director_plan", { task_id: t.task_id, plan_sha: sha16(JSON.stringify(plan)), complexity: plan.complexity_score, checks: plan.checks.map((c) => c.check_id) });

    // 2) scout: goal-conditioned retrieval over the local corpus. Always runs —
    // the analyst contract's canonical_resolution_target is 1.0: every domain
    // term must resolve against a governed definition, never an LLM guess.
    const scoutDigest = scoutRetrieve(t, plan, digest, a.ctx, a.planEffort, taskDir);
    auditEvent(taskDir, "scout_retrieval", { task_id: t.task_id, digest_sha: sha16(scoutDigest), bytes: scoutDigest.length });

    // 3+4+5) analyst handoff -> lab-runner execution -> gatekeeper review, with
    // resubmission rounds (failed gate = gate_restart_followup back to analyst)
    let answer = "";
    let provenance = null;
    let feedback = null;
    let roundsUsed = 0;
    let gated = false;
    for (let r = 0; r < a.rounds; r += 1) {
      roundsUsed = r + 1;
      const roundDir = path.join(taskDir, `round_${r}`);
      fs.mkdirSync(roundDir, { recursive: true });
      const analystOut = codexText(buildAnalystPrompt(t, digest, plan, scoutDigest, r, feedback), a.effort, roundDir, "analyst_prompt");
      const extracted = extractHandoff(analystOut);
      auditEvent(taskDir, "analyst_handoff", { task_id: t.task_id, round: r, ok: !extracted.error, error: extracted.error || null, handoff_sha: extracted.handoff ? sha16(JSON.stringify(extracted.handoff)) : null });
      if (extracted.error) {
        feedback = formatFeedback(extracted);
        continue;
      }
      const result = runLabRunner(extracted.handoff, a.ctx, roundDir);
      auditEvent(taskDir, "lab_runner_execution", {
        task_id: t.task_id,
        round: r,
        admitted: result.admitted || null,
        denial: result.denial || null,
        candidates: (result.candidates || []).length,
        driver_error: Boolean(result.driverError),
      });
      feedback = formatFeedback(result);
      if (!result.answer || /^continue$/i.test(result.answer)) continue;
      const gate = gatekeeperReview(t, scoutDigest, result, result.answer, a.planEffort, roundDir, plan);
      fs.writeFileSync(path.join(roundDir, "gate_review.json"), JSON.stringify(gate, null, 2));
      auditEvent(taskDir, "gate_review", { task_id: t.task_id, round: r, answer: result.answer, gate_passed: gate.gate_passed, blockers: gate.blockers || [] });
      // The exported answer is always the latest provenance-bound admitted one;
      // gate_passed records whether the gatekeeper affirmed it.
      answer = result.answer;
      provenance = { round: r, ...result.admitted };
      if (gate.gate_passed) {
        gated = true;
        break;
      }
      feedback = `${feedback}\n\n--- Gatekeeper REJECTED the answer "${result.answer}" ---\nblockers: ${JSON.stringify(gate.blockers)}\n${gate.revision_note || ""}`;
    }
    fs.writeFileSync(
      respPath,
      JSON.stringify({ task_id: t.task_id, answer, rounds: roundsUsed, complexity: plan.complexity_score, gate_passed: gated, provenance }, null, 2) + "\n",
    );
    auditEvent(taskDir, "final_answer", { task_id: t.task_id, answer, gate_passed: gated, provenance });
    done += 1;
    console.log(`[${done}/${rows.length}] ${t.task_id} (${t.level}) ${Math.round((Date.now() - t0) / 1000)}s cx=${plan.complexity_score} rounds=${roundsUsed} gate=${gated ? "pass" : "no"} -> ${answer.slice(0, 60) || "(no answer)"}`);
  }
  console.log(`wrote responses -> ${a.out}`);
}

main();
