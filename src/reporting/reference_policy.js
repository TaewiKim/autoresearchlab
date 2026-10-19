"use strict";

const TRUSTED_REFERENCE_HOSTS = new Set([
  "doi.org",
  "dx.doi.org",
  "pubmed.ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "nature.com",
  "www.nature.com",
  "science.org",
  "www.science.org",
  "cell.com",
  "www.cell.com",
  "thelancet.com",
  "www.thelancet.com",
  "nejm.org",
  "www.nejm.org",
  "jamanetwork.com",
  "gut.bmj.com",
  "bmj.com",
  "www.bmj.com",
  "gastrojournal.org",
  "www.gastrojournal.org",
  "academic.oup.com",
  "onlinelibrary.wiley.com",
  "sciencedirect.com",
  "www.sciencedirect.com",
  "pubs.acs.org",
]);

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function hostForUrl(rawUrl) {
  try {
    return new URL(String(rawUrl || "").trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function inferVenue(reference) {
  const explicit = String(reference?.venue || reference?.journal || reference?.container_title || "").trim();
  if (explicit) return explicit;
  const url = String(reference?.url || "").trim();
  const host = hostForUrl(url);
  if (!host) return "";
  if (/nature\.com$/.test(host) && /s41598/i.test(url)) return "Scientific Reports";
  if (/nature\.com$/.test(host)) return "Nature Portfolio";
  if (/science\.org$/.test(host)) return "Science";
  if (/cell\.com$/.test(host)) return "Cell Press";
  if (/thelancet\.com$/.test(host)) return "The Lancet";
  if (/nejm\.org$/.test(host)) return "New England Journal of Medicine";
  if (/jamanetwork\.com$/.test(host)) return "JAMA Network";
  if (/gut\.bmj\.com$/.test(host)) return "Gut";
  if (/bmj\.com$/.test(host)) return "BMJ";
  if (/gastrojournal\.org$/.test(host)) return "Gastroenterology";
  if (/pubs\.acs\.org$/.test(host)) return "ACS";
  if (/pubmed|pmc|ncbi/.test(host)) return "PubMed/PMC indexed source";
  return host;
}

function hasPersistentIdentifier(reference) {
  return Boolean(
    String(reference?.doi || "").trim() ||
      String(reference?.pmid || "").trim() ||
      String(reference?.pmcid || "").trim(),
  );
}

function isTrustedReference(reference) {
  if (hasPersistentIdentifier(reference)) return true;
  const host = hostForUrl(reference?.url);
  return Boolean(host && TRUSTED_REFERENCE_HOSTS.has(host));
}

// Impact is read from the reference's own citation record, or from an explicit
// upstream judgment — not from a curated venue list.
//
// It used to be a whitelist of journal names and publisher URLs, and every entry
// was biomedical: Nature Medicine/Immunology, Lancet, NEJM, JAMA, BMJ, Immunity,
// Cell Host, cell.com, thelancet.com, nejm.org... With no ACM TOG, SIGGRAPH,
// IEEE TVCG, Eurographics or CGF in the list, NO reference in a graphics cycle
// could ever be high-impact — and `referenceQuality` makes "at least 2
// high-impact references" a hard blocker, so that blocker was unsatisfiable for
// the entire domain. Any fixed list has this failure for every field nobody
// enumerated.
//
// `cited_by_count` is already collected for every paper (OpenAlex/Crossref), and
// the floor is computed from the cycle's OWN reference set (see
// referenceImpactFloor), so it self-calibrates instead of importing one field's
// citation norms into another. An agent that has judged a reference important can
// still say so directly with `high_impact: true`.
function isHighImpactReference(reference, { impactCitationFloor = null } = {}) {
  if (String(reference?.type || "").toLowerCase() === "dataset") return false;
  if (reference?.high_impact === true || reference?.high_impact_venue === true) return true;
  const citations = Number(
    reference?.cited_by_count ?? reference?.citation_count ?? reference?.citations,
  );
  if (!Number.isFinite(citations)) return false;
  const floor = Number.isFinite(Number(impactCitationFloor))
    ? Number(impactCitationFloor)
    : DEFAULT_IMPACT_CITATION_FLOOR;
  return citations >= floor;
}

// Citation floor for "high impact", derived from the references at hand: the
// upper quartile of the set, never below a small absolute floor so a set of
// uncited preprints cannot promote itself. Domain-neutral by construction —
// a graphics corpus calibrates against graphics citation counts.
const DEFAULT_IMPACT_CITATION_FLOOR = 25;

function referenceImpactFloor(articles) {
  const counts = asArray(articles)
    .map((item) => Number(item?.cited_by_count ?? item?.citation_count ?? item?.citations))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (counts.length === 0) return DEFAULT_IMPACT_CITATION_FLOOR;
  const upperQuartile = counts[Math.floor(counts.length * 0.75)] ?? counts[counts.length - 1];
  return Math.max(10, Math.min(DEFAULT_IMPACT_CITATION_FLOOR, upperQuartile));
}

function normalizeReference(reference, { impactCitationFloor = null } = {}) {
  const venue = inferVenue(reference);
  const verified = isTrustedReference(reference);
  const highImpact = isHighImpactReference({ ...reference, venue }, { impactCitationFloor });
  return {
    ...reference,
    venue: reference?.venue || reference?.journal || venue || null,
    reference_verified: verified,
    reference_verification_basis: hasPersistentIdentifier(reference)
      ? "persistent_identifier"
      : isTrustedReference(reference)
        ? "trusted_source_url"
        : "unverified_metadata",
    high_impact_venue: highImpact,
    reference_tier: String(reference?.type || "").toLowerCase() === "dataset"
      ? "primary_dataset"
      : highImpact
        ? "high_impact_context"
        : verified
          ? "verified_context"
          : "unverified_context",
  };
}

function referenceQuality(references, options = {}) {
  // Calibrate "high impact" against THIS set's citation distribution before
  // classifying, so the bar comes from the field's own literature.
  const rawArticles = asArray(references).filter(
    (item) => String(item?.type || "").toLowerCase() !== "dataset",
  );
  const impactCitationFloor = Number.isFinite(Number(options.impactCitationFloor))
    ? Number(options.impactCitationFloor)
    : referenceImpactFloor(rawArticles);
  const normalized = asArray(references).map((reference) =>
    normalizeReference(reference, { impactCitationFloor }),
  );
  const articles = normalized.filter((item) => String(item?.type || "").toLowerCase() !== "dataset");
  const verifiedArticles = articles.filter((item) => item.reference_verified);
  const highImpactArticles = articles.filter((item) => item.high_impact_venue);
  const minimumReferences = Number(options.minimumReferences || 5);
  const minimumVerified = Number(options.minimumVerified || 4);
  const minimumHighImpact = Number(options.minimumHighImpact || 2);
  const blockers = [];
  if (articles.length < minimumReferences) {
    blockers.push(`reference list needs at least ${minimumReferences} article references`);
  }
  if (verifiedArticles.length < minimumVerified) {
    blockers.push(`reference list needs at least ${minimumVerified} verified DOI/PMID/PMCID/trusted-source article references`);
  }
  if (highImpactArticles.length < minimumHighImpact) {
    blockers.push(
      `reference list needs at least ${minimumHighImpact} well-cited references (>= ${impactCitationFloor} citations for this set)`,
    );
  }
  const unverified = articles
    .filter((item) => !item.reference_verified)
    .map((item) => item.title || item.url || "untitled reference");
  if (unverified.length > 0) {
    blockers.push(`unverified references remain: ${unverified.slice(0, 3).join("; ")}`);
  }
  return {
    normalized_references: normalized,
    article_reference_count: articles.length,
    verified_article_reference_count: verifiedArticles.length,
    high_impact_reference_count: highImpactArticles.length,
    blockers,
    passed: blockers.length === 0,
    policy: {
      minimum_article_references: minimumReferences,
      minimum_verified_article_references: minimumVerified,
      minimum_high_impact_references: minimumHighImpact,
      // Derived from this set's citation distribution, not a venue whitelist.
      impact_citation_floor: impactCitationFloor,
      accepted_identifiers: ["doi", "pmid", "pmcid"],
      trusted_source_hosts: Array.from(TRUSTED_REFERENCE_HOSTS).sort(),
    },
  };
}

module.exports = {
  normalizeReference,
  referenceQuality,
  isHighImpactReference,
};
