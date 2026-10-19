"use strict";

// The manuscript the author wrote, and the paper the gate reviews, were two
// different documents.
//
// `buildDocumentArtifacts` synthesizes a paper from the lead hypothesis and the
// evidence bundle: a template with fixed introduction and methods paragraphs. The
// author lane, meanwhile, writes a real manuscript into its own result.json --
// venue decision, abstract, sections, references, numbers manifest -- and the
// illustrator writes a figure set beside it. Neither ever reached `papers/`, so
// `buildPaperReview` read `paper_path: None`, scored 0, and recorded the blocker
// "no manuscript JSON artifact exists". On cycle-g-v89 that had been true for the
// whole cycle, and it is true for every cycle in this tree: the papers directory
// is empty.
//
// So a gate that cannot see the manuscript cannot review it, and the review I
// would otherwise do by hand has nowhere to live. This module carries the lanes'
// own output into the paper document, and records where each piece came from so
// the gate can tell authored content from template.

const fs = require("fs");
const path = require("path");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
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

// Lanes are named `<role>-NN`, and the ones the dispatcher opens later are
// `followup-<role>-NN`. Only the first shape was matched here, so every lane the
// gate itself asked for was invisible to the document builder: followup-author-02
// listed the sham that reproduced its own result, the paper still read "not
// stated", and the same blocker was raised again against a manuscript that had
// already answered it.
//
// The most recent completed lane of either shape owns the document.
function laneBelongsToRole(name, role) {
  return name === role || name.startsWith(`${role}-`) || name.startsWith(`followup-${role}-`);
}

function laneResultsOldestFirst({ root, cycleId, role }) {
  const lanesDir = path.join(root, "lanes", cycleId);
  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir);
  } catch (error) {
    return [];
  }
  return entries
    .filter((name) => laneBelongsToRole(name, role))
    .map((name) => path.join(lanesDir, name, "result.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => ({ filePath, mtime: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ filePath }) => ({ path: filePath, result: readJsonIfExists(filePath) }))
    .filter((item) => item.result);
}

// A revision is a revision, not a replacement.
//
// The paper is rebuilt from the TEMPLATE on every pass and the authored content
// is overlaid, so whatever the newest lane did not supply falls back to
// boilerplate rather than to what the previous lane wrote. Followup author lanes
// answer one blocker at a time and return a partial manuscript, so once they
// became eligible to own the document, sixteen of them ground it down: the
// complete manuscript that had seven references and seven sections became one
// with none of either, and the sham declaration made in round two was gone by
// round three.
//
// Folding the lanes oldest-first reconstructs what the revisions add up to. A
// later lane overrides a field it actually supplied; everything it left alone
// keeps the last value some lane gave it.
//
// An empty array normally means "did not supply". `controls_that_reproduce_the_result`
// is the exception: there, an empty list is the author asserting that no control
// matched, and the gate treats that differently from silence.
const EMPTY_IS_AN_ASSERTION = new Set(["controls_that_reproduce_the_result"]);

function supplied(key, value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0 || EMPTY_IS_AN_ASSERTION.has(key);
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function foldAuthoredResults(entries) {
  const folded = {};
  const manuscript = {};
  for (const entry of entries) {
    const authored = entry?.result?.extracted_json;
    if (!authored || typeof authored !== "object") continue;
    for (const [key, value] of Object.entries(authored)) {
      if (key === "manuscript") continue;
      if (supplied(key, value)) folded[key] = value;
    }
    const revision = authored.manuscript;
    if (revision && typeof revision === "object") {
      for (const [key, value] of Object.entries(revision)) {
        if (supplied(key, value)) manuscript[key] = value;
      }
    }
  }
  if (Object.keys(manuscript).length) folded.manuscript = manuscript;
  return Object.keys(folded).length ? folded : null;
}

function latestLaneResult({ root, cycleId, role }) {
  const entries = laneResultsOldestFirst({ root, cycleId, role });
  if (!entries.length) return null;
  return { path: entries[entries.length - 1].path, result: entries[entries.length - 1].result };
}

function sectionText(section) {
  return String(section?.text || section?.body || section?.content || "").trim();
}

function normalizeSections(manuscript) {
  return asArray(manuscript?.sections).map((section, index) => ({
    heading: section?.heading || section?.title || `Section ${index + 1}`,
    text: sectionText(section),
  }));
}

// The illustrator's figure record is already the shape the figure gate wants; the
// deck-oriented `figure_panels` slot gets the same content so the presence rubric
// and the evidence checks read one figure set rather than two.
function figurePanelsFromFigures(figures) {
  return figures.map((figure, index) => ({
    figure_id: figure.id,
    figure_number: index + 1,
    image_path: figure.path,
    source_tables: figure.source_artifact ? [figure.source_artifact] : [],
    caption: figure.caption || "",
    detailed_explanation: [figure.claim_carried, figure.why_not_a_table]
      .filter(Boolean)
      .join(" "),
  }));
}

// The renderer and the IMRAD rubric read `introduction`, `methods`, `results`,
// `discussion` and `limitations` as arrays of paragraphs. The author writes
// `sections` with its own headings. Overlaying only `sections` left both reading
// the template, so cycle-g-v89 rendered a manuscript whose Introduction began
// "High-impact manuscript review rewards claims that are narrow enough to be
// falsifiable" and whose Results said "The validation blueprint passed 2 checks
// with method score n/a" -- and `imrad_structure` scored 100 on that boilerplate
// while the author's real body sat unread in `sections`.
//
// Headings are the author's, so the mapping is by what the heading says rather
// than by position. A section that matches nothing is kept: it goes to the body
// field for the part of the paper it follows, because dropping an author's
// section to fit a fixed skeleton loses the manuscript to save the schema.
const IMRAD_ROUTES = [
  { field: "introduction", pattern: /introduc|motivat|background|problem|contribution/i },
  { field: "methods", pattern: /method|procedure|data|benchmark|setup|experiment|protocol|material/i },
  { field: "results", pattern: /result|finding|evaluat|measurement|analysis/i },
  { field: "limitations", pattern: /limitation|threat|validity/i },
  { field: "discussion", pattern: /discussion|conclusion|interpretation|implication|future/i },
];

// Related work precedes the method in a paper, so it belongs with the
// introduction rather than trailing after the results.
IMRAD_ROUTES[0].pattern = /introduc|motivat|background|problem|contribution|related work|prior work/i;

// Availability is not an IMRaD body field, and it is checked before the IMRaD
// routes because "Data and Code Availability" matches the methods pattern on the
// word `data`. cycle-g-v89 filed the author's availability statement into
// Methods, so the paper kept the TEMPLATE availability list, which prints
//
//     Primary runner result: /opt/researchlab/.research-lab/artifacts/stats/
//     <cycle>/followup-runner-128/result.json
//
// at a double-anonymous venue -- while the author's own statement, one screen
// away in the same result.json, cited `artifacts/01-check.json` and named no
// path at all. Same shape as the manuscript body before this module existed: the
// lane wrote it and nothing read it.
const AVAILABILITY_PATTERN = /availab|data and code|code and data|artifact statement/i;

function paragraphs(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyAuthoredSectionsToImrad(paper, sections) {
  const routed = {
    introduction: [],
    methods: [],
    results: [],
    discussion: [],
    limitations: [],
  };
  const availability = [];
  let lastField = "introduction";
  for (const section of sections) {
    const body = paragraphs(section.text);
    if (AVAILABILITY_PATTERN.test(section.heading)) {
      availability.push(...(body.length ? body : [section.text].filter(Boolean)));
      continue;
    }
    const route = IMRAD_ROUTES.find((item) => item.pattern.test(section.heading));
    const field = route ? route.field : lastField;
    lastField = field;
    routed[field].push(...(body.length ? body : [section.text].filter(Boolean)));
  }
  // Every body field the author supplied a section for is replaced, and every
  // one they did not is EMPTIED rather than left holding template prose. A
  // manuscript that ships boilerplate under a real heading is the defect this
  // routing exists to fix, and a gate that then scores the boilerplate hides it.
  // An empty field fails its rubric item, which is the honest outcome and the
  // one that tells the author what is missing.
  for (const [field, value] of Object.entries(routed)) {
    paper[field] = value;
  }
  // Availability is the one field where the template is left standing when the
  // author supplied nothing: the rubric scores it, and an empty statement would
  // read as a manuscript with no availability policy rather than as one whose
  // author did not write it. When the author DID write it, theirs replaces the
  // template outright, paths and all.
  if (availability.length) {
    paper.data_code_availability = availability;
  }
  paper.authored_imrad_routing = sections.map((section) => ({
    heading: section.heading,
    routed_to: AVAILABILITY_PATTERN.test(section.heading)
      ? "data_code_availability"
      : (IMRAD_ROUTES.find((item) => item.pattern.test(section.heading)) || {}).field || "preceding section",
  }));
}

function collectAuthoredDocument({ root, cycleId }) {
  // Fold every lane of the role, oldest first: a revision adds to what earlier
  // lanes wrote instead of replacing it. `provenance` still names the newest,
  // which is the lane whose decisions the current document mostly reflects.
  const authorLanes = laneResultsOldestFirst({ root, cycleId, role: "author" });
  const illustratorLanes = laneResultsOldestFirst({ root, cycleId, role: "illustrator" });
  const authorLane = authorLanes[authorLanes.length - 1] || null;
  const illustratorLane = illustratorLanes[illustratorLanes.length - 1] || null;
  const authored = foldAuthoredResults(authorLanes);
  const drawn = foldAuthoredResults(illustratorLanes);
  const manuscript = authored?.manuscript || null;

  if (!manuscript && !drawn) return null;

  const figures = asArray(drawn?.figures).map((figure) => ({
    id: figure?.id || null,
    kind: figure?.kind || null,
    path: figure?.path || null,
    caption: figure?.caption || null,
    claim_carried: figure?.claim_carried || null,
    why_not_a_table: figure?.why_not_a_table || null,
    source_artifact: figure?.source_artifact || null,
    generator: figure?.generator || null,
    axes: figure?.axes || null,
    reference_marks: asArray(figure?.reference_marks),
    // Measured in the generator that drew the figure; the figure gate reads it
    // to decide whether labels collide, clip, or fall below print legibility.
    layout_check: figure?.layout_check || null,
  }));

  return {
    manuscript,
    figures,
    figure_panels: figurePanelsFromFigures(figures),
    numbers_manifest: asArray(authored?.numbers_manifest),
    supplementary_material: asArray(authored?.supplementary_material),
    sensitivity_analyses: asArray(authored?.sensitivity_analyses),
    additional_experiments_requested: asArray(authored?.additional_experiments_requested),
    // What the manuscript claims, and what it admits about its own controls.
    // The gate reads all of these; without them here the author can answer a
    // blocker in its result and have the answer dropped on the way to the paper,
    // which is how the sham finding was raised twice against a manuscript that
    // had already listed the sham.
    contribution_type: authored?.contribution_type || null,
    controls_that_reproduce_the_result: Array.isArray(authored?.controls_that_reproduce_the_result)
      ? authored.controls_that_reproduce_the_result
      : null,
    baselines: asArray(authored?.baselines),
    evaluation_scale: authored?.evaluation_scale || null,
    withdrawn_claims: asArray(authored?.withdrawn_claims),
    refutes: authored?.refutes || null,
    next_approach: authored?.next_approach || null,
    target_venue: authored?.target_venue || null,
    ai_use_disclosure: authored?.ai_use_disclosure || null,
    author_self_check: authored?.self_check || null,
    figure_coverage_check: asArray(drawn?.coverage_check),
    figure_only_read: drawn?.figure_only_read || null,
    provenance: {
      author_lane_result: authorLane?.path || null,
      illustrator_lane_result: illustratorLane?.path || null,
    },
  };
}

// Overlay, not replacement. The template supplies the fields the rubric scores
// that no lane produces (availability statements, supplement context); the lanes
// supply the document itself. Where both exist the lanes win, because the lanes
// wrote a manuscript and the template wrote a form.
// The report is a different deliverable from the paper -- executive summary, key
// findings, next tests, sensitivity summary -- and it was left reading the
// template while the paper was fixed. Its review reported "reference list needs
// at least 4 article references" and "report needs at least four quantitative
// findings" for a cycle that had seven real citations and thirteen
// artifact-bound numbers.
//
// Only fields with a real lane source are carried. `sensitivity_summary` and
// `limitations` have none, so they are left as they are and their rubric items
// fail with the gate saying what is missing -- inventing them here would be
// writing the report rather than delivering it.
function applyAuthoredReport(report, authored) {
  if (!report || !authored) return report;
  const manuscript = authored.manuscript;
  const abstract = manuscript?.abstract;
  const summary = typeof abstract === "string" ? abstract : text(abstract?.summary);
  if (summary) {
    report.executive_summary = summary;
  }
  if (manuscript?.title) {
    report.title = manuscript.title;
  }
  if (asArray(manuscript?.references).length) {
    const templateDatasets = asArray(report.references).filter(
      (item) => String(item?.type || "").toLowerCase() === "dataset",
    );
    report.references = templateDatasets.concat(asArray(manuscript.references));
  }
  // A quantitative finding, for this review, is a number a reader can trace.
  // numbers_manifest is exactly that: value, source artifact, and the assertion
  // the generator ran before writing it.
  const findings = asArray(authored.numbers_manifest)
    .filter((entry) => text(entry?.value) && text(entry?.source_artifact))
    .map((entry) => ({
      finding: text(entry.value),
      source_artifact: text(entry.source_artifact),
      assertion: text(entry.assertion) || null,
    }));
  if (findings.length) {
    report.key_findings = findings;
  }
  // The report blocks on an absent sensitivity summary. The cycle did probe the
  // result -- matched-SPP against matched-time, a three-fold resolution audit,
  // seed dispersion, a severity-label sham -- but nothing stated it, because no
  // lane was asked to. The author states it now, and it lands here.
  const sensitivity = asArray(authored.sensitivity_analyses).map((item) => ({
    class: item.what_was_varied,
    range: item.range,
    what_moved: item.what_moved,
    conclusion_holds: item.conclusion_holds,
    source_artifact: item.source_artifact,
  }));
  if (sensitivity.length) {
    report.sensitivity_summary = sensitivity;
  }
  report.authored_by_lanes = authored.provenance;
  report.document_source = "lane-authored";
  return report;
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function applyAuthoredDocument(paper, authored) {
  if (!paper || !authored) return paper;
  const manuscript = authored.manuscript;
  if (manuscript?.title) {
    paper.title = manuscript.title;
  }
  if (manuscript?.abstract) {
    paper.abstract = typeof manuscript.abstract === "string"
      ? { summary: manuscript.abstract }
      : manuscript.abstract;
  }
  const sections = normalizeSections(manuscript);
  if (sections.length) {
    paper.sections = sections;
    paper.authored_sections = sections;
    applyAuthoredSectionsToImrad(paper, sections);
  }
  // The rubric reads `references`. Putting the author's citations anywhere else
  // is the same defect this project keeps paying for: the value exists, and the
  // consumer never sees it. cycle-g-v89 wrote seven real graphics papers with
  // DOIs into `authored_references` and the gate reported "reference list needs
  // at least 5 article references" against an empty list.
  //
  // Dataset entries the template contributes are kept, because they are
  // provenance rather than related work and the author does not re-derive them.
  if (asArray(manuscript?.references).length) {
    const authoredReferences = asArray(manuscript.references);
    const templateDatasets = asArray(paper.references).filter(
      (item) => String(item?.type || "").toLowerCase() === "dataset",
    );
    paper.references = templateDatasets.concat(authoredReferences);
    paper.authored_references = authoredReferences;
  }
  if (asArray(authored.figures).length) {
    paper.figures = authored.figures;
    paper.figure_panels = authored.figure_panels;
    // The template's inventory line advertised a PPTX deck with SVG artwork,
    // which the owner has removed from the workflow and which this venue never
    // asked for. The inventory now lists what the manuscript actually carries.
    // "Tables and figures" means both. Listing only the figures left the
    // inventory short of the rubric's count while six supplementary tables sat
    // beside it unlisted, which reads as a missing inventory rather than as the
    // complete one it is.
    paper.tables_and_figures = authored.figures
      .map((figure) => `${figure.id}: ${figure.caption || "figure"}`)
      .concat(
        asArray(authored.supplementary_material)
          .filter((item) => String(item?.kind || "").toLowerCase() === "table")
          .map((item) => `${item.id}: ${item.title || "supplementary table"}`),
      );
  }
  if (asArray(authored.numbers_manifest).length) {
    paper.numbers_manifest = authored.numbers_manifest;
  }
  if (asArray(authored.sensitivity_analyses).length) {
    paper.sensitivity_analyses = asArray(authored.sensitivity_analyses);
  }
  if (asArray(authored.supplementary_material).length) {
    paper.supplementary_material = asArray(authored.supplementary_material);
    // The rubric reads `supplementary_tables` as name -> location, and the
    // template filled it with three biomedical placeholders that pointed at
    // nothing this cycle produced. The author's supplement replaces them.
    paper.supplementary_tables = Object.fromEntries(
      asArray(authored.supplementary_material).map((item) => [
        `${item.id || "S"}. ${item.title || "supplementary item"}`,
        item.source_artifact || "generated with the manuscript",
      ]),
    );
  }
  if (authored.target_venue) {
    paper.target_venue = authored.target_venue;
  }
  if (authored.ai_use_disclosure) {
    paper.ai_use_disclosure = authored.ai_use_disclosure;
  }
  // The claim declarations the paper gate reads. `controls_that_reproduce_the_result`
  // is copied even when empty, because an empty list is the author asserting that
  // no control matched -- which the gate treats differently from silence.
  for (const field of ["contribution_type", "evaluation_scale", "refutes", "next_approach"]) {
    if (authored[field]) paper[field] = authored[field];
  }
  if (Array.isArray(authored.controls_that_reproduce_the_result)) {
    paper.controls_that_reproduce_the_result = authored.controls_that_reproduce_the_result;
  }
  for (const field of ["baselines", "withdrawn_claims"]) {
    if (asArray(authored[field]).length) paper[field] = asArray(authored[field]);
  }
  paper.author_self_check = authored.author_self_check;
  paper.figure_coverage_check = authored.figure_coverage_check;
  paper.figure_only_read = authored.figure_only_read;
  paper.authored_by_lanes = authored.provenance;
  paper.document_source = "lane-authored";
  return paper;
}

module.exports = {
  collectAuthoredDocument,
  applyAuthoredDocument,
  applyAuthoredReport,
  applyAuthoredSectionsToImrad,
  latestLaneResult,
};
