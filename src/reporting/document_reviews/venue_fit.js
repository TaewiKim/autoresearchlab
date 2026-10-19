"use strict";

// The paper rubric was written for one kind of paper, and it is now reviewing
// another.
//
// cycle-g-v89 is a rendering-methods manuscript written for Computer Graphics
// Forum. Its author read the venue's instructions, recorded them, and wrote the
// single-paragraph abstract CGF asks for. The rubric then scored
// `title_abstract_framing` at 80 with "structured abstract is incomplete or too
// terse", because it requires background/methods/results/interpretation, each
// over eighty characters -- a biomedical journal convention. The manuscript was
// penalised for obeying the policy it had verified.
//
// `statistical_reporting` did the same from the other side. It looks for a "core
// concordance result" by matching /correlat|concord|recomput/ near a decimal. A
// first-crossing benchmark has no concordance statistic; it reports maximum
// crossing error, clustered false-safe risk, and a paired Wilcoxon p of 0.00020,
// each bound to a committed artifact. The requirement is not too strict, it is
// about a different measurement.
//
// This is the same shape as the modality-aware analyst standard: a requirement
// that is right for one domain phantom-fails every cycle in another. That fix
// kept the gate fail-closed and added an inapplicable path that only opens on
// evidence, and so does this one.
//
// The evidence here is the venue itself. The author's contract already requires
// reading the venue's own current guidelines and recording the URL and the date,
// and now the abstract style it states. A requirement is waived only when the
// venue was actually read and actually says otherwise. No venue record, an
// unread one, or an `unknown` answer leaves every requirement exactly where it
// was.

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

// A venue record counts as evidence only if it carries the two things that
// distinguish a policy that was read from one that was recalled.
function venueEvidence(paper) {
  const venue = paper?.target_venue;
  if (!venue || typeof venue !== "object") {
    return { read: false, name: null, abstract_style: null };
  }
  const read = text(venue.guidelines_url).length > 0 && text(venue.checked_on).length > 0;
  const style = text(venue?.format?.abstract_style).toLowerCase();
  return {
    read,
    name: text(venue.name) || null,
    guidelines_url: text(venue.guidelines_url) || null,
    checked_on: text(venue.checked_on) || null,
    abstract_style: style || null,
  };
}

function venueRequiresUnstructuredAbstract(paper) {
  const evidence = venueEvidence(paper);
  return evidence.read && evidence.abstract_style === "unstructured";
}

// What a structured abstract is for: the reader gets the question, what was done,
// what came out, and what it means. A venue that wants one paragraph still wants
// all four, so the substitute checks substance rather than waiving the section.
const UNSTRUCTURED_ABSTRACT_MIN_CHARS = 600;

function unstructuredAbstractText(abstract) {
  if (typeof abstract === "string") return abstract;
  if (!abstract || typeof abstract !== "object") return "";
  return [abstract.summary, abstract.text, abstract.body]
    .map(text)
    .filter(Boolean)
    .join(" ");
}

function abstractRequirement(paper, abstract) {
  if (!venueRequiresUnstructuredAbstract(paper)) {
    return {
      mode: "structured",
      satisfied: ["background", "methods", "results", "interpretation"].every(
        (key) => text(abstract?.[key]).length > 80,
      ),
      reason: "structured abstract is incomplete or too terse",
    };
  }
  const evidence = venueEvidence(paper);
  const body = unstructuredAbstractText(abstract);
  return {
    mode: "unstructured",
    venue: evidence.name,
    checked_on: evidence.checked_on,
    satisfied: body.length >= UNSTRUCTURED_ABSTRACT_MIN_CHARS,
    reason:
      `single-paragraph abstract is too terse for ${evidence.name || "the recorded venue"}, ` +
      "which asks for one paragraph rather than for less content",
  };
}

// Concordance is one primary result, not the only kind. What the requirement is
// actually after is a headline quantity that is bound to an artifact and stated
// with its uncertainty, so that is what the domain-neutral form asks for.
const CONCORDANCE_PATTERN =
  /(?:correlat|concord|recomput)[^"{}[\]]{0,120}(?:0\.\d{2,}|1\.0+)|(?:0\.\d{2,}|1\.0+)[^"{}[\]]{0,80}(?:correlat|concord|recomput)/i;

const UNCERTAINTY_PATTERN =
  /p\s*[=<>]|confidence interval|\b95%|upper 95|clopper|mcnemar|wilcoxon|bootstrap|standard error|credible interval/i;

function primaryQuantitativeResult(paper) {
  const manifest = asArray(paper?.numbers_manifest);
  const bound = manifest.filter(
    (entry) => text(entry?.value).length > 0 && text(entry?.source_artifact).length > 0,
  );
  const blob = JSON.stringify(paper || {});
  return {
    bound_numbers: bound.length,
    has_uncertainty: UNCERTAINTY_PATTERN.test(blob),
    // Three artifact-bound numbers is a reported result rather than an aside,
    // and the uncertainty statement is what makes it reviewable.
    satisfied: bound.length >= 3 && UNCERTAINTY_PATTERN.test(blob),
  };
}

function coreResultRequirement(paper) {
  const blob = JSON.stringify(paper || {});
  const concordance = CONCORDANCE_PATTERN.test(blob);
  if (concordance) {
    return { satisfied: true, via: "concordance", reason: null };
  }
  const quantitative = primaryQuantitativeResult(paper);
  if (quantitative.satisfied) {
    return {
      satisfied: true,
      via: "artifact_bound_primary_result",
      bound_numbers: quantitative.bound_numbers,
      reason: null,
    };
  }
  return {
    satisfied: false,
    via: null,
    bound_numbers: quantitative.bound_numbers,
    reason:
      "no core quantitative result: report either a concordance or correlation figure, or at least "
      + "three artifact-bound numbers with an uncertainty statement",
  };
}

module.exports = {
  venueEvidence,
  venueRequiresUnstructuredAbstract,
  abstractRequirement,
  coreResultRequirement,
  primaryQuantitativeResult,
  UNSTRUCTURED_ABSTRACT_MIN_CHARS,
};

// The integration check assumes one figure workflow: figures are authored as
// editable panels in a PowerPoint deck, exported flat, and inserted from the
// deck's manifest. cycle-g-v89's illustrator drew its figures from the source
// CSVs with a script it wrote -- which is exactly what the figure gate now
// requires, and it scored 100 for it -- so the same figures failed integration
// for not having come out of a deck that the target venue never asked for.
//
// One gate requiring the artifact another gate disqualifies is not a standard,
// so this reads the workflow off the venue too. A venue whose template includes
// image files is not asking for a deck; a venue that asks for editable panels
// is, and keeps the check it always had.
function venueUsesDirectFigureInsertion(paper) {
  const evidence = venueEvidence(paper);
  if (!evidence.read) return false;
  const submission = text(paper?.target_venue?.format?.figure_submission).toLowerCase();
  return submission === "direct_image_files";
}

module.exports.venueUsesDirectFigureInsertion = venueUsesDirectFigureInsertion;
