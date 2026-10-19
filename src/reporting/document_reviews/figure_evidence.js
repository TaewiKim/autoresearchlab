"use strict";

// What the figure gate could not see.
//
// The figure gate scored `tables_figures_submission_discipline`: figure count, a
// PPTX path, whether the string "svg" appears in the deck, slide count, caption
// length. Every one of those is satisfied by a figure that is wrong.
//
// On cycle-g-v89 the emitted figures included a panel titled "Query-efficiency
// threshold is cleared only by active and sham" drawn over bars showing four arms
// past the threshold it names, and a parity panel that added +0.015 to one series
// and -0.015 to the other so that two measurements of exactly 0.0 landed on
// opposite sides of the zero line -- in the figure whose whole purpose was to
// show that they are equal. Both passed the gate, because the gate was counting
// figures.
//
// Two layers here, and the second is the one that matters.
//
// The mechanical layer is cheap and fail-closed: the source artifact exists, the
// emitted image exists and is not a stub, the generator belongs to the lane that
// claims to have drawn it, and the manuscript actually cites the figure. These
// catch adoption and dangling references, and they catch nothing about whether
// the figure tells the truth.
//
// The judgement layer says so out loud. A figure asserts things in pixels -- its
// title, its annotations, its reference lines, the relative position of its marks
// -- and whether those assertions match the artifact is a reading task, not a
// predicate. So each figure raises a verification request naming the image and
// the table it must be read against, and the figure stays a blocker until a
// recorded verdict clears it. No verdict is not a pass.

const fs = require("fs");
const path = require("path");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

// A rendered figure is a few hundred KB. A file this small is an axis and no
// data, which is how an empty panel reaches a manuscript looking like a figure.
const MIN_RENDERED_IMAGE_BYTES = 4096;

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    return -1;
  }
}

// A generator under the stats tree belongs to a validation runner: the figure was
// selected from that run's diagnostics, not drawn for this manuscript.
function generatorIsAdopted(generator) {
  const normalized = String(generator || "").replace(/\\/g, "/");
  return /\/artifacts\/stats\//.test(normalized) || /\/blueprints\//.test(normalized);
}

function manuscriptText(paper) {
  const parts = [
    paper?.title,
    JSON.stringify(paper?.abstract || ""),
    JSON.stringify(asArray(paper?.sections)),
    JSON.stringify(asArray(paper?.body)),
    JSON.stringify(asArray(paper?.results)),
    JSON.stringify(asArray(paper?.discussion)),
  ];
  return parts.filter(Boolean).join(" ");
}

function figureIdentity(figure, index) {
  return String(figure?.id || figure?.figure_id || `figure-${index + 1}`);
}

// The verdict store. A gatekeeper writes here after reading an image against its
// source table; anything absent from it is unverified, which is a blocker.
function readVerdicts({ root, cycleId }) {
  const filePath = path.join(root, "state", `${cycleId}-figure-verification.json`);
  const stored = readJsonIfExists(filePath);
  const map = new Map();
  for (const entry of asArray(stored?.verdicts)) {
    const id = String(entry?.figure_id || "");
    if (id) map.set(id, entry);
  }
  return { path: filePath, map };
}

function verdictClears(verdict) {
  if (!verdict || typeof verdict !== "object") return false;
  if (verdict.verified !== true) return false;
  // A verdict that names no evidence is an opinion. The reviewer has to say what
  // it compared, or the figure is not verified.
  return String(verdict.checked_against || "").trim().length > 0;
}

// These checks are about figures a lane DREW for this manuscript: they ask which
// script produced the image and whether the drawing matches the artifact. The
// template path builds figure_panels from a slide manifest, where "the generator
// belongs to this lane" has no meaning, so the deck rubric keeps governing there
// exactly as before. A lane-authored document with no figure set is a blocker;
// a template document is left to the rubric that was already reviewing it.
function laneAuthored(paper) {
  return paper?.document_source === "lane-authored";
}

function figureEvidenceChecks({ root, cycleId, paper }) {
  const figures = asArray(paper?.figures);
  const prose = manuscriptText(paper);
  const verdicts = readVerdicts({ root, cycleId });

  const checks = [];
  const blockers = [];
  const verificationRequests = [];

  if (!figures.length) {
    if (!laneAuthored(paper)) {
      return {
        checks: [],
        blockers: [],
        verification_requests: [],
        verdict_store: verdicts.path,
        applicable: false,
      };
    }
    return {
      checks: [
        {
          figure_id: null,
          check: "figure_inventory",
          passed: false,
          detail: "the manuscript carries no figure set",
        },
      ],
      blockers: ["manuscript carries no figures to audit"],
      verification_requests: [],
      verdict_store: verdicts.path,
      applicable: true,
    };
  }

  figures.forEach((figure, index) => {
    const id = figureIdentity(figure, index);
    const sourceArtifact =
      figure?.source_artifact || figure?.source_table || asArray(figure?.source_tables)[0] || null;
    const generator = figure?.generator || null;
    const imagePath = figure?.path || figure?.image_path || null;

    const record = (check, passed, detail) => {
      checks.push({ figure_id: id, check, passed, detail });
      if (!passed) blockers.push(`${id}: ${detail}`);
    };

    record(
      "source_artifact_exists",
      Boolean(sourceArtifact) && fs.existsSync(sourceArtifact),
      sourceArtifact
        ? `source artifact is not on disk (${sourceArtifact})`
        : "figure names no source artifact",
    );

    const size = imagePath ? fileSize(imagePath) : -1;
    record(
      "rendered_image_present",
      size >= MIN_RENDERED_IMAGE_BYTES,
      imagePath
        ? `rendered image is missing or too small to contain data (${size} bytes)`
        : "figure names no emitted image",
    );

    record(
      "generator_is_the_lane_s_own",
      Boolean(generator) && !generatorIsAdopted(generator),
      generator
        ? `generator ${generator} belongs to a validation runner, so this figure was selected rather than drawn`
        : "figure names no generator",
    );

    record(
      "cited_in_manuscript",
      prose.includes(id),
      `figure is not cited anywhere in the manuscript text`,
    );

    // Layout is measurable, so it is checked rather than reviewed. A figure whose
    // labels collide is unreadable even when every number in it is right, and the
    // deck workflow that used to check this (font size, overlap count,
    // out-of-bounds boxes) only ever applied to PowerPoint text boxes -- a figure
    // drawn by a script had nothing looking at it.
    const layout = figure?.layout_check;
    if (!layout || typeof layout !== "object") {
      record(
        "layout_measured",
        false,
        "figure reports no layout_check, so text collisions and clipping are unmeasured",
      );
    } else {
      const collisions =
        Number(layout.text_overlaps || 0) + Number(layout.text_over_data_overlaps || 0);
      const clipped = Number(layout.clipped_artists || 0);
      record(
        "layout_has_no_collisions",
        collisions === 0 && clipped === 0,
        `figure layout has ${collisions} text collision(s) and ${clipped} clipped artist(s)`,
      );
      // Below eight points a label is unreadable at print size, which is the
      // threshold the deck check used and the one reviewers actually apply.
      const minFont = Number(layout.min_font_pt || 0);
      record(
        "layout_labels_are_legible",
        minFont >= 8,
        `figure has text at ${minFont} pt, below the 8 pt print-legibility floor`,
      );
    }

    // The reading task. Everything above can pass on a figure that asserts
    // something its data refutes.
    const verdict = verdicts.map.get(id);
    const cleared = verdictClears(verdict);
    checks.push({
      figure_id: id,
      check: "on_image_claims_verified_against_source",
      passed: cleared,
      detail: cleared
        ? `verified against ${verdict.checked_against}`
        : "no recorded verdict comparing the drawn figure against its source artifact",
      verdict: verdict || null,
    });
    if (!cleared) {
      blockers.push(
        `${id}: on-image claims have not been verified against ${sourceArtifact || "the source artifact"}`,
      );
      verificationRequests.push({
        request_id: "figure_claim_verification",
        figure_id: id,
        priority: "high",
        required_for_gate: true,
        preferred_role: "gatekeeper",
        image_path: imagePath,
        source_artifact: sourceArtifact,
        generator,
        caption: figure?.caption || null,
        claim_carried: figure?.claim_carried || null,
        reference_marks: asArray(figure?.reference_marks),
        objective:
          `open ${imagePath || "the emitted image"} and read every assertion it makes in pixels - panel titles, ` +
          "annotations, reference lines, and the relative position of marks - against " +
          `${sourceArtifact || "its source artifact"}. A title that the panel's own marks refute, ` +
          "or an offset that separates values the table records as equal, is a failed verification.",
        verdict_contract: {
          write_to: verdicts.path,
          shape: {
            figure_id: id,
            verified: "true only when every on-image assertion is supported by the source artifact",
            checked_against: "the artifact path and the columns you read",
            discrepancies: "each on-image assertion the artifact does not support",
          },
        },
      });
    }
  });

  return {
    checks,
    blockers,
    verification_requests: verificationRequests,
    verdict_store: verdicts.path,
    applicable: true,
  };
}

// Routed to the gatekeeper, not the illustrator: the lane that drew the figure is
// not the lane that should certify it.
function figureVerificationFollowupActions(verificationRequests) {
  return asArray(verificationRequests).map((item) => ({
    type: "figure_claim_verification",
    priority: "high",
    preferred_role: "gatekeeper",
    target_document: "paper",
    target_rubric: "figure_evidence",
    // The request carries this; the action used to drop it. A gate-required
    // document action scores 9,900 in the task graph and everything else
    // competes in the low hundreds, so losing the flag is the difference between
    // dispatched next and dispatched eventually.
    required_for_gate: item?.required_for_gate === true,
    blocker_reasons: [
      `figure ${item.figure_id} has not been read against ${item.source_artifact || "its source artifact"}`,
    ],
    description: `verify the drawn figure against its source artifact: ${item.figure_id}`,
    figure_verification_request: item,
  }));
}

// A figure nobody cites is the author's to fix -- it is a sentence in the
// manuscript text, not a redraw. On cycle-g-v89 three such blockers stood with
// no action of any kind behind them: a score cap nobody had been asked to lift.
function figureCitationFollowupActions(checks) {
  // The recorded shape is one flat row per check -- {figure_id, check, detail,
  // passed} -- not a figure carrying a list of its own. Verified against the 21
  // rows cycle-g-v89 had recorded when this was written.
  const uncited = new Map();
  for (const row of asArray(checks)) {
    if (row?.check !== "cited_in_manuscript" || row?.passed !== false) continue;
    const id = String(row?.figure_id || "").trim();
    if (id && !uncited.has(id)) uncited.set(id, row);
  }
  return [...uncited.values()]
    .map((check) => ({
      type: "manuscript_standard_followup",
      priority: "critical",
      preferred_role: "author",
      target_document: "paper",
      target_rubric: "figure_evidence",
      required_for_gate: true,
      blocker_reasons: [`${check.figure_id}: figure is not cited anywhere in the manuscript text`],
      description:
        `cite ${check.figure_id} in the manuscript text where it carries its claim, by its exact id, `
        + "and say in that sentence what the reader should take from it. A figure the text never "
        + "refers to is decoration the venue will ask you to remove",
    }));
}

module.exports = {
  figureCitationFollowupActions,
  figureEvidenceChecks,
  figureVerificationFollowupActions,
  generatorIsAdopted,
  verdictClears,
  MIN_RENDERED_IMAGE_BYTES,
};
