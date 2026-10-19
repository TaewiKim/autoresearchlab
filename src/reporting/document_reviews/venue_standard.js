"use strict";

// The paper gate held one bar for every venue, and it was not the bar of the
// venue the manuscript was actually written for.
//
// cycle-g-v89 passed at 92 against a fixed threshold of 90, targeting ACM
// Transactions on Graphics. Read as a TOG submission it is not close, and the
// reasons are all measurable:
//
//   * A severity-label sham -- no rendering information at all -- reproduced the
//     proposed method's result exactly on every held-family seed. The gate had
//     nothing that says a mechanism claim cannot survive a control that
//     reproduces it.
//   * The evaluation is 64x64 images at 8 spp on six procedural Cornell-box
//     families. The gate never compared that against what the venue's own papers
//     evaluate on.
//   * Two central comparators are image-space proxies, which the manuscript says
//     plainly, rather than implementations.
//   * Seven references.
//
// So the standard is calibrated to the venue. Three rules govern how, because
// each of them is a trap this project has already fallen into.
//
// NO VENUE TABLE. A hardcoded list of venues and their bars fails for every
// venue nobody enumerated, exactly as the biomedical reporting rubrics failed
// every graphics cycle and the high-impact venue whitelist made high impact
// unreachable for the entire field. Everything here comes from what the author
// recorded FROM the venue, with a URL and a date, the same evidence shape
// venue_fit.js already requires.
//
// NAMING A VENUE OBLIGES YOU TO READ IT. venue_fit waives a requirement only on
// evidence; this fails closed in the other direction. A manuscript that names a
// venue and records nothing about its standard gets a finding, because "we are
// submitting to TOG" is a claim about a bar, and an unrecorded bar cannot be
// met or missed.
//
// EVIDENCE RAISES THE BAR, NEVER LOWERS IT. The owner's threshold of 80 is the
// floor. A venue that publishes a 60% acceptance rate does not buy a cheaper
// gate -- retargeting to an easier venue would otherwise be the fastest way to
// pass, and this project has already watched a scoreFloor artifact overwrite an
// honest novelty of 20-42 with 95.

const { referenceQuality } = require("../reference_policy");

const { GATE_THRESHOLD: BASE_GATE_THRESHOLD } = require("../../policy/research_gate");
const BASE_MINIMUM_REFERENCES = 5;
const BASE_MINIMUM_VERIFIED = 4;
const BASE_MINIMUM_HIGH_IMPACT = 2;

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function finiteRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return null;
  // Accept either a fraction or a percentage, since a venue publishes it both
  // ways and an author copying "17%" should not be read as 1700% selective.
  const normalized = rate > 1 ? rate / 100 : rate;
  if (!(normalized > 0) || normalized > 1) return null;
  return normalized;
}

/**
 * What the author recorded about the venue's own standard. Read, not recalled:
 * the same URL-and-date test venue_fit applies to the submission guidelines.
 */
function venueStandardEvidence(paper) {
  const venue = paper?.target_venue;
  const name = text(venue?.name) || null;
  const standard = venue?.standard && typeof venue.standard === "object" ? venue.standard : null;
  const read =
    Boolean(standard) &&
    text(standard.source_url).length > 0 &&
    text(standard.checked_on).length > 0;
  return {
    venue_named: Boolean(name),
    name,
    read,
    acceptance_rate: read ? finiteRate(standard.acceptance_rate) : null,
    source_url: read ? text(standard.source_url) : null,
    checked_on: read ? text(standard.checked_on) : null,
    evaluation_norm: read && standard.evaluation_norm && typeof standard.evaluation_norm === "object"
      ? standard.evaluation_norm
      : null,
    accepts_contribution_types: read ? asArray(standard.accepts_contribution_types).map((item) => text(item).toLowerCase()) : [],
  };
}

/**
 * The bar this manuscript is held to, derived from the venue's own published
 * selectivity. Monotone in one number so it stays explainable: the more a venue
 * turns away, the more it expects of what it keeps.
 */
function calibratedPaperStandard(paper) {
  const evidence = venueStandardEvidence(paper);
  const rate = evidence.acceptance_rate;
  if (rate == null) {
    return {
      basis: evidence.venue_named ? "venue named, standard not recorded" : "no venue recorded",
      calibrated: false,
      acceptance_rate: null,
      gate_threshold: BASE_GATE_THRESHOLD,
      minimum_references: BASE_MINIMUM_REFERENCES,
      minimum_verified: BASE_MINIMUM_VERIFIED,
      minimum_high_impact: BASE_MINIMUM_HIGH_IMPACT,
      evidence,
    };
  }
  const selectivity = 1 - rate;
  const minimumReferences = Math.max(BASE_MINIMUM_REFERENCES, Math.round(30 * selectivity));
  return {
    basis: `${evidence.name} publishes an acceptance rate of ${(rate * 100).toFixed(0)}% (${evidence.source_url}, read ${evidence.checked_on})`,
    calibrated: true,
    acceptance_rate: rate,
    // Never below the owner's floor: a lenient venue does not buy a cheaper gate.
    gate_threshold: Math.max(BASE_GATE_THRESHOLD, Math.round(84 + 16 * selectivity)),
    minimum_references: minimumReferences,
    minimum_verified: Math.max(BASE_MINIMUM_VERIFIED, Math.round(minimumReferences * 0.8)),
    minimum_high_impact: Math.max(BASE_MINIMUM_HIGH_IMPACT, Math.round(minimumReferences / 5)),
    evidence,
  };
}

function contributionType(paper) {
  return text(paper?.contribution_type).toLowerCase() || null;
}

/**
 * Findings the venue's own standard produces about this manuscript. Each one is
 * a blocker: they are not score deductions, because a manuscript that claims a
 * mechanism its own control refutes does not become acceptable at a higher
 * score.
 */
function venueStandardFindings(paper) {
  const findings = [];
  if (!paper) return findings;
  const standard = calibratedPaperStandard(paper);
  const evidence = standard.evidence;

  if (evidence.venue_named && !evidence.read) {
    findings.push(
      `target venue ${evidence.name} is named but its standard was never read: record `
      + "target_venue.standard with source_url, checked_on, the acceptance rate the venue "
      + "publishes, what its own recent papers evaluate on, and which contribution types it accepts",
    );
  }

  // The v89 catch. A control that reproduces your result has removed your
  // mechanism, whatever the headline number says.
  //
  // The resolution is the experiment that separates them, and ONLY that.
  // Reframing the paper as a benchmark would let the manuscript keep the same
  // evidence and lower the claim until it fits, which is the retreat this gate
  // exists to stop -- see claim_strength.js. The finding therefore asks for the
  // discriminating measurement and routes it to the director, who decides
  // whether the cycle runs it.
  const reproducingControls = asArray(paper.controls_that_reproduce_the_result).map(text).filter(Boolean);
  const type = contributionType(paper);
  if (reproducingControls.length) {
    // The check used to fire only for contribution_type "method", and the first
    // manuscript it ran against answered by declaring "benchmark" and changing
    // nothing else -- no controls listed, no experiment requested, the body
    // byte-identical. Relabelling is the retreat this exists to stop, so the
    // finding no longer depends on the label.
    //
    // Two exits, both of which cost something. Ask for the experiment that
    // separates the arm from the control, or withdraw the claim the control
    // reproduced. Neither is satisfied by renaming the paper.
    const requestedAnExperiment = asArray(paper.additional_experiments_requested).length > 0;
    const withdrawn = asArray(paper.withdrawn_claims).map((item) => text(item).toLowerCase());
    const allWithdrawn = reproducingControls.every((control) =>
      withdrawn.some((claim) => claim.includes(control.toLowerCase())),
    );
    if (!requestedAnExperiment && !allWithdrawn) {
      findings.push(
        `${reproducingControls.length} control(s) reproduce the reported result `
        + `(${reproducingControls.join("; ")}), so nothing yet shows that arm contributes anything. `
        + "Either request the experiment that separates them -- a condition where the control must fail "
        + "and the arm must not -- through additional_experiments_requested, or withdraw the claim the "
        + "control reproduced and record it in withdrawn_claims. Restating the same evidence under a "
        + `different contribution_type is not a resolution${type ? ` (this one declares "${type}")` : ""}`,
      );
    }
  }

  if (type && evidence.accepts_contribution_types.length && !evidence.accepts_contribution_types.includes(type)) {
    findings.push(
      `${evidence.name} does not accept a ${type} paper by the venue's own recorded scope `
      + `(it accepts ${evidence.accepts_contribution_types.join(", ")}): change the venue or the framing`,
    );
  }

  // Proxies of prior work are a standard reject at a selective venue, and the
  // manuscript is the thing that knows which comparators were implemented.
  const proxies = asArray(paper.baselines)
    .filter((item) => text(item?.kind).toLowerCase() === "proxy")
    .map((item) => text(item?.name) || "unnamed baseline");
  if (evidence.read && type === "method" && proxies.length) {
    findings.push(
      `${proxies.length} comparator(s) are image- or code-level PROXIES rather than implementations `
      + `(${proxies.join("; ")}); a method claim at ${evidence.name} is measured against the real thing`,
    );
  }

  // Scale is the author's own comparison against what the venue publishes, which
  // is why the norm has to be recorded first.
  if (evidence.read) {
    const scale = paper.evaluation_scale && typeof paper.evaluation_scale === "object" ? paper.evaluation_scale : null;
    if (!evidence.evaluation_norm) {
      findings.push(
        `no evaluation norm was recorded for ${evidence.name}: read what its own recent papers evaluate on `
        + "(scenes, resolution, sample counts, scale) and record it with the papers you read",
      );
    } else if (!scale || scale.matches_venue_norm !== true) {
      findings.push(
        `the evaluation does not meet ${evidence.name}'s own norm `
        + `(${text(evidence.evaluation_norm.described) || "recorded norm"}): `
        + (scale?.described ? `this manuscript evaluates on ${text(scale.described)}. ` : "")
        + (text(scale?.why) || "state what would have to be measured to reach it, or change the venue"),
      );
    }
  }

  // The reference floor moves with the venue, and it is reported as the venue's
  // number rather than as a bare count so the author knows where it came from.
  const references = asArray(paper.references);
  if (standard.calibrated) {
    const quality = referenceQuality(references, {
      minimumReferences: standard.minimum_references,
      minimumVerified: standard.minimum_verified,
      minimumHighImpact: standard.minimum_high_impact,
    });
    if (references.length < standard.minimum_references) {
      findings.push(
        `the reference list holds ${references.length} entries; ${evidence.name} at a `
        + `${(standard.acceptance_rate * 100).toFixed(0)}% acceptance rate expects at least `
        + `${standard.minimum_references}, including the work this result would be read against`,
      );
    } else if (quality.high_impact_reference_count < standard.minimum_high_impact) {
      findings.push(
        `${quality.high_impact_reference_count} of the references are well cited; this venue's `
        + `calibrated floor is ${standard.minimum_high_impact}`,
      );
    }
  }

  return findings;
}

module.exports = {
  BASE_GATE_THRESHOLD,
  venueStandardEvidence,
  calibratedPaperStandard,
  venueStandardFindings,
};
