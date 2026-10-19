"use strict";

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function dedupeStrings(values, limit = Infinity) {
  const seen = new Set();
  const items = [];
  for (const value of asArray(values)) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

function normalizeProfile(profile = {}) {
  const preferredSectionOrder = asArray(profile.preferred_section_order);
  return {
    profile_id: profile.profile_id || "general_research",
    label: profile.label || "General Research",
    style_family: profile.style_family || "general",
    outline_strategy: profile.outline_strategy || "default",
    drafting_emphasis: dedupeStrings(profile.drafting_emphasis || [], 6),
    preferred_section_order: preferredSectionOrder.length > 0
      ? preferredSectionOrder
      : ["motivation-gap", "mechanism-rivals", "measurement-design", "evidence-frontier", "novelty-comparison"],
  };
}

function inferVenueProfile({ papers = [], explicitProfile = null } = {}) {
  if (explicitProfile && typeof explicitProfile === "object") {
    return normalizeProfile(explicitProfile);
  }

  let medicalCount = 0;
  let machineLearningCount = 0;
  let policyCount = 0;

  for (const paper of asArray(papers)) {
    const venue = String(paper?.venue || "").toLowerCase();
    const title = String(paper?.title || "").toLowerCase();
    const blob = `${venue} ${title}`;
    if (/lancet|nejm|jama|bmj|clinical|medicine|epidemiology|public health/.test(blob)) {
      medicalCount += 1;
    }
    if (/icml|iclr|machine learning|representation learning|artificial intelligence/.test(blob)) {
      machineLearningCount += 1;
    }
    if (/policy|health systems|implementation science|economics/.test(blob)) {
      policyCount += 1;
    }
  }

  if (medicalCount >= machineLearningCount && medicalCount >= policyCount && medicalCount > 0) {
    return normalizeProfile({
      profile_id: "medical_observational",
      label: "Medical Observational",
      style_family: "medical",
      outline_strategy: "measurement_before_mechanism",
      drafting_emphasis: [
        "measurement validity",
        "bias control",
        "clinical or public-health interpretation",
      ],
      preferred_section_order: [
        "motivation-gap",
        "measurement-design",
        "mechanism-rivals",
        "evidence-frontier",
        "novelty-comparison",
      ],
    });
  }

  if (machineLearningCount > 0 && machineLearningCount >= policyCount) {
    return normalizeProfile({
      profile_id: "ml_submission",
      label: "ML Submission",
      style_family: "technical",
      outline_strategy: "novelty_early",
      drafting_emphasis: [
        "novelty claim",
        "comparison to prior work",
        "ablation or robustness framing",
      ],
      preferred_section_order: [
        "motivation-gap",
        "novelty-comparison",
        "mechanism-rivals",
        "measurement-design",
        "evidence-frontier",
      ],
    });
  }

  if (policyCount > 0) {
    return normalizeProfile({
      profile_id: "policy_evaluation",
      label: "Policy Evaluation",
      style_family: "policy",
      outline_strategy: "decision_first",
      drafting_emphasis: [
        "decision relevance",
        "implementation constraints",
        "confounding and generalizability",
      ],
      preferred_section_order: [
        "motivation-gap",
        "evidence-frontier",
        "mechanism-rivals",
        "measurement-design",
        "novelty-comparison",
      ],
    });
  }

  return normalizeProfile();
}

function shapeSectionOutlineForVenue({ sections = [], venueProfile = null } = {}) {
  const profile = normalizeProfile(venueProfile || {});
  const order = new Map(profile.preferred_section_order.map((sectionId, index) => [sectionId, index]));
  return asArray(sections)
    .map((section) => ({
      ...section,
      venue_profile_id: profile.profile_id,
      venue_emphasis: profile.drafting_emphasis,
    }))
    .sort((left, right) =>
      (order.get(left.section_id) ?? 999) - (order.get(right.section_id) ?? 999) ||
      String(left.title || "").localeCompare(String(right.title || "")),
    );
}

function mergeVenueProfiles(profiles = []) {
  const counts = new Map();
  let representative = null;
  for (const profile of asArray(profiles)) {
    const normalized = normalizeProfile(profile);
    const key = normalized.profile_id;
    const current = counts.get(key) || { count: 0, profile: normalized };
    current.count += 1;
    counts.set(key, current);
  }
  for (const item of counts.values()) {
    if (!representative || item.count > representative.count) {
      representative = item;
    }
  }
  return representative ? representative.profile : normalizeProfile();
}

module.exports = {
  inferVenueProfile,
  mergeVenueProfiles,
  normalizeProfile,
  shapeSectionOutlineForVenue,
};
