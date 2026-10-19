"use strict";

// A Scout is a small research agent, not a keyword launcher.  This module keeps
// its mission durable in role-plan.json and makes the journal it returns
// checkable without turning a number of retrieved papers into a proxy for
// coverage.

const { inferTopicTerms } = require("../shared/topic_terms");
const { filterScreenedEvidence } = require("../../policy/literature_screening");

const SEARCH_AGENT_JOURNAL_SCHEMA = Object.freeze({
  version: "adaptive-search-agent-journal-v1",
  required_fields: ["research_problem", "search_rounds", "coverage", "synthesis"],
  round_required_fields: ["round_id", "inquiry_intent", "question", "reason", "query", "source", "parent_paper_ids", "result_ids", "reading_decisions", "evidence_accepted_ids"],
  completion_required_fields: ["coverage.unanswered_questions", "synthesis.next_search_decisions", "synthesis.saturation.termination_reason"],
});

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  return value == null || value === "" ? [] : [value];
}

function text(value, max = 900) {
  if (value && typeof value === "object") return "";
  const valueText = String(value || "").replace(/\s+/g, " ").trim();
  return valueText.length > max ? valueText.slice(0, max).trimEnd() : valueText;
}

// The same problem, compared on its letters and digits. A verbatim copy written
// through Windows PowerShell 5.1 loses non-ASCII punctuation -- the em dash in
// cycle-b-20260917g's objective came back as "??" -- and that is encoding
// damage, not a different research problem.
function problemKey(value) {
  return text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function unique(values) {
  const seen = new Set();
  return asArray(values).map((value) => text(value)).filter((value) => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function paperIdentityKeys(value) {
  const raw = text(value, 300).toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "doi:");
  if (!raw) return [];
  const keys = new Set([raw]);
  const arxiv = raw.match(/(?:arxiv:|arxiv\.org\/abs\/|doi:10\.48550\/arxiv\.)(\d{4}\.\d{4,5})(?:v\d+)?$/);
  if (arxiv) keys.add(`arxiv:${arxiv[1]}`);
  return [...keys];
}

function samePaperIdentity(left, right) {
  const rightKeys = new Set(paperIdentityKeys(right));
  return paperIdentityKeys(left).some((key) => rightKeys.has(key));
}

function hypothesisId(item, index) {
  return text(item?.hypothesis_id || item?.id || item?.candidate_id || item?.claim_id || `hypothesis-${index + 1}`, 120);
}

function hypothesisStatement(item) {
  return text(typeof item === "string" ? item : item?.statement || item?.hypothesis || item?.claim || item?.research_question, 1200);
}

function collectHypotheses(context, prompt) {
  const sources = [
    context?.hypothesis_candidates,
    context?.derivable_hypothesis_candidates,
    context?.focus_hypotheses,
    context?.hypotheses,
    context?.current_lead_hypothesis,
    context?.lab_director_research_notes?.current_lead_hypothesis,
    context?.researcher_view?.derivable_hypothesis_candidates,
    context?.researcher_view?.focus_hypotheses,
    context?.researcher_view?.summary?.focus_hypotheses,
    context?.literature_summary?.hypothesis_candidates,
  ];
  const result = [];
  const seen = new Set();
  for (const source of sources) {
    for (const item of asArray(source)) {
      const statement = hypothesisStatement(item);
      if (!statement) continue;
      const id = hypothesisId(item, result.length);
      const key = `${id}|${statement}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        hypothesis_id: id,
        statement,
        research_problem: text(item?.research_problem_question || item?.answers_research_problem || "", 900) || null,
        status: text(item?.status || item?.latest_status || "candidate", 80),
      });
    }
  }
  // A new cycle can legitimately have no candidate yet.  The objective is then
  // the only provisional hypothesis target; this remains explicitly pending.
  if (!result.length && text(prompt)) {
    result.push({ hypothesis_id: "objective-under-specification", statement: text(prompt, 1200), research_problem: null, status: "pending_problem_formulation" });
  }
  return result.slice(0, 8);
}

function collectResearchProblem(context, prompt, hypotheses) {
  const candidates = [
    context?.research_problem,
    context?.research_problem_question,
    context?.current_research_problem,
    context?.lab_director_research_notes?.research_problem,
    context?.researcher_view?.research_problem,
    ...hypotheses.map((item) => item.research_problem),
  ];
  for (const candidate of candidates) {
    const resolved = candidate && typeof candidate === "object"
      ? candidate.statement || candidate.question || candidate.research_problem_question || candidate.description || candidate.text
      : candidate;
    if (text(resolved)) return { text: text(resolved, 1400), source: "planning_context" };
  }
  return { text: text(prompt, 1400), source: "objective_text" };
}

function explicitScopes(context) {
  const raw = context?.research_scopes || context?.research_scope || context?.search_scopes || [];
  return unique(asArray(raw).map((item) => typeof item === "string" ? item : item?.facet || item?.name || item?.label || item?.scope));
}

function robotObjectiveFacets(prompt) {
  const normalized = String(prompt || "").toLowerCase();
  const robotSignal = /\brobot|\bshared autonomy|\bteleoperation|\bmanipulat|\bhuman[- ]robot/.test(normalized);
  if (!robotSignal) return [];
  const facets = ["human-computer interaction", "robot control"];
  if (/\bllm|\blanguage model|\bclarification|\bdialog/.test(normalized)) facets.push("LLM-mediated interaction");
  if (/\bvla|vision[- ]language[- ]action|\bvision[- ]language/.test(normalized)) facets.push("vision-language-action");
  return facets;
}

function deriveFieldFacets({ prompt, cyclePlanningContext, hypotheses }) {
  const scopes = explicitScopes(cyclePlanningContext);
  const values = scopes.length ? scopes : robotObjectiveFacets(prompt);
  // Prompt-derived facets are intentional only for an explicitly robot-centred
  // objective.  Other fields stay pending until their planning context names a
  // scope, avoiding a global HCI/robot template.
  const resolvedValues = values.length ? values : ["objective-specific field scope"];
  return resolvedValues.map((label, index) => ({
    facet_id: `field-${index + 1}`,
    label,
    status: values.length ? "pending_evidence" : "pending_scope_definition",
    hypothesis_ids: hypotheses.map((hypothesis) => hypothesis.hypothesis_id),
  }));
}

function buildSearchAgentContract({ prompt, laneId, cycleId = null, cyclePlanningContext = null }) {
  const hypotheses = collectHypotheses(cyclePlanningContext, prompt);
  const fieldFacets = deriveFieldFacets({ prompt, cyclePlanningContext, hypotheses });
  const { text: researchProblem, source: researchProblemSource } = collectResearchProblem(cyclePlanningContext, prompt, hypotheses);
  const scopeTerms = unique(fieldFacets.map((facet) => facet.label).concat(inferTopicTerms(researchProblem).slice(0, 6)));
  return {
    contract_version: "adaptive-search-agent-v1",
    agent_kind: "hypothesis_conditioned_literature_agent",
    lane_id: laneId,
    cycle_id: cycleId,
    research_problem: researchProblem,
    // "objective_text" when no question has been formulated yet and this is the
    // raw objective. The scout then states the question it searches; a verbatim
    // copy of a long objective is neither practical nor a research problem.
    research_problem_source: researchProblemSource,
    hypotheses,
    required_field_facets: fieldFacets,
    scope_terms: scopeTerms,
    search_rounds: [],
    journal_schema: SEARCH_AGENT_JOURNAL_SCHEMA,
    round_schema: {
      required_fields: SEARCH_AGENT_JOURNAL_SCHEMA.round_required_fields,
      allowed_inquiry_intents: ["hypothesis_direct", "closest_prior_art", "backward_citation", "forward_citation", "adversarial", "cross_field_bridge"],
      reading_decision_schema: ["paper_id", "abstract_read_in_full", "decision", "hypothesis_ids", "facet_ids", "reason"],
      cross_field_bridge_schema: ["classification", "applicability_reason", "changed_execution_element"],
      rule: "A result is a candidate only. An accepted evidence id must have a reading decision with abstract_read_in_full=true and decision=directly_relevant.",
    },
    required_inquiry_intents: ["hypothesis_direct", "closest_prior_art", "backward_citation", "forward_citation", "adversarial"],
    source_diversity_policy: {
      requirement: "Use sources appropriate to the field and record the source used for each inquiry. Do not infer diversity or coverage from result counts.",
      minimum_distinct_source_types: 2,
      examples: ["scholarly index", "publisher or proceedings record", "citation graph or reference list", "field repository"],
    },
    cross_field_bridge_policy: {
      requirement: "A bridge is applicable only when it changes the executed method, analysis design, experiment/data construction, or measured quantity for a named hypothesis.",
      classify_as: ["direct_evidence", "method_transfer", "inapplicable"],
      inapplicable_rule: "Record irrelevant bridges as excluded; they cannot satisfy a field facet or coverage gap.",
    },
    coverage_policy: {
      required_facet_evidence: "Every required field facet remains pending until an accepted full-abstract evidence id is linked to that facet and a named hypothesis.",
      saturation: "Saturation is a qualitative decision: state which decision-critical gap stopped changing after genuinely different inquiries. Counts alone never establish saturation.",
      no_fixed_paper_minimum: true,
      no_count_based_coverage: true,
    },
    outputs: {
      journal_path: `search-agent-journal.json`,
      synthesis_path: `search-agent-synthesis.json`,
      synthesis_required_fields: ["claim_paper_links", "closest_prior_art", "next_search_decisions", "coverage_gaps", "saturation"],
    },
    completion_policy: {
      forbid_self_claimed_complete_when: ["search_rounds_empty", "required_field_facet_missing_evidence", "accepted_evidence_unread", "required_inquiry_intent_missing"],
      pending_is_not_evidence: true,
    },
  };
}

function buildSearchAgentFollowupInstructions({ cycleId, laneId }) {
  const laneDir = `.research-lab/lanes/${cycleId || "<cycle_id>"}/${laneId}`;
  return [
    "SEARCH-AGENT CONTRACT — act as an adaptive research agent. Start from search_agent_contract.research_problem, hypotheses, and required_field_facets. Each inquiry must answer a decision-relevant question about a named hypothesis; rewrite the next inquiry after reading the results. Do not execute a fixed keyword list as if it were a search plan.",
    // Two rules the journal validator enforces and this text never stated. On
    // cycle-b-20260917e every fresh scout, with working network, wrote its own
    // restatement of the problem and a list of providers per round, and ended
    // insufficient_corpus on journal_research_problem_mismatch and
    // round_N_source_not_scalar however much it had actually read.
    "JOURNAL FORMAT (validated): search-agent-journal.json research_problem must be search_agent_contract.research_problem copied verbatim, unless search_agent_contract.research_problem_source is objective_text: then research_problem is the ONE question this search answers, stated in a sentence. Put any narrower working question in a separate working_question field. Each round's source is ONE string naming one source; a query sent to several indexes is one round per index. A backward_citation or forward_citation round's source must name the citation or reference source it used (for example \"opencitations citation graph\").",
    `Maintain ${laneDir}/search-agent-journal.json throughout the work. Each search_round must include inquiry_intent, question, reason, query, source, parent_paper_ids, result_ids, reading_decisions, and evidence_accepted_ids. Run direct hypothesis and closest-prior-art inquiries, then backward and forward citation inquiries from a relevant parent paper, plus an adversarial inquiry designed to refute the lead. Record a cross-field bridge only when it is direct evidence or changes the method/analysis/experiment/measurement; otherwise mark it inapplicable and excluded.`,
    "Read every candidate's FULL abstract before accepting it. A missing abstract, uncertain reading, or irrelevant bridge is pending/excluded, never evidence. Preserve the existing screening and quality policy: only accepted screened papers may support claims.",
    "Inspect each durable inquiry's new_candidate_ids, changed_abstract_ids and newly_accepted_ids. Reuse unchanged abstract reviews under the same objective. If an inquiry adds no material evidence, explain which unresolved decision justifies a different query or citation/source strategy; do not repeat an unchanged query or count duplicate hits as progress. Provider failures remain retrieval failures, never proof that prior art is absent.",
    "Use at least two appropriate source types when they are reachable, but never call coverage complete from a source or paper count. Keep missing facets as pending, name the gap, and choose the next inquiry that could close it. Do not claim completeness with empty rounds or an unfilled facet.",
    `Before final response, write ${laneDir}/search-agent-synthesis.json with claim_paper_links (claim/hypothesis -> accepted paper IDs), closest_prior_art, coverage_gaps, saturation reasoning, and next_search_decisions. Validate the journal against role-plan.json.search_agent_contract; return insufficient_corpus when the contract remains incomplete.`,
  ].join("\n");
}

function normalizeJournal(value) {
  return value?.search_agent_journal && typeof value.search_agent_journal === "object" ? value.search_agent_journal : value || {};
}

// What an open question or coverage gap is, and whether a literature search
// can still close it.
//
// MEASURED ON cycle-a-20260919, 2026-10-07: of 86 literature-search
// restarts and 117 resumes, almost none ever completed. Once 6fb77c3 gave
// them the time, they still ended "search_not_completed": followup-scout-278
// and -279 held 50 accepted, fully reviewed papers each and every required
// inquiry intent, and stopped in 3-9 minutes because their open questions
// were ones no search can close -- "will 96x96 OSMesa rendering preserve
// enough texture signal for frozen features to differ" (an experiment),
// "can the local MuJoCo assets expose appearance factors" (this host), and
// "no screened evidence establishes a tangent-versus-normal comparison" (the
// novelty finding itself). The more novel the question, the more of these an
// honest scout records, and every one of them blocked completion. Each failed
// scout then opened a blocking-recovery director lane.
//
// An item is a string (a literature question, as before) or an object
// {question | gap, kind, reason, searched_in_round_ids}. Only `literature`
// items block completion. `experiment` and `host_capability` items name what
// will answer them instead (`reason`); `literature_exhausted` items name at
// least OPEN_ITEM_EXHAUSTED_MIN_ROUNDS journal rounds that looked and found
// nothing, so "the literature has no answer" is a finding with its searches
// behind it, not a way to stop early. The deferred items go to the director.
const OPEN_ITEM_KINDS = Object.freeze(["literature", "experiment", "host_capability", "literature_exhausted"]);
const OPEN_ITEM_EXHAUSTED_MIN_ROUNDS = 2;

function classifyOpenItems(items, roundIds, label) {
  const blocking = [];
  const deferred = [];
  const errors = [];
  for (const [index, item] of asArray(items).entries()) {
    if (typeof item === "string") {
      if (text(item)) blocking.push({ question: text(item), kind: "literature" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const question = text(item.question || item.gap || item.text);
    if (!question) {
      errors.push(`${label}_unreadable:${index + 1}`);
      continue;
    }
    const kind = text(item.kind, 40).toLowerCase() || "literature";
    if (!OPEN_ITEM_KINDS.includes(kind) || kind === "literature") {
      blocking.push({ question, kind: "literature" });
      continue;
    }
    if (kind === "literature_exhausted") {
      const searched = unique(asArray(item.searched_in_round_ids).map((id) => text(id, 160)))
        .filter((id) => roundIds.has(id));
      if (searched.length < OPEN_ITEM_EXHAUSTED_MIN_ROUNDS) {
        errors.push(`${label}_exhausted_without_searches:${index + 1}`);
        blocking.push({ question, kind: "literature" });
        continue;
      }
      deferred.push({ question, kind, searched_in_round_ids: searched, reason: text(item.reason) || null, from: label });
      continue;
    }
    const reason = text(item.reason);
    if (!reason) {
      errors.push(`${label}_${kind}_without_reason:${index + 1}`);
      blocking.push({ question, kind: "literature" });
      continue;
    }
    deferred.push({ question, kind, reason, from: label });
  }
  return { blocking, deferred, errors };
}

function validateSearchJournal(value, { contract = null, acceptedPaperIds = null } = {}) {
  const journal = normalizeJournal(value);
  const activeContract = contract || journal.search_agent_contract || {};
  const errors = [];
  const rounds = asArray(journal.search_rounds);
  const requiredFields = activeContract?.round_schema?.required_fields || [];
  const accepted = new Map();
  const admittedEvidence = new Set();
  const intents = new Set();
  const sourceTypes = new Set();
  const facetEvidence = new Map();
  const expectedHypothesisIds = new Set(asArray(activeContract?.hypotheses).map((item) => text(item?.hypothesis_id, 160)).filter(Boolean));
  const expectedFacetIds = new Set(asArray(activeContract?.required_field_facets).map((item) => text(item?.facet_id, 160)).filter(Boolean));
  const allowedAcceptedIds = acceptedPaperIds == null
    ? null
    : new Set(asArray(acceptedPaperIds).map((id) => text(typeof id === "object" ? id.paper_id || id.id : id, 160)).filter(Boolean));

  if (!text(activeContract?.research_problem)) errors.push("contract_research_problem_missing");
  if (!expectedHypothesisIds.size) errors.push("contract_hypotheses_missing");
  if (!expectedFacetIds.size) errors.push("contract_required_field_facets_missing");
  if (!asArray(activeContract?.required_inquiry_intents).length) errors.push("contract_required_inquiry_intents_missing");
  if (!asArray(activeContract?.round_schema?.required_fields).length) errors.push("contract_round_schema_missing");

  if (!rounds.length) errors.push("search_rounds_empty");
  if (!text(journal.research_problem)) errors.push("journal_research_problem_missing");
  // MEASURED ON cycle-b-20260917h, 2026-09-17: the contract's problem was the
  // whole 1400-character objective, and every scout "copied" 326 characters of it
  // and failed on this check alone. An unformulated objective is not a problem
  // statement to match.
  const problemIsObjectiveText = activeContract?.research_problem_source === "objective_text";
  if (text(activeContract?.research_problem) && !problemIsObjectiveText && problemKey(journal.research_problem) !== problemKey(activeContract.research_problem)) {
    errors.push("journal_research_problem_mismatch");
  }
  for (const [index, round] of rounds.entries()) {
    for (const field of requiredFields) {
      // Citation parent/result/accepted lists may honestly be empty for an
      // unsuccessful probe or for the first direct inquiry.  Requiring a fake
      // ID would make the journal less trustworthy, so require the field, not
      // a non-empty list.
      const present = Array.isArray(round?.[field]) ? Object.prototype.hasOwnProperty.call(round || {}, field) : Boolean(text(round?.[field]));
      if (!present) errors.push(`round_${index + 1}_missing_${field}`);
    }
    const inquiryIntent = text(round?.inquiry_intent);
    const source = typeof round?.source === "string" ? text(round.source) : "";
    if (!source) errors.push(`round_${index + 1}_source_not_scalar`);
    if (source) sourceTypes.add(source.toLowerCase());
    const allowedIntents = asArray(activeContract?.round_schema?.allowed_inquiry_intents);
    if (inquiryIntent && allowedIntents.length && !allowedIntents.includes(inquiryIntent)) errors.push(`round_${index + 1}_unknown_inquiry_intent:${inquiryIntent}`);
    const resultIds = asArray(round?.result_ids).map((id) => text(id, 160)).filter(Boolean);
    if (inquiryIntent) intents.add(inquiryIntent);
    const decisions = asArray(round?.reading_decisions);
    if (["backward_citation", "forward_citation"].includes(inquiryIntent)) {
      const parentIds = asArray(round?.parent_paper_ids).map((id) => text(id, 160)).filter(Boolean);
      if (!parentIds.length) errors.push(`citation_round_missing_parent:${index + 1}`);
      if (!/(citation|reference|bibliograph)/i.test(source)) errors.push(`citation_round_missing_citation_source:${index + 1}`);
      for (const parentId of parentIds) {
        // MEASURED ON cycle-a-20260919, 2026-10-14: scout 476
        // cited arxiv:2505.05787 after accepting the same paper under its
        // versioned arXiv URL; literal comparison rejected both graph rounds.
        if (![...accepted.keys()].some((acceptedId) => samePaperIdentity(parentId, acceptedId))) {
          errors.push(`citation_round_parent_not_previously_accepted:${index + 1}:${parentId}`);
        }
      }
    }
    if (inquiryIntent === "cross_field_bridge") {
      const bridge = round?.bridge_applicability;
      const classification = text(bridge?.classification).toLowerCase();
      if (!["direct_evidence", "method_transfer", "inapplicable"].includes(classification)) {
        errors.push(`cross_field_bridge_unclassified:${index + 1}`);
      }
      if (["direct_evidence", "method_transfer"].includes(classification) && !text(bridge?.changed_execution_element)) {
        errors.push(`cross_field_bridge_missing_execution_change:${index + 1}`);
      }
    }
    for (const decision of decisions) {
      const paperId = text(decision?.paper_id || decision?.result_id, 160);
      if (!paperId) continue;
      if (decision?.abstract_read_in_full === true && text(decision?.decision).toLowerCase() === "directly_relevant") {
        accepted.set(paperId, decision);
      }
    }
    for (const paperIdValue of asArray(round?.evidence_accepted_ids)) {
      const paperId = text(paperIdValue, 160);
      const decision = accepted.get(paperId);
      if (!decision) {
        errors.push(`accepted_evidence_not_full_abstract_reviewed:${paperId || index + 1}`);
        continue;
      }
      if (allowedAcceptedIds && !allowedAcceptedIds.has(paperId)) {
        errors.push(`accepted_evidence_not_in_screened_accept_list:${paperId}`);
        continue;
      }
      if (!resultIds.includes(paperId)) errors.push(`accepted_evidence_not_in_round_results:${paperId}`);
      const hypotheses = asArray(decision.hypothesis_ids || round.hypothesis_ids).map((id) => text(id, 160)).filter(Boolean);
      const facets = asArray(decision.facet_ids || round.facet_ids).map((id) => text(id, 160)).filter(Boolean);
      let bindingsValid = true;
      if (!hypotheses.length) errors.push(`accepted_evidence_missing_hypothesis_binding:${paperId}`);
      if (!facets.length) errors.push(`accepted_evidence_missing_facet_binding:${paperId}`);
      if (!hypotheses.length || !facets.length) bindingsValid = false;
      for (const hypothesisId of hypotheses) {
        if (expectedHypothesisIds.size && !expectedHypothesisIds.has(hypothesisId)) {
          errors.push(`accepted_evidence_unknown_hypothesis_binding:${paperId}:${hypothesisId}`);
          bindingsValid = false;
        }
      }
      for (const facetId of facets) {
        if (expectedFacetIds.size && !expectedFacetIds.has(facetId)) {
          errors.push(`accepted_evidence_unknown_facet_binding:${paperId}:${facetId}`);
          bindingsValid = false;
        }
      }
      if (bindingsValid) {
        for (const facetId of facets) facetEvidence.set(facetId, (facetEvidence.get(facetId) || []).concat(paperId));
        admittedEvidence.add(paperId);
      }
    }
  }

  const requiredIntents = asArray(activeContract?.required_inquiry_intents);
  for (const intent of requiredIntents) if (!intents.has(intent)) errors.push(`required_inquiry_intent_missing:${intent}`);
  if (intents.size < 2 && rounds.length) errors.push("distinct_inquiry_intents_insufficient");
  const sourceMinimum = Number(activeContract?.source_diversity_policy?.minimum_distinct_source_types || 0);
  if (sourceMinimum && sourceTypes.size < sourceMinimum) errors.push("source_diversity_insufficient");
  for (const facet of asArray(activeContract?.required_field_facets)) {
    const facetId = text(facet?.facet_id, 160);
    if (facetId && !facetEvidence.has(facetId)) errors.push(`required_field_facet_pending:${facetId}`);
  }
  const synthesis = journal.synthesis && typeof journal.synthesis === "object" ? journal.synthesis : null;
  // MEASURED ON cycle-a-20260919, 2026-10-14: scouts 457 and 476
  // recorded the prompt's search_complete flag in the final synthesis but did
  // not duplicate it as the undocumented journal.status field.
  const claimsComplete = ["complete", "completed", "coverage_complete", "saturated"].includes(text(journal.status).toLowerCase())
    || synthesis?.saturation?.search_complete === true;
  // A valid checkpoint is not a finished search. In particular, reaching the
  // evidence checklist while a reviewer is still working cannot release Gate.
  if (!claimsComplete) errors.push("search_not_completed");
  const coverage = journal.coverage && typeof journal.coverage === "object" ? journal.coverage : null;
  const saturation = synthesis?.saturation && typeof synthesis.saturation === "object" ? synthesis.saturation : null;
  if (!coverage || !Array.isArray(coverage.unanswered_questions)) errors.push("coverage_unanswered_questions_missing");
  if (!synthesis || !Array.isArray(synthesis.next_search_decisions)) errors.push("next_search_decisions_missing");
  if (!synthesis || !Array.isArray(synthesis.claim_paper_links) || !synthesis.claim_paper_links.length) errors.push("claim_paper_links_missing");
  const closestPriorArt = asArray(synthesis?.closest_prior_art);
  if (!closestPriorArt.length && !text(synthesis?.closest_prior_art?.paper_id)) errors.push("closest_prior_art_missing");
  if (!synthesis || !Array.isArray(synthesis.coverage_gaps)) errors.push("coverage_gaps_missing");
  for (const [index, link] of asArray(synthesis?.claim_paper_links).entries()) {
    const hypothesisIds = asArray(link?.hypothesis_ids || link?.hypothesis_id || link?.claim_id)
      .map((id) => text(id, 160)).filter(Boolean);
    const paperIds = asArray(link?.paper_ids || link?.supporting_paper_ids).map((id) => text(id, 160)).filter(Boolean);
    // MEASURED ON cycle-a-20260919, 2026-10-14: both completed
    // scouts used hypothesis_ids, matching round bindings, while this one
    // validator branch accepted only the singular spelling.
    if (!hypothesisIds.length || (expectedHypothesisIds.size && hypothesisIds.some((id) => !expectedHypothesisIds.has(id)))) {
      errors.push(`claim_link_unknown_hypothesis:${index + 1}`);
    }
    if (!paperIds.length) errors.push(`claim_link_missing_papers:${index + 1}`);
    for (const paperId of paperIds) if (!admittedEvidence.has(paperId)) errors.push(`claim_link_unscreened_paper:${index + 1}:${paperId}`);
  }
  for (const [index, priorArt] of asArray(synthesis?.closest_prior_art).entries()) {
    const paperId = text(priorArt?.paper_id || priorArt, 160);
    if (!paperId || !admittedEvidence.has(paperId)) errors.push(`closest_prior_art_unscreened_paper:${index + 1}`);
  }
  if (claimsComplete && !text(saturation?.termination_reason)) errors.push("saturation_termination_reason_missing");
  const roundIds = new Set(rounds.map((round) => text(round?.round_id, 160)).filter(Boolean));
  const openGaps = classifyOpenItems(synthesis?.coverage_gaps, roundIds, "coverage_gap");
  const openQuestions = classifyOpenItems(coverage?.unanswered_questions, roundIds, "unanswered_question");
  errors.push(...openGaps.errors, ...openQuestions.errors);
  const hasNextSearch = Array.isArray(synthesis?.next_search_decisions) && synthesis.next_search_decisions.length > 0;
  if (openGaps.blocking.length) errors.push("coverage_gaps_pending");
  if (openGaps.blocking.length && !hasNextSearch) errors.push("coverage_gap_requires_next_search_decision");
  if (openQuestions.blocking.length && !hasNextSearch) errors.push("unanswered_question_requires_next_search_decision");
  if (openQuestions.blocking.length) errors.push("unanswered_questions_pending");
  if (claimsComplete && openQuestions.blocking.length) errors.push("self_claimed_complete_with_unanswered_questions");
  if (claimsComplete && text(saturation?.termination_reason).match(/count|quota|minimum|enough papers|many results|\b\d+\b.*\b(search|paper|result)s?\b/i)) {
    errors.push("count_based_saturation_claim");
  }
  if (claimsComplete && errors.length) errors.push("self_claimed_complete_with_unmet_contract");
  return {
    valid: errors.length === 0,
    status: errors.length ? "pending" : "validated",
    gaps: errors,
    errors,
    decision_ready: errors.length === 0 && Boolean(synthesis?.claim_paper_links?.length) && Boolean(synthesis?.closest_prior_art?.length || synthesis?.closest_prior_art?.paper_id) && Array.isArray(coverage?.unanswered_questions) && openQuestions.blocking.length === 0,
    // Questions and gaps no further search can close: what answers them is an
    // experiment, this host, or the absence the searches established.
    deferred_open_items: [...openQuestions.deferred, ...openGaps.deferred],
    accepted_evidence_ids: [...admittedEvidence],
    covered_facet_ids: [...facetEvidence.keys()],
  };
}

function validateSearchAgentJournal(value, contract = null) {
  return validateSearchJournal(value, { contract });
}

function screenedPaperIds(papers, objective) {
  const ids = [];
  const fullObjective = typeof objective === "string" ? objective.replace(/\s+/g, " ").trim() : "";
  for (const paper of filterScreenedEvidence(asArray(papers), { objective: fullObjective })) {
    ids.push(
      paper?.literature_screening?.review?.paper_id,
      paper?.paper_id,
      paper?.id,
      paper?.doi,
      paper?.DOI,
      paper?.title,
    );
  }
  return unique(ids.map((id) => text(id, 160)));
}

// Used by the Python entrypoint as the single JS-side interpretation of the
// contract.  Keeping this next to the validator prevents a second, weaker
// Python implementation from declaring a count of accepted papers sufficient.
function assessSearchAgentPayload(payload = {}) {
  const rolePlan = payload?.role_plan && typeof payload.role_plan === "object" ? payload.role_plan : {};
  const contract = payload?.search_agent_contract || rolePlan.search_agent_contract || null;
  const journal = payload?.search_agent_journal || payload?.journal || null;
  const objective = payload?.objective || payload?.screening_objective || rolePlan.screening_objective || rolePlan.objective || rolePlan.prompt || "";
  const screenedIds = filterScreenedEvidence(asArray(payload?.papers), { objective })
    .map((paper) => paper.literature_screening.review.paper_id);
  if (!contract || typeof contract !== "object") {
    return {
      valid: false,
      status: "pending",
      decision_ready: false,
      gaps: ["search_agent_contract_missing"],
      accepted_evidence_ids: [],
      covered_facet_ids: [],
      screened_paper_ids: screenedIds,
    };
  }
  return {
    ...validateSearchJournal(journal, {
      contract,
      acceptedPaperIds: screenedPaperIds(payload?.papers, objective),
    }),
    screened_paper_ids: screenedIds,
  };
}

module.exports = {
  OPEN_ITEM_KINDS,
  OPEN_ITEM_EXHAUSTED_MIN_ROUNDS,
  SEARCH_AGENT_JOURNAL_SCHEMA,
  journalSchema: SEARCH_AGENT_JOURNAL_SCHEMA,
  journal: { schema: SEARCH_AGENT_JOURNAL_SCHEMA },
  buildSearchAgentContract,
  buildSearchAgentFollowupInstructions,
  validateSearchJournal,
  validateSearchAgentJournal,
  assessSearchAgentPayload,
};

if (require.main === module) {
  const [, , command, inputPath] = process.argv;
  if (command !== "--validate" || !inputPath) {
    process.stderr.write("Usage: node src/agents/scout/search_agent.js --validate <result-json>\n");
    process.exitCode = 2;
  } else {
    try {
      // Deliberately stdout-only JSON: the caller writes the assessment into
      // its own result artifact and can make its status fail closed.
      const fs = require("fs");
      const payload = JSON.parse(inputPath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(inputPath, "utf8"));
      process.stdout.write(`${JSON.stringify(assessSearchAgentPayload(payload))}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ valid: false, status: "pending", decision_ready: false, gaps: ["search_agent_assessment_unreadable"], error: String(error?.message || error) })}\n`);
      process.exitCode = 1;
    }
  }
}
