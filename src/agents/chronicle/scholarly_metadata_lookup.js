"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureDir, writeJson } = require("../../shared/json");
const { approvedScholarlyMetadataPolicyEnabled } = require("../../policy/scholarly_verification_policy");

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function slugify(value, fallback = "item") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function buildCacheKey(paper) {
  const doi = normalizeText(paper?.doi);
  if (doi) return `doi-${slugify(doi)}`;
  const title = normalizeText(paper?.title);
  const year = String(paper?.year || "").trim();
  return `title-${slugify(`${title}-${year}`)}`;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// `secretHeaders` go to curl on standard input (`-K -`), never on its command
// line, where any process listing would show them.
function defaultRequestJson(url, secretHeaders = []) {
  const config = secretHeaders.map((header) => `header = "${String(header).replace(/["\\]/g, "")}"`).join("\n");
  const output = execFileSync("curl", [
    "-fsSL",
    "-H",
    "User-Agent: ResearchLab/0.1 (autoresearch local verifier)",
    ...(config ? ["-K", "-"] : []),
    url,
  ], {
    encoding: "utf8",
    timeout: 5000,
    input: config ? `${config}\n` : undefined,
    stdio: [config ? "pipe" : "ignore", "pipe", "ignore"],
  });
  // Defensive: external curl can return truncated / non-JSON bodies on
  // network hiccups or rate-limit pages. Treat any parse failure as a
  // lookup miss rather than crashing the chronicle pass.
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function crossrefWorkUrl(paper) {
  const doi = String(paper?.doi || "").trim();
  if (doi) return `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const title = String(paper?.title || "").trim();
  if (!title) return null;
  return `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=1`;
}

function normalizeCrossrefResponse(response, paper) {
  const message = response?.message || {};
  const candidate = Array.isArray(message?.items) ? message.items[0] : message;
  const title = Array.isArray(candidate?.title) ? candidate.title[0] : candidate?.title;
  if (!title) return null;
  return {
    provider: "crossref",
    title: String(title),
    doi: candidate?.DOI || paper?.doi || null,
    year: Array.isArray(candidate?.issued?.["date-parts"])
      ? candidate.issued["date-parts"]?.[0]?.[0] || null
      : paper?.year || null,
    venue: Array.isArray(candidate?.["container-title"]) ? candidate["container-title"][0] : candidate?.["container-title"] || null,
    authors: Array.isArray(candidate?.author)
      ? candidate.author.map((item) => [item?.given, item?.family].filter(Boolean).join(" ").trim()).filter(Boolean)
      : [],
    url: candidate?.URL || null,
  };
}

function normalizeOpenAlexResponse(response) {
  const candidate = Array.isArray(response?.results) ? response.results[0] : response;
  const title = String(candidate?.display_name || "").trim();
  if (!title) return null;
  return {
    provider: "openalex",
    title,
    doi: String(candidate?.doi || "").replace(/^https?:\/\/doi\.org\//i, "") || null,
    year: candidate?.publication_year || null,
    venue: candidate?.primary_location?.source?.display_name || null,
    authors: Array.isArray(candidate?.authorships)
      ? candidate.authorships.map((item) => item?.author?.display_name).filter(Boolean)
      : [],
    url: candidate?.id || null,
  };
}

function fetchScholarlyMetadata({ paper, requestJson = defaultRequestJson }) {
  const crossrefUrl = crossrefWorkUrl(paper);
  if (crossrefUrl) {
    try {
      const response = requestJson(crossrefUrl);
      const normalized = normalizeCrossrefResponse(response, paper);
      if (normalized) return normalized;
    } catch {
      // fall through to OpenAlex lookup
    }
  }

  const doi = String(paper?.doi || "").trim();
  const title = String(paper?.title || "").trim();
  if (!doi && !title) return null;
  // OpenAlex needs the operator's key (src/policy/key_gates.js): off without it.
  const { sourceEnabled, sourceKey } = require("../../policy/key_gates");
  if (!sourceEnabled("openalex")) return null;
  const apiKey = sourceKey("openalex");
  const openAlexUrl = doi
    ? `https://api.openalex.org/works?filter=doi:${encodeURIComponent(`https://doi.org/${doi}`)}&per-page=1`
    : `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=1`;
  try {
    // The key as a bearer header, not in the URL (OpenAlex accepts both).
    const response = requestJson(openAlexUrl, apiKey ? [`Authorization: Bearer ${apiKey}`] : []);
    return normalizeOpenAlexResponse(response);
  } catch {
    return null;
  }
}

function enrichCitationWithScholarlyMetadata({
  paper,
  citation,
  root,
  requestJson = defaultRequestJson,
  allowExternal = process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS === "1",
}) {
  const blockedByApprovedPolicy = approvedScholarlyMetadataPolicyEnabled();
  if (!allowExternal || !root || blockedByApprovedPolicy) {
    return {
      ...citation,
      scholarly_metadata_lookup: blockedByApprovedPolicy ? "pending" : "disabled",
      ...(blockedByApprovedPolicy ? {
        scholarly_metadata_lookup_reason: "legacy_unscoped_lookup_blocked_by_approved_scholarly_metadata_policy",
      } : {}),
    };
  }

  const cacheDir = path.join(root, "cache", "scholarly-metadata");
  ensureDir(cacheDir);
  const cachePath = path.join(cacheDir, `${buildCacheKey(paper)}.json`);
  const cached = readJsonIfExists(cachePath);
  if (cached && cached.metadata) {
    const metadata = cached.metadata;
    return {
      ...citation,
      title: citation.title || metadata.title || null,
      doi: citation.doi || metadata.doi || null,
      year: citation.year || metadata.year || null,
      venue: citation.venue || metadata.venue || null,
      authors: Array.isArray(citation.authors) && citation.authors.length > 0 ? citation.authors : (metadata.authors || []),
      url: citation.url || metadata.url || null,
      verification_method: `${citation.verification_method || "metadata"}+${metadata.provider}`,
      trusted_source_count: Number(citation.trusted_source_count || 0) + 1,
      metadata_consistency_score: Number(citation.metadata_consistency_score || 0) + 2,
      verification_score: Number(citation.verification_score || 0) + 2,
      verification_status:
        citation.verification_status === "verified"
          ? "verified"
          : Number(citation.verification_score || 0) + 2 >= 8
            ? "verified"
            : "partial",
      scholarly_metadata_lookup: "cache-hit",
    };
  }

  const metadata = fetchScholarlyMetadata({
    paper,
    requestJson,
  });
  if (!metadata) {
    writeJson(cachePath, {
      cached_at: new Date().toISOString(),
      metadata: null,
      miss: true,
    });
    return {
      ...citation,
      scholarly_metadata_lookup: "miss",
    };
  }

  writeJson(cachePath, {
    cached_at: new Date().toISOString(),
    metadata,
    miss: false,
  });
  return {
    ...citation,
    title: citation.title || metadata.title || null,
    doi: citation.doi || metadata.doi || null,
    year: citation.year || metadata.year || null,
    venue: citation.venue || metadata.venue || null,
    authors: Array.isArray(citation.authors) && citation.authors.length > 0 ? citation.authors : (metadata.authors || []),
    url: citation.url || metadata.url || null,
    verification_method: `${citation.verification_method || "metadata"}+${metadata.provider}`,
    trusted_source_count: Number(citation.trusted_source_count || 0) + 1,
    metadata_consistency_score: Number(citation.metadata_consistency_score || 0) + 2,
    verification_score: Number(citation.verification_score || 0) + 2,
    verification_status:
      citation.verification_status === "verified"
        ? "verified"
        : Number(citation.verification_score || 0) + 2 >= 8
          ? "verified"
          : "partial",
    scholarly_metadata_lookup: metadata.provider,
  };
}

module.exports = {
  enrichCitationWithScholarlyMetadata,
  fetchScholarlyMetadata,
};
