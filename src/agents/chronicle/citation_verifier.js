"use strict";

// Trust comes from provenance, not from the publisher's name.
//
// This was a list of thirty hostnames. Four of them were medical journals; not
// one was a computer-science venue, so a citation resolving through an ACM or
// IEEE library read as untrusted while one through a medical journal read as
// trusted, on a cycle in any field. That is the venue whitelist this project
// has already been bitten by, in the one place that decides whether a citation
// counts.
//
// What actually makes a citation checkable is field-independent and is recorded
// on the paper itself:
//
//   a persistent identifier   anyone can resolve it, whoever published it
//   a retrieval receipt       a provider returned this record, and the record
//                             says which one
//
// Both are present in the real shape: of 116 papers on one cycle-g-v89 scout
// lane, 116 carried `source` and 43 carried a DOI, and the only hosts that
// appeared at all were an identifier resolver and a preprint archive. A bare
// URL with neither is untrusted no matter whose domain it sits on.

// Identifier fields a record may carry. These are resolvers, not venues: each
// one is a name someone else can look up. Adding a registry here is adding a
// way to CHECK a citation, never a way to privilege a field.
const PERSISTENT_IDENTIFIER_FIELDS = ["doi", "arxiv_id", "openalex_id", "pmid", "pmcid", "semantic_scholar_id"];

function retrievalReceipt(paper) {
  // Which provider returned this record. Set by the search driver for every
  // paper it admits, so its presence means the cycle actually retrieved this
  // rather than an agent recalling it.
  const source = String(paper?.source || "").trim();
  return source || null;
}

function hasPersistentIdentifier(paper) {
  return PERSISTENT_IDENTIFIER_FIELDS.some((field) => String(paper?.[field] || "").trim());
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function slugify(value, fallback = "item") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function extractHost(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hasPersistentIdentifier(paper) {
  return Boolean(
    String(paper?.doi || "").trim() ||
    String(paper?.pmid || "").trim() ||
    String(paper?.pmcid || "").trim() ||
    String(paper?.arxiv_id || "").trim() ||
    String(paper?.semantic_scholar_id || "").trim(),
  );
}

function normalizeVerificationSources(paper) {
  const sources = [];
  const urlCandidates = [
    paper?.url,
    paper?.source_url,
    paper?.landing_page_url,
  ];
  for (const url of urlCandidates) {
    const value = String(url || "").trim();
    const host = extractHost(value);
    if (!value || !host) continue;
    sources.push({
      kind: "url",
      value,
      host,
      // The URL is trusted because THIS RECORD is provenanced -- a provider
      // returned it, or it carries an identifier anyone can resolve -- not
      // because of the host it points at.
      trusted: Boolean(retrievalReceipt(paper)) || hasPersistentIdentifier(paper),
      provenance: retrievalReceipt(paper),
    });
  }
  for (const entry of asArray(paper?.verification_sources)) {
    const value = String(entry?.value || entry?.url || entry?.doi || entry || "").trim();
    const host = extractHost(value);
    sources.push({
      kind: entry?.kind || (host ? "url" : "metadata"),
      value,
      host,
      trusted: host
        ? Boolean(retrievalReceipt(paper)) || hasPersistentIdentifier(paper)
        : Boolean(entry?.trusted),
    });
  }
  if (paper?.doi) {
    sources.push({
      kind: "doi",
      value: String(paper.doi).trim(),
      host: "doi.org",
      trusted: true,
    });
  }
  // Every other recorded identifier, on the same footing as the DOI above. The
  // previous version listed exactly one of them -- one field's registry -- and
  // granted it automatic trust while an identifier from any other registry got
  // none.
  for (const field of PERSISTENT_IDENTIFIER_FIELDS) {
    if (field === "doi") continue;
    const value = String(paper?.[field] || "").trim();
    if (!value) continue;
    sources.push({ kind: field, value, host: null, trusted: true });
  }
  return sources.filter((entry) => entry.value);
}

function bibliographicCompleteness(paper) {
  const title = String(paper?.title || "").trim();
  const authors = asArray(paper?.authors).map((item) => String(item || "").trim()).filter(Boolean);
  const abstract = String(paper?.abstract || paper?.abstract_snippet || "").trim();
  const venue = String(paper?.venue || "").trim();
  const year = Number(paper?.year);
  let score = 0;
  const notes = [];

  if (title) {
    score += 2;
    notes.push("title present");
  } else {
    notes.push("title missing");
  }
  if (authors.length > 0) {
    score += 1;
    notes.push("authors present");
  }
  if (Number.isFinite(year) && year > 1900) {
    score += 1;
    notes.push("year present");
  }
  if (abstract) {
    score += 1;
    notes.push("abstract present");
  }
  if (venue) {
    score += 1;
    notes.push("venue present");
  }
  if (hasPersistentIdentifier(paper)) {
    score += 2;
    notes.push("persistent identifier present");
  }
  return { score, notes };
}

function metadataConsistency(paper, sources) {
  const title = String(paper?.title || "").trim();
  const authors = asArray(paper?.authors).map((item) => String(item || "").trim()).filter(Boolean);
  const year = Number(paper?.year);
  const venue = String(paper?.venue || "").trim();
  const trustedSources = sources.filter((entry) => entry.trusted);
  // Read from the one list, not a second copy of it. The regex here was its own
  // enumeration and had already drifted: it matched `arxiv` where the source is
  // tagged `arxiv_id`, and knew nothing of `openalex_id`, so two identifiers
  // that make a citation checkable were counted as no identifier at all.
  const persistentSources = sources.filter((entry) =>
    PERSISTENT_IDENTIFIER_FIELDS.includes(String(entry.kind || "").toLowerCase()),
  );
  let score = 0;
  const notes = [];

  if (title && (authors.length > 0 || Number.isFinite(year))) {
    score += 1;
    notes.push("title corroborated by authors/year");
  }
  if (trustedSources.length > 0 && title) {
    score += 2;
    notes.push("title backed by trusted source");
  }
  if (trustedSources.length > 0 && (authors.length > 0 || Number.isFinite(year) || venue)) {
    score += 1;
    notes.push("trusted source aligned with bibliographic metadata");
  }
  if (persistentSources.length > 0) {
    score += 2;
    notes.push("persistent identifier available");
  }
  if (persistentSources.length > 0 && trustedSources.length > 0) {
    score += 1;
    notes.push("identifier and trusted source cross-check each other");
  }
  if (sources.length >= 2) {
    score += 1;
    notes.push("multiple metadata sources observed");
  }

  return {
    score,
    notes,
    trusted_source_count: trustedSources.length,
    persistent_source_count: persistentSources.length,
  };
}

function deriveVerificationMethod({ consistency, completeness }) {
  if (consistency.persistent_source_count > 0 && consistency.trusted_source_count > 0) {
    return "persistent_identifier_plus_trusted_source";
  }
  if (consistency.persistent_source_count > 0) {
    return "persistent_identifier";
  }
  if (consistency.trusted_source_count > 0 && completeness.score >= 4) {
    return "trusted_source_metadata";
  }
  if (completeness.score >= 4) {
    return "bibliographic_consistency";
  }
  return "weak_metadata";
}

function verifyCitation(paper, index) {
  const title = String(paper?.title || "").trim();
  const doi = String(paper?.doi || "").trim();
  const year = Number(paper?.year);
  const abstract = String(paper?.abstract || paper?.abstract_snippet || "").trim();
  const authors = asArray(paper?.authors).map((item) => String(item).trim()).filter(Boolean);
  const url = String(paper?.url || paper?.source_url || "").trim();
  const venue = String(paper?.venue || "").trim();
  const sources = normalizeVerificationSources(paper);
  const completeness = bibliographicCompleteness(paper);
  const consistency = metadataConsistency(paper, sources);
  const verificationScore = completeness.score + consistency.score;
  const verificationStatus =
    verificationScore >= 8 || (consistency.persistent_source_count > 0 && verificationScore >= 6)
      ? "verified"
      : verificationScore >= 5
        ? "partial"
        : "weak";

  return {
    citation_id: `citation:${slugify(doi || title, String(index + 1))}`,
    title: title || `Untitled paper ${index + 1}`,
    year: Number.isFinite(year) ? year : null,
    doi: doi || null,
    url: url || null,
    venue: venue || null,
    authors: authors.slice(0, 6),
    abstract_snippet: abstract ? abstract.slice(0, 280) : null,
    verification_score: verificationScore,
    verification_status: verificationStatus,
    verification_method: deriveVerificationMethod({
      consistency,
      completeness,
    }),
    verification_source_count: sources.length,
    trusted_source_count: consistency.trusted_source_count,
    persistent_source_count: consistency.persistent_source_count,
    metadata_completeness_score: completeness.score,
    metadata_consistency_score: consistency.score,
    verification_notes: [...completeness.notes, ...consistency.notes],
  };
}

module.exports = {
  verifyCitation,
};
