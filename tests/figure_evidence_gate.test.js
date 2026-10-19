"use strict";

// The figure gate scored presence and called it review.
//
// `tables_figures_submission_discipline` awards points for figure count, a PPTX
// path, the substring "svg", slide count, and caption length. On cycle-g-v89 that
// rubric passed a panel titled "Query-efficiency threshold is cleared only by
// active and sham" drawn over bars showing four arms past the threshold it names,
// and a parity panel that offset two measurements of exactly 0.0 to opposite
// sides of the zero line in the figure whose purpose was to show they are equal.
//
// These tests pin the two layers that replaced that. The mechanical checks are
// assertions; the reading check is fail-closed, because whether a drawn figure
// tells the truth is not a predicate over its metadata.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  figureEvidenceChecks,
  figureVerificationFollowupActions,
  generatorIsAdopted,
  verdictClears,
  MIN_RENDERED_IMAGE_BYTES,
} = require("../src/reporting/document_reviews/figure_evidence");

const CYCLE = "cg-gate-test-figures";

function scratchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figure-evidence-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  return root;
}

function writeImage(root, name, bytes) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

function writeTable(root, name) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, "arm,saving\nactive,0.44\n", "utf8");
  return filePath;
}

function paperWith(figures, extra = {}) {
  return {
    title: "A frozen benchmark",
    abstract: "The claim is carried by fig:one.",
    sections: [{ heading: "Results", text: "As shown in fig:one, the bound holds." }],
    figures,
    document_source: "lane-authored",
    ...extra,
  };
}

function checkFor(result, figureId, name) {
  return result.checks.find((item) => item.figure_id === figureId && item.check === name);
}

test("a figure whose generator lives in a runner blueprint is recorded as selected, not drawn", () => {
  // Every cycle-g-v89 round-2 figure named a runner's script.py as its generator
  // and predated the illustrator's own run by hours; the gate had no way to say so.
  assert.equal(
    generatorIsAdopted(
      "/opt/researchlab/.research-lab/artifacts/stats/cycle/followup-runner-97/blueprints/x/script.py",
    ),
    true,
  );
  assert.equal(
    generatorIsAdopted(
      "/opt/researchlab/.research-lab/lanes/cycle/illustrator-01/figures/draw_figures.py",
    ),
    false,
  );

  const root = scratchRoot();
  const image = writeImage(root, "one.png", 200000);
  const table = writeTable(root, "one.csv");
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([
      {
        id: "fig:one",
        path: image,
        source_artifact: table,
        generator: "/x/artifacts/stats/c/followup-runner-97/blueprints/b/script.py",
      },
    ]),
  });

  const check = checkFor(result, "fig:one", "generator_is_the_lane_s_own");
  assert.equal(check.passed, false);
  assert.match(check.detail, /selected rather than drawn/);
});

test("an image too small to hold data does not count as a rendered figure", () => {
  // The round-2 sham panel rendered as an empty box. A figure of a few hundred
  // bytes is axes and nothing else.
  const root = scratchRoot();
  const table = writeTable(root, "one.csv");
  const stub = writeImage(root, "stub.png", MIN_RENDERED_IMAGE_BYTES - 1);
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([
      { id: "fig:one", path: stub, source_artifact: table, generator: "/lanes/c/illustrator-01/draw.py" },
    ]),
  });
  assert.equal(checkFor(result, "fig:one", "rendered_image_present").passed, false);
});

test("a figure the manuscript never cites is a blocker", () => {
  const root = scratchRoot();
  const image = writeImage(root, "two.png", 200000);
  const table = writeTable(root, "two.csv");
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([
      { id: "fig:uncited", path: image, source_artifact: table, generator: "/lanes/c/illustrator-01/draw.py" },
    ]),
  });
  assert.equal(checkFor(result, "fig:uncited", "cited_in_manuscript").passed, false);
  assert.ok(result.blockers.some((item) => /not cited anywhere/.test(item)));
});

test("mechanically perfect figures still do not pass without a recorded reading", () => {
  // This is the whole point. Source on disk, image rendered, generator local,
  // cited in the text -- and the panel title can still contradict its own bars.
  const root = scratchRoot();
  const image = writeImage(root, "one.png", 200000);
  const table = writeTable(root, "one.csv");
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([
      {
        id: "fig:one",
        path: image,
        source_artifact: table,
        generator: "/lanes/c/illustrator-01/figures/draw.py",
        caption: "Active clears the threshold.",
      },
    ]),
  });

  for (const name of [
    "source_artifact_exists",
    "rendered_image_present",
    "generator_is_the_lane_s_own",
    "cited_in_manuscript",
  ]) {
    assert.equal(checkFor(result, "fig:one", name).passed, true, `${name} should pass`);
  }
  assert.equal(checkFor(result, "fig:one", "on_image_claims_verified_against_source").passed, false);
  assert.equal(result.verification_requests.length, 1);

  const request = result.verification_requests[0];
  assert.equal(request.required_for_gate, true);
  assert.equal(request.preferred_role, "gatekeeper", "the lane that drew it does not certify it");
  assert.equal(request.image_path, image);
  assert.equal(request.source_artifact, table);
  // The two v89 defects are named in the objective so the reviewer knows what
  // shape of error it is being asked to look for.
  assert.match(request.objective, /panel titles/);
  assert.match(request.objective, /the panel's own marks refute/);
  assert.match(request.objective, /separates values the table records as equal/);
});

test("a recorded verdict clears the figure, and an empty one does not", () => {
  const root = scratchRoot();
  const image = writeImage(root, "one.png", 200000);
  const table = writeTable(root, "one.csv");
  const figure = {
    id: "fig:one",
    path: image,
    source_artifact: table,
    generator: "/lanes/c/illustrator-01/figures/draw.py",
    // This test is about the verdict clearing the figure, so the layout has to
    // be measured and clean or its own blocker would mask the thing under test.
    layout_check: CLEAN_LAYOUT,
  };

  const store = path.join(root, "state", `${CYCLE}-figure-verification.json`);
  fs.writeFileSync(
    store,
    JSON.stringify({ verdicts: [{ figure_id: "fig:one", verified: true, checked_against: "" }] }),
    "utf8",
  );
  let result = figureEvidenceChecks({ root, cycleId: CYCLE, paper: paperWith([figure]) });
  assert.equal(
    checkFor(result, "fig:one", "on_image_claims_verified_against_source").passed,
    false,
    "a verdict that names no evidence is an opinion",
  );

  fs.writeFileSync(
    store,
    JSON.stringify({
      verdicts: [
        { figure_id: "fig:one", verified: true, checked_against: `${table} columns arm,saving` },
      ],
    }),
    "utf8",
  );
  result = figureEvidenceChecks({ root, cycleId: CYCLE, paper: paperWith([figure]) });
  assert.equal(checkFor(result, "fig:one", "on_image_claims_verified_against_source").passed, true);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.verification_requests.length, 0);
});

test("a verdict that reports a discrepancy does not clear the figure", () => {
  const root = scratchRoot();
  const image = writeImage(root, "one.png", 200000);
  const table = writeTable(root, "one.csv");
  const store = path.join(root, "state", `${CYCLE}-figure-verification.json`);
  fs.writeFileSync(
    store,
    JSON.stringify({
      verdicts: [
        {
          figure_id: "fig:one",
          verified: false,
          checked_against: table,
          discrepancies: ["panel title claims two arms clear 0.30; the bars show four"],
        },
      ],
    }),
    "utf8",
  );
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([
      { id: "fig:one", path: image, source_artifact: table, generator: "/lanes/c/illustrator-01/draw.py" },
    ]),
  });
  assert.equal(verdictClears({ verified: false, checked_against: table }), false);
  assert.ok(result.blockers.some((item) => /have not been verified/.test(item)));
});

test("a lane-authored manuscript with no figures blocks rather than passing vacuously", () => {
  const root = scratchRoot();
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([], { document_source: "lane-authored" }),
  });
  assert.equal(result.applicable, true);
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0], /no figures to audit/);
});

test("a template-built paper stays with the deck rubric that already reviewed it", () => {
  // These checks ask which script drew an image and whether the drawing matches
  // its artifact. For figure_panels assembled from a slide manifest neither
  // question has an answer, so the pre-existing rubric keeps that path unchanged
  // rather than this gate failing documents it was never designed to read.
  const root = scratchRoot();
  const templatePaper = paperWith([]);
  delete templatePaper.document_source;
  const result = figureEvidenceChecks({ root, cycleId: CYCLE, paper: templatePaper });
  assert.equal(result.applicable, false);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.checks.length, 0);
});

test("verification work is routed to the gatekeeper as a gate-blocking action", () => {
  const actions = figureVerificationFollowupActions([
    { figure_id: "fig:one", source_artifact: "/x/one.csv" },
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].preferred_role, "gatekeeper");
  assert.equal(actions[0].target_rubric, "figure_evidence");
  assert.match(actions[0].blocker_reasons[0], /has not been read against/);
});

// A figure whose labels collide is unreadable even when every number in it is
// right, and it was the one figure property nobody measured. The deck workflow
// checked font size, overlap count and out-of-bounds boxes -- for PowerPoint
// text boxes only. A figure drawn by a script had nothing looking at it, and the
// owner removed the deck, so the check has to live where the figures now come
// from: measured in the generator, reported per figure, enforced here.

function figureWithLayout(root, layout) {
  const image = writeImage(root, `${Math.random().toString(36).slice(2)}.png`, 200000);
  const table = writeTable(root, `${Math.random().toString(36).slice(2)}.csv`);
  return {
    id: "fig:one",
    path: image,
    source_artifact: table,
    generator: "/lanes/c/illustrator-01/figures/draw.py",
    ...(layout === undefined ? {} : { layout_check: layout }),
  };
}

const CLEAN_LAYOUT = {
  text_overlaps: 0,
  text_over_data_overlaps: 0,
  clipped_artists: 0,
  min_font_pt: 9,
  measured_with: "matplotlib Text.get_window_extent on the drawn canvas",
};

test("a figure that reports no layout measurement is unmeasured, not clean", () => {
  const root = scratchRoot();
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([figureWithLayout(root, undefined)]),
  });
  const check = checkFor(result, "fig:one", "layout_measured");
  assert.equal(check.passed, false);
  assert.match(check.detail, /text collisions and clipping are unmeasured/);
});

test("text collisions and clipped artists block the figure", () => {
  const root = scratchRoot();
  const overlapping = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([figureWithLayout(root, { ...CLEAN_LAYOUT, text_overlaps: 2 })]),
  });
  assert.equal(checkFor(overlapping, "fig:one", "layout_has_no_collisions").passed, false);

  const overData = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([figureWithLayout(root, { ...CLEAN_LAYOUT, text_over_data_overlaps: 1 })]),
  });
  assert.equal(
    checkFor(overData, "fig:one", "layout_has_no_collisions").passed,
    false,
    "a label printed over a data mark is a collision too",
  );

  const clipped = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([figureWithLayout(root, { ...CLEAN_LAYOUT, clipped_artists: 1 })]),
  });
  assert.equal(checkFor(clipped, "fig:one", "layout_has_no_collisions").passed, false);
});

test("shrinking the font past print legibility is not a fix", () => {
  // The cheap way out of a collision is a smaller font, so the floor is checked
  // separately from the collision count.
  const root = scratchRoot();
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([figureWithLayout(root, { ...CLEAN_LAYOUT, min_font_pt: 6 })]),
  });
  assert.equal(checkFor(result, "fig:one", "layout_has_no_collisions").passed, true);
  assert.equal(checkFor(result, "fig:one", "layout_labels_are_legible").passed, false);
  assert.match(
    checkFor(result, "fig:one", "layout_labels_are_legible").detail,
    /below the 8 pt print-legibility floor/,
  );
});

test("a measured, uncollided, legible figure passes the layout checks", () => {
  const root = scratchRoot();
  const result = figureEvidenceChecks({
    root,
    cycleId: CYCLE,
    paper: paperWith([figureWithLayout(root, CLEAN_LAYOUT)]),
  });
  assert.equal(checkFor(result, "fig:one", "layout_has_no_collisions").passed, true);
  assert.equal(checkFor(result, "fig:one", "layout_labels_are_legible").passed, true);
});
