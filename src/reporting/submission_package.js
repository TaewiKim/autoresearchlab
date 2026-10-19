"use strict";

// What gets submitted was never assembled anywhere.
//
// The runtime produces a manuscript (json/md/tex/pdf), a report, figures under a
// lane directory, supplementary items listed inside the paper JSON, and the CSVs
// the numbers were computed from -- each in its own place, none of them gathered
// into the thing a venue actually receives. A reviewer downloading this work
// would get whichever file someone happened to attach.
//
// Owner specification: a submission package contains the manuscript, the
// supplementary material, the artifacts, optionally a demo, and optionally a
// cover letter. This assembles exactly that and reports what is missing, so an
// incomplete package is a gate finding rather than something discovered at
// submission time.
//
// Two things it deliberately checks beyond presence.
//
// The artifacts are not "every file the cycle produced" -- they are the files the
// manuscript's own numbers_manifest and figures cite. A package carrying
// unrelated CSVs is padding; one missing a cited artifact cannot be checked by a
// reviewer, which is the whole point of shipping them.
//
// And anonymity travels with the package. The manuscript body currently prints
// absolute paths under `/opt/researchlab/.research-lab/...`, and the artifacts
// are named by those same paths. At a double-anonymous venue that hands the
// reviewer the submitting group's directory layout, so the package records the
// leak rather than quietly bundling it.

const fs = require("fs");
const path = require("path");
const { ensureDir, writeJson } = require("../shared/json");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function fileEntry(filePath, role) {
  const exists = Boolean(filePath) && fs.existsSync(filePath);
  return {
    role,
    path: filePath || null,
    present: exists,
    bytes: exists ? fs.statSync(filePath).size : 0,
  };
}

// What identifies the submitting group, derived rather than listed.
//
// This was a literal alternation of this deployment's own paths, container image
// name and lane-id shapes. That is the failure mode this project keeps paying
// for: a fixed list matches only the installation somebody wrote it against, and
// silently passes everything else -- another runtime root, another cycle naming
// scheme, another lane prefix -- while looking like a check.
//
// The real definition needs no list. A leak is an absolute path on the machine
// that produced the work, or this cycle's own identifier, appearing in text a
// reviewer reads.
function escapeForRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An absolute path in either shell's shape, which is what a machine path looks
// like whatever the installation is called.
const ABSOLUTE_PATH = "(?:^|[\\s\"'`(])(?:/[^\\s\"'`)]{2,}|[A-Za-z]:[\\\\/][^\\s\"'`)]{2,})";

function identifyingPattern({ root, cycleId }) {
  const literals = [text(root), text(cycleId)].filter(Boolean).map(escapeForRegExp);
  return new RegExp([ABSOLUTE_PATH, ...literals].join("|"), "i");
}

// What a reviewer actually receives, which is not the same as what the paper
// JSON holds. `source_artifact`, `generator` and `path` are the packager's own
// fields -- it opens them to find the file and ships it under a neutral bundle
// name -- so a machine path there is a record, not a leak, and that is exactly
// the distinction the author was asked to keep. Scanning the whole object flagged
// 50 of those internal paths as a disclosure while never once looking at the
// manuscript body or the reference list, which is where the real leak was found.
function reviewerVisibleText(paper) {
  const parts = [
    text(paper?.title),
    JSON.stringify(paper?.abstract || ""),
    JSON.stringify(paper?.introduction || []),
    JSON.stringify(paper?.methods || []),
    JSON.stringify(paper?.results || []),
    JSON.stringify(paper?.discussion || []),
    JSON.stringify(paper?.limitations || []),
    JSON.stringify(paper?.data_code_availability || []),
    JSON.stringify(paper?.references || []),
  ];
  for (const item of asArray(paper?.supplementary_material)) {
    parts.push(text(item?.id), text(item?.title), text(item?.kind), text(item?.what_it_contains));
  }
  for (const figure of asArray(paper?.figures)) {
    parts.push(text(figure?.caption), text(figure?.claim_carried), text(figure?.why_not_a_table));
  }
  return parts.join(" ");
}

function anonymityFindings({ paper, artifacts, root, cycleId }) {
  const findings = [];
  const identifying = identifyingPattern({ root, cycleId });
  const venue = paper?.target_venue;
  const anonymous = /double.?anonymous|double.?blind/i.test(text(venue?.format?.anonymity));
  if (!anonymous) return { anonymous: false, findings };

  if (identifying.test(reviewerVisibleText(paper))) {
    findings.push(
      "manuscript text contains absolute paths identifying the submitting group; "
      + "the venue is double-anonymous, so these must be replaced with a repository "
      + "reference or a relative path before submission",
    );
  }
  // What ships is the bundle name. A source path under the producing machine is
  // fine to record internally; it is only a leak if the reviewer receives it.
  const leakingNames = artifacts.filter((item) => identifying.test(item.bundle_name || item.path || ""));
  if (leakingNames.length) {
    findings.push(
      `${leakingNames.length} bundled artifact(s) would ship under identifying names; `
      + "rename them within the package before submission",
    );
  }
  return { anonymous: true, findings };
}

/**
 * The artifacts a reviewer needs: the files this manuscript's own numbers and
 * figures were computed from, deduplicated, with the missing ones named.
 */
// One field, one path. cycle-g-v89's author wrote two artifacts into a single
// `source_artifact` joined by "; ", and the package then looked for a file whose
// name was both paths concatenated -- reporting a missing artifact when both
// files were on disk. Splitting here keeps a formatting habit from reading as
// lost evidence; the contract asks for one path per field regardless.
function splitPaths(value) {
  return text(value)
    .split(/\s*;\s*|\s*,\s*(?=\/)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// A bundled artifact is cited by the name it has INSIDE the package, not by the
// path it happened to occupy on the machine that produced it. Fourteen artifacts
// under `/opt/researchlab/.research-lab/artifacts/stats/<cycle>/followup-runner-97/...`
// hand a double-anonymous reviewer the submitting group's directory tree, the
// cycle's identifier and its lane numbering.
//
// The mapping is recorded so the manuscript can cite `artifacts/03-...csv` and a
// reader can still be told, after acceptance, which run produced it.
function bundleName(filePath, index) {
  const base = path.basename(String(filePath || "artifact"));
  const ordinal = String(index + 1).padStart(2, "0");
  return `artifacts/${ordinal}-${base}`;
}

function citedArtifacts(paper) {
  const cited = new Set();
  for (const entry of asArray(paper?.numbers_manifest)) {
    for (const source of splitPaths(entry?.source_artifact)) cited.add(source);
  }
  for (const figure of asArray(paper?.figures)) {
    for (const source of splitPaths(figure?.source_artifact)) cited.add(source);
    const generator = text(figure?.generator);
    // The generator ships too: the owner's rule is that a figure must be
    // rebuildable from the data at any time, which is only true if the script
    // travels with the data.
    for (const item of splitPaths(generator)) cited.add(item);
  }
  for (const item of asArray(paper?.supplementary_material)) {
    for (const source of splitPaths(item?.source_artifact)) cited.add(source);
  }
  return [...cited].map((filePath, index) => ({
    ...fileEntry(filePath, "artifact"),
    bundle_name: bundleName(filePath, index),
  }));
}

const REQUIRED_PARTS = ["manuscript", "supplementary", "artifacts"];
const OPTIONAL_PARTS = ["demo", "cover_letter"];

/**
 * Assemble the package description. Nothing is copied here: the package is a
 * manifest of what would be submitted, so it can be checked before anyone builds
 * an archive, and so a missing part is a finding rather than a silent omission.
 */
function buildSubmissionPackage({ root, cycleId, paperPath }) {
  const paper = readJsonIfExists(paperPath);
  if (!paper) {
    return {
      cycle_id: cycleId,
      complete: false,
      missing_required: [...REQUIRED_PARTS],
      blockers: ["no manuscript artifact exists, so there is nothing to submit"],
      parts: {},
    };
  }

  const base = paperPath.replace(/\.json$/, "");
  const manuscript = [
    fileEntry(`${base}.pdf`, "manuscript_pdf"),
    fileEntry(`${base}.tex`, "manuscript_source"),
  ];
  const supplementary = asArray(paper.supplementary_material).map((item) => ({
    role: "supplementary",
    id: item.id || null,
    title: item.title || null,
    kind: item.kind || null,
    source_artifact: item.source_artifact || null,
    // A supplement whose content lives only in the paper JSON still ships, as
    // part of the manuscript's own supplementary section.
    present: Boolean(text(item.what_it_contains)),
  }));
  const artifacts = citedArtifacts(paper);
  const demo = asArray(paper.figures)
    .filter((figure) => text(figure?.kind).toLowerCase() === "video")
    .map((figure) => ({
      ...fileEntry(figure.path, "demo"),
      id: figure.id || null,
      claim_carried: figure.claim_carried || null,
      video_check: figure.video_check || null,
    }));
  const coverLetter = fileEntry(paper.cover_letter_path || `${base}-cover-letter.md`, "cover_letter");

  const blockers = [];
  const missingRequired = [];

  if (!manuscript.some((item) => item.role === "manuscript_pdf" && item.present)) {
    missingRequired.push("manuscript");
    blockers.push("manuscript PDF is missing: the venue receives a PDF, not a JSON record");
  }
  if (!supplementary.length || !supplementary.every((item) => item.present)) {
    missingRequired.push("supplementary");
    blockers.push(
      supplementary.length
        ? "supplementary items are listed without content"
        : "no supplementary material: this result summarises per-seed and per-family runs the reader cannot check without it",
    );
  }
  const missingArtifacts = artifacts.filter((item) => !item.present);
  if (!artifacts.length) {
    missingRequired.push("artifacts");
    blockers.push("no artifacts are cited, so no number in the manuscript can be traced");
  } else if (missingArtifacts.length) {
    blockers.push(
      `${missingArtifacts.length} cited artifact(s) are not on disk, so the package would ship claims a reviewer cannot check: `
      + missingArtifacts.slice(0, 3).map((item) => item.path).join("; "),
    );
  }

  // Optional parts are reported, never blocking. A demo that exists but was
  // never measured is worse than no demo, so that IS a finding.
  for (const item of demo) {
    if (item.present && !item.video_check) {
      blockers.push(`${item.id || "demo"} ships without a video_check, so nothing measured it`);
    }
    if (item.present && !text(item.claim_carried)) {
      blockers.push(`${item.id || "demo"} names no claim it carries that the static figures do not`);
    }
  }

  const anonymity = anonymityFindings({ paper, artifacts, root, cycleId });
  blockers.push(...anonymity.findings);

  return {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    venue: paper?.target_venue?.name || null,
    anonymous_venue: anonymity.anonymous,
    parts: {
      manuscript,
      supplementary,
      artifacts,
      demo,
      cover_letter: coverLetter,
    },
    optional_present: {
      demo: demo.some((item) => item.present),
      cover_letter: coverLetter.present,
    },
    missing_required: missingRequired,
    complete: missingRequired.length === 0 && blockers.length === 0,
    blockers,
  };
}

function writeSubmissionPackage({ root, cycleId, paperPath }) {
  const built = buildSubmissionPackage({ root, cycleId, paperPath });
  const outPath = path.join(root, "submissions", `${cycleId}-submission-package.json`);
  ensureDir(path.dirname(outPath));
  writeJson(outPath, built);
  return { ...built, package_path: outPath };
}

module.exports = {
  buildSubmissionPackage,
  writeSubmissionPackage,
  citedArtifacts,
  REQUIRED_PARTS,
  OPTIONAL_PARTS,
};
