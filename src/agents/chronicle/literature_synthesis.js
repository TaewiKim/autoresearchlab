"use strict";

const crypto = require("crypto");
const { POLICY_VERSION, filterScreenedEvidence, screeningEvidenceFields, splitEvidenceTracks } = require("../../policy/literature_screening");
const fs = require("fs");
const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { ensureDir, writeFileAtomic } = require("../../shared/json");
const { buildPaperOrchestraLoop, aggregateWritingLoops } = require("./paper_orchestra_loop");
const { verifyCitation } = require("./citation_verifier");
const { enrichCitationWithScholarlyMetadata } = require("./scholarly_metadata_lookup");
const { scholarlyVerificationPolicyDecision } = require("../../policy/scholarly_verification_policy");
const {
  deriveThemes,
  uniqueTopPapers,
  compactGraphForLiteratureSummary,
  compactWritingLoopForLiteratureSummary,
  compactLaneForLiteratureSummary,
  writeJsonCompact,
} = require("./literature_synthesis/compact");
const { groundedVariableBundle, buildCodebookGraph } = require("./literature_synthesis/codebook");
const { buildLiteratureGraph, aggregateLiteratureGraphs } = require("./literature_synthesis/literature_graph");
const {
  buildHypotheses,
  buildBrainstormHypotheses,
  buildScenarioHypotheses,
  buildClaims,
  buildFamilyNomination,
  buildFallbackFrontierCatalog,
  buildFamilyTournament,
} = require("./literature_synthesis/hypotheses");
const {
  buildDataGraph,
  aggregateDataGraphs,
  buildCycleFamilyTournament,
  aggregateFamilyNomination,
} = require("./literature_synthesis/data_graphs");
const { writeCycleKnowledgeStateArtifacts } = require("./literature_synthesis/state_artifacts");
const { assessSearchAgentPayload } = require("../scout/search_agent");
const { cycleStateReader } = require("../shared/gated_state");

// Every refresh used to JSON.parse EVERY lane's result.json just to read the
// `driver` field, then discard 95% of the bytes (measured on cycle-g-v55:
// 983 lanes, 805 MB parsed per pass, of which 762 MB belonged to non-literature
// lanes). Re-synthesis then re-ran for all 177 literature lanes even when
// nothing about them had changed. The cost grows with cycle length, and it
// eventually starved the supervisor's dispatch loop (main JS thread pegged in
// userspace JSON.parse). This scan cache makes the pass proportional to what
// actually changed. Correctness is unchanged: any lane whose result.json size
// or mtime moved -- or any change to the synthesis inputs, tracked by the
// fingerprint -- falls back to the original parse-and-synthesize path.
const SCAN_CACHE_VERSION = 5;

function scanCachePath(root, cycleId) {
  return path.join(root, "state", `${cycleId}-literature-synthesis-scan-cache.json`);
}

// A stable key for matching a paper against Chronicle's off-domain list: DOI when
// present, else the normalized title.
function paperMatchKey(paper) {
  const doi = String((paper && (paper.doi || paper.DOI)) || "").trim().toLowerCase();
  if (doi) return `doi:${doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`;
  const title = String((paper && (paper.title || paper.id)) || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return title ? `title:${title}` : "";
}

// Optional Chronicle decisions can further narrow already screened papers.
// An empty admit-list excludes everything; it never reopens the raw corpus.
function chronicleRelevanceDecision(root, cycleId) {
  const none = { mode: "none", keys: new Set() };
  if (!root || !cycleId) return none;
  try {
    // Chronicle's relevance verdict decides which papers reach the synthesis, so
    // it is admitted for THIS cycle rather than read on sight. The scan cache
    // above is this module's own working file, not a record entering context,
    // and is deliberately left ungated.
    const decision = cycleStateReader({ root, cycleId, task: "literature_synthesis" })(
      "chronicle-literature-relevance.json",
    );
    if (!decision) return none;
    const toKeys = (list) => {
      const keys = new Set();
      for (const item of Array.isArray(list) ? list : []) {
        const key = paperMatchKey(item && typeof item === "object" ? item : { title: item });
        if (key) keys.add(key);
      }
      return keys;
    };
    const keptKeys = toKeys(decision && decision.kept);
    if (Array.isArray(decision?.kept)) return { mode: "admit", keys: keptKeys };
    const droppedKeys = toKeys(decision && decision.dropped);
    if (droppedKeys.size > 0) return { mode: "drop", keys: droppedKeys };
    return none;
  } catch {
    return none;
  }
}

function relevanceArtifactMtimeMs(root, cycleId) {
  try {
    return fs.statSync(path.join(root, "state", `${cycleId}-chronicle-literature-relevance.json`)).mtimeMs;
  } catch {
    return 0;
  }
}

function synthesisFingerprint({ researchStage, allowExternal, cyclePrompt, relevanceMtime = 0 }) {
  const promptHash = crypto.createHash("sha1").update(String(cyclePrompt || "")).digest("hex").slice(0, 16);
  // Fold in the Chronicle relevance decision's mtime so that when Chronicle
  // updates which papers are off-domain, every cached lane re-synthesizes and
  // re-applies the (new) exclusion instead of serving a stale graph.
  return `v${SCAN_CACHE_VERSION}|${String(researchStage || "")}|${allowExternal ? 1 : 0}|${promptHash}|${relevanceMtime}|${new Date().toISOString().slice(0, 10)}`;
}

function readScanCache(root, cycleId, fingerprint) {
  try {
    const cache = JSON.parse(fs.readFileSync(scanCachePath(root, cycleId), "utf8"));
    if (cache && cache.fingerprint === fingerprint && cache.lanes && typeof cache.lanes === "object") {
      return cache.lanes;
    }
  } catch {
    // Missing or unreadable cache simply means a full scan this pass.
  }
  return {};
}

function writeScanCache(root, cycleId, fingerprint, lanes) {
  // A cache that cannot be written is a full scan next pass, not a dead cycle.
  // readScanCache has always treated a missing cache that way; the writer did
  // not, and on 2026-09-23 a failed rename here aborted run-research outright.
  try {
    writeFileAtomic(
      scanCachePath(root, cycleId),
      JSON.stringify({ version: SCAN_CACHE_VERSION, fingerprint, lanes }),
    );
  } catch (error) {
    console.warn(`[chronicle] literature scan cache not written: ${error && error.message}`);
  }
}

// Papers a lane wrote beside its result rather than inside it.
//
// The bootstrap literature scout is a codex agent by design: it authors its own
// queries and writes what it found to `papers.json`. Nothing ever read that.
// v87's scout-02 collected 120 rendering papers into a 263KB sidecar while the
// literature graph sat at 0 nodes and the cycle deadlocked around it.
function readPapersSidecar(laneDir) {
  if (!laneDir) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(laneDir, "papers.json"), "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.papers)) return parsed.papers;
    return [];
  } catch {
    return [];
  }
}

// Size and mtime of that sidecar, folded into the scan cache key. Without it a
// lane admitted through the sidecar is cached on result.json alone and served
// stale forever, because its result.json never changes again.
function papersSidecarStamp(laneDir) {
  try {
    const stat = fs.statSync(path.join(laneDir, "papers.json"));
    return { size: stat.size, mtime_ms: stat.mtimeMs };
  } catch {
    return null;
  }
}

function searchAgentArtifactsStamp(laneDir) {
  const stamp = {};
  for (const [key, name] of [["journal", "search-agent-journal.json"], ["synthesis", "search-agent-synthesis.json"]]) {
    try {
      const stat = fs.statSync(path.join(laneDir, name));
      stamp[`${key}_size`] = stat.size;
      stamp[`${key}_mtime_ms`] = stat.mtimeMs;
    } catch {
      stamp[`${key}_size`] = null;
      stamp[`${key}_mtime_ms`] = null;
    }
  }
  return stamp;
}

function readJsonSidecar(laneDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(laneDir, name), "utf8")); } catch { return null; }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function contractSignature(contract) {
  return crypto.createHash("sha256").update(canonicalJson({
    research_problem: contract?.research_problem || null,
    hypotheses: contract?.hypotheses || [],
    required_field_facets: contract?.required_field_facets || [],
  })).digest("hex");
}

function sourceLaneId(rolePlan) {
  const metadata = rolePlan?.planner_metadata || {};
  return metadata?.source_lane_id
    || metadata?.review_action?.source_lane_id
    || metadata?.review_action?.source?.lane_id
    || metadata?.source?.lane_id
    || rolePlan?.source_lane_id
    || null;
}

function searchAgentAssessment({ result, rolePlan, papers, laneDir, objective }) {
  const contract = result?.search_agent_contract || rolePlan?.search_agent_contract || null;
  if (!contract) return { applicable: false, valid: true, decision_ready: true, status: "not_applicable", gaps: [] };
  const journal = result?.search_agent_journal || readJsonSidecar(laneDir, "search-agent-journal.json");
  const synthesis = result?.search_agent_synthesis || readJsonSidecar(laneDir, "search-agent-synthesis.json");
  const combinedJournal = journal && typeof journal === "object"
    ? { ...journal, synthesis: journal.synthesis || synthesis || undefined }
    : journal;
  const assessment = assessSearchAgentPayload({
    ...result,
    objective,
    role_plan: rolePlan,
    search_agent_contract: contract,
    search_agent_journal: combinedJournal,
    papers,
  });
  const roundIds = Array.isArray(combinedJournal?.search_rounds)
    ? combinedJournal.search_rounds.map((round) => String(round?.round_id || "").trim()).filter(Boolean)
    : [];
  return {
    applicable: true,
    ...assessment,
    // Keep the origin contract and auditable lineage with the lane synthesis.
    // A successor can only lift a predecessor when aggregateSearchAgentContracts
    // proves this exact signature and inherited inquiry history.
    source_contract: contract,
    lineage: {
      source_lane_id: sourceLaneId(rolePlan),
      action_type: rolePlan?.action_type || result?.action_type || null,
      contract_signature: contractSignature(contract),
      round_ids: roundIds,
      round_count: roundIds.length,
    },
  };
}

function isVerifiedRecoveryStep(sourceLane, candidate) {
  const source = sourceLane?.search_agent_contract;
  const successor = candidate?.search_agent_contract;
  const sourceId = sourceLane?.lane_id;
  const sourceRounds = source?.lineage?.round_ids || [];
  if (!sourceId || !source?.lineage?.contract_signature || !successor || successor.applicable !== true) return false;
  if (successor.lineage?.source_lane_id !== sourceId) return false;
  if (successor.lineage?.contract_signature !== source.lineage.contract_signature) return false;
  const successorRounds = new Set(successor.lineage?.round_ids || []);
  if (!sourceRounds.every((roundId) => successorRounds.has(roundId))) return false;
  // A no-history Scout may be superseded by a real validated inquiry: there
  // are no old round IDs to inherit, but the successor must still add one.
  if (successor.lineage?.round_count > source.lineage.round_count) return true;
  // An abstract-review follow-up may legitimately repair a receipt without
  // adding another search. It must be explicitly typed and demonstrate that
  // screened evidence improved; a generic retry cannot use this exception.
  const reviewGap = (source.gaps || []).some((gap) => /abstract|review|accepted_evidence/i.test(String(gap)));
  const evidenceImproved = (successor.accepted_evidence_ids || []).length > (source.accepted_evidence_ids || []).length;
  return successor.lineage?.action_type === "abstract_review_followup" && reviewGap && evidenceImproved;
}

function verifiedRecoveryFor(sourceLane, lanes, visited = new Set()) {
  const sourceId = sourceLane?.lane_id;
  if (!sourceId || visited.has(sourceId)) return null;
  const nextVisited = new Set(visited).add(sourceId);
  const candidates = lanes
    .filter((candidate) => candidate?.lane_id !== sourceId && isVerifiedRecoveryStep(sourceLane, candidate))
    // Prefer a terminal validated successor. This keeps an unrelated pending
    // branch from obscuring a direct completion.
    .sort((left, right) => Number(right.search_agent_contract?.decision_ready === true) - Number(left.search_agent_contract?.decision_ready === true));
  for (const candidate of candidates) {
    if (candidate.search_agent_contract?.decision_ready === true) return candidate;
    const terminal = verifiedRecoveryFor(candidate, lanes, nextVisited);
    if (terminal) return terminal;
  }
  return null;
}

function aggregateSearchAgentContracts(lanes) {
  const active = lanes.filter((lane) => lane?.search_agent_contract?.applicable === true);
  const recoveries = active
    .filter((lane) => lane.search_agent_contract.decision_ready !== true)
    .map((lane) => ({ source: lane, successor: verifiedRecoveryFor(lane, active) }))
    .filter((item) => item.successor);
  const recoveredIds = new Set(recoveries.map((item) => item.source.lane_id));
  const pending = active.filter((lane) => lane.search_agent_contract.decision_ready !== true && !recoveredIds.has(lane.lane_id));
  return {
    applicable: active.length > 0,
    active_lane_ids: active.map((lane) => lane.lane_id).filter(Boolean),
    pending_lane_ids: pending.map((lane) => lane.lane_id).filter(Boolean),
    decision_ready: active.length === 0 || pending.length === 0,
    status: active.length === 0 ? "not_applicable" : pending.length ? "pending" : "validated",
    gaps: pending.flatMap((lane) => (lane.search_agent_contract.gaps || []).map((gap) => `${lane.lane_id || "scout"}:${gap}`)).slice(0, 24),
    blockers: pending.map((lane) => `search-agent contract pending in ${lane.lane_id || "scout"}`).slice(0, 12),
    verified_recoveries: recoveries.map((item) => ({
      source_lane_id: item.source.lane_id,
      successor_lane_id: item.successor.lane_id,
      contract_signature: item.source.search_agent_contract.lineage.contract_signature,
    })),
    recovery_policy: "source_lane_id + identical_contract_signature + inherited_round_ids + validated_newer_rounds; abstract_review_followup may repair a review receipt only with improved screened evidence",
  };
}

function synthesizeLaneResult(result, options = {}) {
  // Inline first, sidecar second. A driver lane carries its papers in the
  // result; the codex-agent scout writes them beside it.
  const inlinePapers = Array.isArray(result.papers) ? result.papers : [];
  const rawPapers = inlinePapers.length
    ? inlinePapers
    : readPapersSidecar(options.laneDir);
  // Enforce Chronicle's category-relevance review BEFORE any paper becomes a
  // graph node / codebook variable / hypothesis grounding. The judgment is
  // Chronicle's; this is pure enforcement of whichever shape it emitted.
  const relevance = options.relevanceDecision || null;
  let papers = filterScreenedEvidence(rawPapers, { objective: options.cyclePrompt || result.role_plan?.screening_objective || result.role_plan?.objective || result.role_plan?.prompt || "" });
  if (relevance && relevance.keys instanceof Set && relevance.mode !== "none") {
    papers = relevance.mode === "admit"
      ? papers.filter((paper) => relevance.keys.has(paperMatchKey(paper)))
      : papers.filter((paper) => !relevance.keys.has(paperMatchKey(paper)));
  }
  const rolePlan = { ...(result.role_plan || {}) };
  // FIX-S2: the compacted lane role_plan has no prompt/objective, so seed the
  // cycle prompt here to let the prompt-grounded codebook fallback ground this
  // lane's hypotheses.
  if (!rolePlan.prompt && !rolePlan.objective && !rolePlan.followup_description && options.cyclePrompt) {
    rolePlan.prompt = options.cyclePrompt;
  }
  const agentAssessment = searchAgentAssessment({
    result,
    rolePlan,
    papers,
    laneDir: options.laneDir,
    objective: options.cyclePrompt || rolePlan.screening_objective || rolePlan.objective || rolePlan.prompt || "",
  });
  // Preserve screened papers for audit, but keep their claim/hypothesis use
  // pending until the adaptive search mission itself is decision-ready.
  const fullyScreened = papers.length > 0 && papers.length === rawPapers.length
    && agentAssessment.valid && agentAssessment.decision_ready;
  const hypothesisScenarios = fullyScreened && Array.isArray(result.hypothesis_scenarios) ? result.hypothesis_scenarios : [];
  const initialFrontierCatalog = fullyScreened && result.frontier_catalog && typeof result.frontier_catalog === "object"
    ? result.frontier_catalog
    : {};
  const literatureGraph = papers.length ? buildLiteratureGraph(papers, rolePlan, {
    discovered_queries: result.discovered_queries,
    hypothesis_scenarios: hypothesisScenarios,
  }) : { nodes: [], edges: [], hypotheses: [], codebook_graph: { nodes: [], edges: [] } };
  const codebookGraph = literatureGraph.codebook_graph || buildCodebookGraph(groundedVariableBundle(papers, rolePlan));
  const hypotheses = fullyScreened ? [
    ...buildHypotheses(papers, rolePlan),
    ...buildBrainstormHypotheses(papers, rolePlan),
    ...buildScenarioHypotheses(papers, rolePlan, hypothesisScenarios),
  ] : [];
  const frontierCatalog = papers.length ? buildFallbackFrontierCatalog(hypotheses, initialFrontierCatalog, rolePlan, papers) : {};
  const dataGraph = buildDataGraph(frontierCatalog, hypotheses);
  const claims = buildClaims(hypotheses);
  const themes = deriveThemes(papers);
  const familyNomination = buildFamilyNomination(hypotheses, frontierCatalog);
  const familyTournament = buildFamilyTournament(hypotheses);
  const writingLoop = buildPaperOrchestraLoop({
    papers,
    rolePlan,
    discoveredQueries: result.discovered_queries,
    themes,
    hypotheses,
    claims,
    researchStage: options.researchStage || "evidence",
    verifyCitationFn: (paper, index) => enrichCitationWithScholarlyMetadata({
      paper,
      citation: verifyCitation(paper, index),
      root: options.root || null,
      allowExternal: options.allowExternal,
    }),
  });

  return {
    source_driver: result.driver,
    role: result.role,
    role_plan: rolePlan,
    paper_count: papers.length,
    literature_screening: {
      policy_version: POLICY_VERSION,
      accepted_count: papers.length,
      excluded_or_pending_count: rawPapers.length - papers.length,
      status: papers.length && (!agentAssessment.applicable || fullyScreened) ? "screened" : "insufficient_corpus",
    },
    search_agent_contract: agentAssessment,
    discovered_queries: Array.isArray(result.discovered_queries) ? result.discovered_queries : [],
    hypothesis_scenarios: hypothesisScenarios,
    frontier_catalog: frontierCatalog,
    family_nomination: familyNomination,
    family_tournament: familyTournament,
    data_graph: dataGraph,
    literature_graph: literatureGraph,
    codebook_graph: codebookGraph,
    hypotheses,
    claims,
    themes,
    writing_loop: writingLoop,
    top_papers: papers.slice(0, 5).map((paper) => ({
      ...screeningEvidenceFields(paper),
      title: paper.title,
      url: paper.url || null,
      year: paper.year,
      doi: paper.doi || null,
      abstract_snippet: paper.abstract_snippet || null,
    })),
    ...splitEvidenceTracks(papers),
  };
}

/**
 * Take up to `budgets[track]` papers per evidence track, deduplicated.
 *
 * `splitEvidenceTracks` in the screening policy classifies; this decides how
 * many of each survive compaction. They are separate questions and were being
 * answered by one slice.
 */
function splitEvidenceTracksWithBudgets(lanes, budgets) {
  const perTrack = {};
  for (const [track, budget] of Object.entries(budgets)) {
    const laneField = `${track}_papers`;
    const scoped = lanes.map((lane) => ({ top_papers: lane[laneField] || [] }));
    perTrack[laneField] = uniqueTopPapers(scoped, budget);
  }
  return perTrack;
}

function synthesizeCycleLiterature({ cwd = process.cwd(), cycleId, researchStage = "evidence" }) {
  const root = runtimeRoot(cwd);
  const lanesRoot = path.join(root, "lanes", cycleId);
  const outputDir = path.join(root, "plans");
  ensureDir(outputDir);
  const scholarlyVerificationPolicy = scholarlyVerificationPolicyDecision({ researchStage });
  const allowExternal = scholarlyVerificationPolicy.external_lookup_enabled;
  // The per-lane result.role_plan is compacted to {content_policy, role} by the
  // driver, so it carries no prompt/objective — which means FIX-S's
  // prompt-grounded codebook fallback can't fire at synthesis time and every
  // lane's structured-hypothesis synthesis stays empty. Load the cycle prompt
  // once and thread it into each lane's grounding so families/outcomes ground
  // consistently (FIX-S2).
  let cyclePrompt = "";
  try {
    cyclePrompt = fs.readFileSync(path.join(outputDir, `${cycleId}-prompt.txt`), "utf8").trim();
  } catch {
    cyclePrompt = "";
  }

  const lanes = [];
  // Chronicle's category-relevance decision (which papers are off-domain) and its
  // mtime — folded into the fingerprint so an updated decision invalidates the
  // scan cache and re-applies the exclusion.
  const relevanceDecision = chronicleRelevanceDecision(root, cycleId);
  const relevanceMtime = relevanceArtifactMtimeMs(root, cycleId);
  const fingerprint = synthesisFingerprint({ researchStage, allowExternal, cyclePrompt, relevanceMtime });
  const cachedLanes = readScanCache(root, cycleId, fingerprint);
  const nextCache = {};
  if (fs.existsSync(lanesRoot)) {
    for (const laneId of fs.readdirSync(lanesRoot)) {
      const resultPath = path.join(lanesRoot, laneId, "result.json");
      let stat;
      try {
        stat = fs.statSync(resultPath);
      } catch {
        continue;
      }
      // Many non-literature recovery lanes can echo enormous role plans in
      // result.json. Literature synthesis only needs literature-search-driver
      // outputs, so avoid parsing multi-megabyte unrelated executor results
      // during refresh-cycle.
      if (stat.size > 25 * 1024 * 1024) continue;

      const laneOutputPath = path.join(lanesRoot, laneId, "lab-director-synthesis.json");
      const cached = cachedLanes[laneId];
      // The sidecar has to be part of the freshness key. A lane admitted through
      // papers.json has a result.json that never changes again, so comparing
      // that alone would serve its first synthesis forever -- including the
      // empty one produced before the sidecar was written.
      const cachedSidecar = papersSidecarStamp(path.dirname(resultPath));
      const cachedSearchAgent = searchAgentArtifactsStamp(path.dirname(resultPath));
      const sidecarUnchanged = cached
        ? (cached.papers_size ?? null) === (cachedSidecar?.size ?? null)
          && (cached.papers_mtime_ms ?? null) === (cachedSidecar?.mtime_ms ?? null)
        : false;
      const searchAgentUnchanged = cached
        && cached.search_agent_journal_size === cachedSearchAgent.journal_size
        && cached.search_agent_journal_mtime_ms === cachedSearchAgent.journal_mtime_ms
        && cached.search_agent_synthesis_size === cachedSearchAgent.synthesis_size
        && cached.search_agent_synthesis_mtime_ms === cachedSearchAgent.synthesis_mtime_ms;
      const unchanged = cached
        && cached.size === stat.size
        && cached.mtime_ms === stat.mtimeMs
        && sidecarUnchanged
        && searchAgentUnchanged;

      // Negative cache: an unchanged lane already known not to be a literature
      // lane never needs to be opened again.
      if (unchanged && cached.is_literature === false) {
        nextCache[laneId] = cached;
        continue;
      }

      // Positive cache: reuse the previously synthesized artifact when it is at
      // least as new as the result it was derived from.
      if (unchanged && cached.is_literature === true) {
        try {
          if (fs.statSync(laneOutputPath).mtimeMs >= stat.mtimeMs) {
            lanes.push({
              lane_id: laneId,
              ...JSON.parse(fs.readFileSync(laneOutputPath, "utf8")),
              synthesis_path: laneOutputPath,
            });
            nextCache[laneId] = cached;
            continue;
          }
        } catch {
          // Missing or unreadable synthesis artifact -> fall through and rebuild.
        }
      }

      // Defensive parse: a lane that crashed mid-write can leave a
      // truncated result.json. Skip and continue rather than abort the
      // synthesis pass — chronicle handles "lane unreadable" the same
      // as "lane absent".
      let result;
      try {
        result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch {
        continue;
      }
      const laneDir = path.dirname(resultPath);
      const sidecar = papersSidecarStamp(laneDir);
      const searchAgent = searchAgentArtifactsStamp(laneDir);
      // A lane counts as literature if it ran the driver OR if it left papers
      // beside its result. The second case is the bootstrap codex-agent scout,
      // whose 120 papers were skipped here in every cycle before this.
      // A file is not evidence: the sidecar must actually parse to a non-empty
      // array. A truncated or malformed papers.json otherwise admits the lane
      // and synthesizes it with zero papers, which is indistinguishable in the
      // output from a lane that genuinely found none.
      const rolePlan = result.role_plan && typeof result.role_plan === "object" ? result.role_plan : {};
      const contractedScout = (result.role || rolePlan.role) === "scout"
        && Boolean(result.search_agent_contract || rolePlan.search_agent_contract)
        && !["reasoning_data_scout", "data_acquisition_followup"].includes(result.action_type || rolePlan.action_type);
      const isLiterature = result.driver === "literature-search-driver"
        || (sidecar !== null && readPapersSidecar(laneDir).length > 0)
        || contractedScout;
      nextCache[laneId] = {
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        is_literature: isLiterature,
        ...(sidecar ? { papers_size: sidecar.size, papers_mtime_ms: sidecar.mtime_ms } : {}),
        search_agent_journal_size: searchAgent.journal_size,
        search_agent_journal_mtime_ms: searchAgent.journal_mtime_ms,
        search_agent_synthesis_size: searchAgent.synthesis_size,
        search_agent_synthesis_mtime_ms: searchAgent.synthesis_mtime_ms,
      };
      if (!isLiterature) continue;

      const synthesized = synthesizeLaneResult(result, {
        root,
        cycleId,
        laneDir,
        allowExternal,
        researchStage,
        cyclePrompt,
        relevanceDecision,
      });
      writeJsonCompact(laneOutputPath, synthesized);
      lanes.push({
        lane_id: laneId,
        ...synthesized,
        synthesis_path: laneOutputPath,
      });
    }
  }
  writeScanCache(root, cycleId, fingerprint, nextCache);

  const aggregatedFamilyNomination = aggregateFamilyNomination(
    lanes.flatMap((lane) => lane.family_nomination || []),
  );
  const aggregatedWritingLoop = aggregateWritingLoops(lanes);
  const dataGraph = aggregateDataGraphs(lanes);
  const literatureGraph = aggregateLiteratureGraphs(lanes);
  const compactLanes = lanes.map(compactLaneForLiteratureSummary);
  const searchAgentContract = aggregateSearchAgentContracts(lanes);
  const familyTournament = buildCycleFamilyTournament(
    lanes,
    aggregatedFamilyNomination,
  );
  const stateArtifacts = writeCycleKnowledgeStateArtifacts({
    root,
    cycleId,
    researchStage,
    lanes,
    literatureGraph,
    dataGraph,
    familyNomination: aggregatedFamilyNomination,
    familyTournament,
    writingLoop: aggregatedWritingLoop,
  });

  const summary = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    research_stage: researchStage,
    literature_screening: {
      policy_version: POLICY_VERSION,
      objective_hash: require("../../policy/literature_screening").hash(cyclePrompt),
      accepted_count: lanes.reduce((sum, lane) => sum + lane.paper_count, 0),
      status: searchAgentContract.decision_ready ? "screened" : "insufficient_corpus",
    },
    search_agent_contract: searchAgentContract,
    scholarly_verification_policy: scholarlyVerificationPolicy,
    summary_compacted: true,
    lane_synthesis_paths: compactLanes.map((lane) => ({
      lane_id: lane.lane_id,
      synthesis_path: lane.synthesis_path,
    })),
    lanes: compactLanes,
    lane_count: lanes.length,
    top_papers: uniqueTopPapers(lanes, 8),
    // Each track keeps its own budget. The union used to be truncated to 40
    // BEFORE the split, which quietly starved whichever track is rarer -- and
    // the rare one is always established_impact, because recency is abundant
    // and citation-backed standing is not.
    //
    // MEASURED ON cycle-g-v91: 179 papers admitted, 176 of them recent_frontier
    // and 3 established_impact. The three competed against 176 for the same
    // forty slots and ONE survived. The corpus that reached the graph held
    // nothing published before 2021 -- so no foundational audit was possible,
    // the scout could not complete, `completed_scouts` stayed at zero, and a
    // dozen lanes waited on a number that could not change.
    //
    // A cap that discards by abundance discards exactly the evidence a novelty
    // baseline is made of.
    ...splitEvidenceTracksWithBudgets(lanes, { recent_frontier: 40, established_impact: 40 }),
    hypothesis_count: lanes.reduce((sum, lane) => sum + lane.hypotheses.length, 0),
    claim_count: lanes.reduce((sum, lane) => sum + lane.claims.length, 0),
    family_nomination: aggregatedFamilyNomination,
    family_tournament: familyTournament,
    writing_loop: compactWritingLoopForLiteratureSummary(aggregatedWritingLoop, {
      sectionLimit: 14,
      evidenceLimit: 40,
      packetLimit: 14,
      citationLimit: 40,
    }),
    data_graph: compactGraphForLiteratureSummary(dataGraph, {
      nodeLimit: 180,
      edgeLimit: 260,
      hypothesisLimit: 80,
    }),
    literature_graph: compactGraphForLiteratureSummary(literatureGraph, {
      nodeLimit: 180,
      edgeLimit: 260,
      hypothesisLimit: 80,
    }),
    knowledge_graph: {
      literature_graphs: lanes.length,
      data_graphs: lanes.filter((lane) => lane.data_graph).length,
      codebook_graphs: lanes.filter((lane) => lane.codebook_graph).length,
      literature_graph_node_count: lanes.reduce(
        (sum, lane) => sum + Number(lane.literature_graph?.node_count || 0),
        0,
      ),
      literature_graph_edge_count: lanes.reduce(
        (sum, lane) => sum + Number(lane.literature_graph?.edge_count || 0),
        0,
      ),
      data_graph_node_count: lanes.reduce(
        (sum, lane) => sum + Number((lane.data_graph?.nodes || []).length),
        0,
      ),
      data_graph_edge_count: lanes.reduce(
        (sum, lane) => sum + Number((lane.data_graph?.edges || []).length),
        0,
      ),
      required_output_complete_count: lanes.reduce(
        (sum, lane) => sum + lane.hypotheses.filter((item) => item.required_output_complete).length,
        0,
      ),
      writing_sections_materialized: Number(aggregatedWritingLoop?.summary?.section_count || 0),
      verified_citation_count: Number(aggregatedWritingLoop?.summary?.verified_citation_count || 0),
    },
    source_paths: {
      lab_director_literature_path: path.join(outputDir, `${cycleId}-lab-director-literature.json`),
      literature_summary_path: stateArtifacts.literature_summary_path,
      literature_graph_path: stateArtifacts.literature_graph_path,
      data_graph_path: stateArtifacts.data_graph_path,
      trend_summary_path: stateArtifacts.trend_summary_path,
    },
    state_artifacts: {
      literature_summary_path: stateArtifacts.literature_summary_path,
      literature_graph_path: stateArtifacts.literature_graph_path,
      data_graph_path: stateArtifacts.data_graph_path,
      trend_summary_path: stateArtifacts.trend_summary_path,
      data_graph_preserved: stateArtifacts.data_graph_preserved,
    },
    trend_summary: stateArtifacts.trend_summary,
  };

  const outputPath = path.join(outputDir, `${cycleId}-lab-director-literature.json`);
  writeJsonCompact(outputPath, summary);
  writeJsonCompact(stateArtifacts.literature_summary_path, summary);
  return { outputPath, summary };
}

module.exports = {
  synthesizeCycleLiterature,
  synthesizeLaneResult,
  chronicleRelevanceDecision,
};
