"use strict";

const crypto = require("crypto");
const POLICY_VERSION = "abstract-direct-relevance-v1";
// How much of an abstract a single cited passage may be. A quote that is most of
// the document is not a citation, it is a paste.
const MAX_QUOTE_SHARE = 0.5;

/**
 * The longest a cited passage may be.
 *
 * Half the abstract, but never below the minimum the passage itself must meet:
 * an abstract of 21 characters cannot yield a 20-character quote that is also
 * under half of it, and refusing every such paper would be the cap deciding
 * which papers exist rather than which reviews are real. Pasting the abstract
 * back is blocked outright by the equality check at the call site, which is the
 * behaviour actually measured on v90.
 */
function quoteCeiling(abstract, minChars) {
  return Math.max(minChars, MAX_QUOTE_SHARE * abstract.length);
}
const clean = (value) => String(value || "").replace(/\s+/gu, " ").trim();
const hash = (value) => crypto.createHash("sha256").update(clean(value), "utf8").digest("hex");

function paperIdentity(paper) {
  const doi = clean(paper.doi || paper.DOI).toLowerCase().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/, "");
  if (doi) return `doi:${doi}`;
  for (const field of ["pmid", "openalex_id", "arxiv_id", "url"]) {
    if (clean(paper[field])) return `${field}:${clean(paper[field])}`;
  }
  return `title-sha256:${hash(clean(paper.title).toLowerCase())}`;
}

function sourced(metric) {
  if (!metric || !clean(metric.source) || !clean(metric.observed_at)) return false;
  try { return ["https:", "http:"].includes(new URL(metric.source_url).protocol); } catch { return false; }
}

function hasQualityEvidence(paper, now = new Date()) {
  const year = Number(paper.year);
  if (Number.isInteger(year) && year >= now.getUTCFullYear() - 3 && year <= now.getUTCFullYear()) {
    if (!paper.publication_date) return true;
    const published = new Date(paper.publication_date);
    const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
    if (Number.isFinite(published.getTime()) && published <= now && published >= cutoff) return true;
  }
  const citation = paper.citation_count_provenance;
  if (Number.isInteger(paper.cited_by_count) && paper.cited_by_count >= 100
      && sourced(citation) && citation.value === paper.cited_by_count) return true;
  const percentile = paper.field_normalized_citation_percentile;
  if (sourced(percentile) && percentile.field_normalized === true && clean(percentile.field)
      && percentile.scale === "0-100" && percentile.value >= 90 && percentile.value <= 100
      && percentile.metric_year >= 1900 && percentile.metric_year <= now.getUTCFullYear()) return true;
  return (Array.isArray(paper.venue_metrics) ? paper.venue_metrics : []).some((metric) => sourced(metric)
    && metric.verified === true && clean(metric.venue).toLowerCase() === clean(paper.journal).toLowerCase()
    && clean(paper.journal) && ["quartile", "sjr_quartile", "jcr_quartile"].includes(clean(metric.metric).toLowerCase())
    && clean(metric.value).toUpperCase() === "Q1" && metric.metric_year >= 1900 && metric.metric_year <= now.getUTCFullYear());
}

// The reviewer makes the semantic judgment. This boundary verifies the exact
// reviewed text, objective and quality evidence before any downstream use.
function isScreenedEvidence(paper, { objective = "", now } = {}) {
  if (!paper || typeof paper !== "object" || !clean(paper.title) || !clean(paper.abstract)) return false;
  if (paper.abstract_text_kind != null && !["full_abstract", "verbatim", "source_abstract"].includes(paper.abstract_text_kind)) return false;
  const receipt = paper.literature_screening;
  const review = receipt?.review;
  if (receipt?.policy_version !== POLICY_VERSION || receipt.status !== "accepted"
      || !/^[a-f0-9]{64}$/.test(receipt.context_hash || "") || receipt.quality?.eligible !== true
      || !hasQualityEvidence(paper, now)) return false;
  if (!review || review.paper_id !== paperIdentity(paper) || review.abstract_sha256 !== hash(paper.abstract)
      || review.objective_hash !== receipt.objective_hash || !/^[a-f0-9]{64}$/.test(receipt.objective_hash || "")
      || (clean(objective) && review.objective_hash !== hash(objective))
      || review.abstract_read_in_full !== true || review.decision !== "directly_relevant"
      || !["human", "codex_cli"].includes(review.reviewer?.kind) || !clean(review.reviewer?.identity)
      || !clean(review.reviewed_at) || clean(review.direct_relevance_reason).length < 30
      || clean(review.limitations).length < 20) return false;
  const abstract = clean(paper.abstract);
  const quote = clean(review.supporting_passage);
  // A QUOTE, not the document. `abstract.includes(quote)` is satisfied for free
  // by pasting the abstract back, and on cycle-g-v90 that is what 252 of 252
  // reviews did -- so the "cite the passage you relied on" requirement was
  // costing the reviewer nothing and proving nothing.
  if (quote.length < 20 || quote === abstract || quote.length > quoteCeiling(abstract, 20)
      || !abstract.includes(quote)) return false;
  const dimensions = ["study_task", "method", "outcome"];
  const passages = [];
  const objectiveLinks = [];
  for (const dimension of dimensions) {
    const link = review.linkage?.[dimension];
    const passage = clean(link?.abstract_evidence);
    const objectiveLink = clean(link?.objective_link);
    if (passage.length < 12 || passage === abstract || passage.length > quoteCeiling(abstract, 12)
        || !abstract.includes(passage) || objectiveLink.length < 30) return false;
    passages.push(passage);
    objectiveLinks.push(objectiveLink);
  }
  // Three dimensions are three different claims about the paper. All 252 v90
  // reviews answered all three with the SAME sentence, which is the shape of a
  // reviewer that filled the field rather than read for it.
  if (new Set(passages).size !== dimensions.length) return false;
  if (new Set(objectiveLinks).size !== dimensions.length) return false;
  return true;
}

/**
 * Reviews that are word-for-word identical across papers.
 *
 * MEASURED ON cycle-g-v90: 252 accepted papers carried FOUR distinct
 * `direct_relevance_reason` values -- one covered 70% of them -- and fifteen
 * distinct `objective_link` values across 756 links, the top three appearing 176
 * times each. Not one review was about the paper it was attached to, which is
 * how "EEG is better left alone", a study of EEG preprocessing pipelines, was
 * admitted to a rendering corpus as `directly_relevant`.
 *
 * Every per-paper check above passed on that paper. They had to: each one is
 * satisfiable by construction without reading anything. This is the check that
 * is not -- a sentence explaining why THIS paper is relevant cannot also be the
 * sentence explaining why a different one is.
 */
function templatedReviewKeys(papers) {
  const seen = new Map();
  for (const paper of Array.isArray(papers) ? papers : []) {
    const review = paper?.literature_screening?.review;
    if (!review) continue;
    const reason = clean(review.direct_relevance_reason);
    if (!reason) continue;
    seen.set(reason, (seen.get(reason) || 0) + 1);
  }
  return new Set([...seen].filter(([, count]) => count > 1).map(([reason]) => reason));
}

function filterScreenedEvidence(papers, options) {
  const list = Array.isArray(papers) ? papers : [];
  const templated = templatedReviewKeys(list);
  return list.filter((paper) => {
    if (!isScreenedEvidence(paper, options)) return false;
    const reason = clean(paper?.literature_screening?.review?.direct_relevance_reason);
    return !templated.has(reason);
  });
}

// Preserve the evidence receipt intact through compact summaries; truncating
// abstracts or identity fields invalidates their review hashes.
function screeningEvidenceFields(paper) {
  return Object.fromEntries(["abstract", "abstract_text_kind", "literature_screening", "publication_date", "cited_by_count",
    "citation_count_provenance", "field_normalized_citation_percentile", "venue_metrics", "journal",
    "pmid", "openalex_id", "arxiv_id"].filter((key) => paper[key] !== undefined).map((key) => [key, paper[key]]));
}

function splitEvidenceTracks(papers) {
  const inTrack = (track) => papers.filter((paper) => paper.literature_screening?.quality?.tracks?.includes(track));
  return { recent_frontier_papers: inTrack("recent_frontier"), established_impact_papers: inTrack("established_impact") };
}

module.exports = { POLICY_VERSION, MAX_QUOTE_SHARE, hash, paperIdentity, hasQualityEvidence, isScreenedEvidence, filterScreenedEvidence, templatedReviewKeys, screeningEvidenceFields, splitEvidenceTracks };
