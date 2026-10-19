"use strict";

// What gets submitted was never assembled anywhere.
//
// The runtime produced a manuscript, a report, figures under a lane directory,
// supplementary items inside the paper JSON, and the CSVs the numbers came from
// -- five places, no package. Owner specification: manuscript, supplementary,
// artifacts, optional demo, optional cover letter.
//
// These tests pin what "complete" means, and in particular pin the two checks
// that go beyond counting files: the artifacts are the ones this manuscript
// cites, and an anonymous venue does not receive the submitting group's
// directory tree.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildSubmissionPackage } = require("../src/reporting/submission_package");

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "submission-package-"));
  fs.mkdirSync(path.join(root, "papers"), { recursive: true });
  return root;
}

function write(filePath, bytes = 2048) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

function makePaper(root, overrides = {}) {
  const base = path.join(root, "papers", "cycle-paper-v0001");
  write(`${base}.pdf`, 500000);
  write(`${base}.tex`, 9000);
  const csv = write(path.join(root, "data", "summary.csv"), 4096);
  const gen = write(path.join(root, "figs", "draw.py"), 8000);
  const png = write(path.join(root, "figs", "one.png"), 200000);
  const paper = {
    target_venue: { name: "ACM TOG", format: { anonymity: "double-anonymous" } },
    numbers_manifest: [{ value: "0.44", source_artifact: csv }],
    figures: [{ id: "fig:one", path: png, source_artifact: csv, generator: gen }],
    supplementary_material: [
      { id: "S1", title: "Per-seed results", kind: "table", what_it_contains: "every seed", source_artifact: csv },
    ],
    data_code_availability: ["Artifacts are archived with the submission."],
    ...overrides,
  };
  fs.writeFileSync(`${base}.json`, JSON.stringify(paper), "utf8");
  return { paperPath: `${base}.json`, base, csv, gen, png };
}

test("a package with manuscript, supplementary and artifacts is complete", () => {
  const root = scratch();
  const { paperPath } = makePaper(root);
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath });
  assert.equal(pkg.complete, true, JSON.stringify(pkg.blockers));
  assert.deepEqual(pkg.missing_required, []);
  // Optional parts are reported, never required.
  assert.equal(pkg.optional_present.demo, false);
  assert.equal(pkg.optional_present.cover_letter, false);
});

test("the artifacts are the ones this manuscript cites, generators included", () => {
  // Not "every file the cycle produced": a package carrying unrelated CSVs is
  // padding, and one missing a cited file cannot be checked by a reviewer.
  const root = scratch();
  const { paperPath, csv, gen } = makePaper(root);
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath });
  const paths = pkg.parts.artifacts.map((item) => item.path);
  assert.ok(paths.includes(csv), "the source table a number was computed from");
  assert.ok(
    paths.includes(gen),
    "the generator ships too: a figure is only rebuildable from the data if the script travels with it",
  );
  assert.equal(pkg.parts.artifacts.length, 2, "cited once, bundled once");
});

test("a cited artifact that is not on disk blocks the package", () => {
  const root = scratch();
  const { paperPath, csv } = makePaper(root);
  fs.unlinkSync(csv);
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath });
  assert.equal(pkg.complete, false);
  assert.ok(pkg.blockers.some((b) => /cited artifact\(s\) are not on disk/.test(b)));
});

test("a missing manuscript PDF is a missing required part", () => {
  const root = scratch();
  const { paperPath, base } = makePaper(root);
  fs.unlinkSync(`${base}.pdf`);
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath });
  assert.ok(pkg.missing_required.includes("manuscript"));
  assert.ok(pkg.blockers.some((b) => /PDF, not a JSON record/.test(b)));
});

test("supplementary material is required, and listing a title is not supplying one", () => {
  const root = scratch();
  const empty = makePaper(root, { supplementary_material: [] });
  let pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath: empty.paperPath });
  assert.ok(pkg.missing_required.includes("supplementary"));
  assert.ok(pkg.blockers.some((b) => /per-seed and per-family runs/.test(b)));

  const titleOnly = makePaper(root, {
    supplementary_material: [{ id: "S1", title: "Per-seed results", kind: "table" }],
  });
  pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath: titleOnly.paperPath });
  assert.ok(pkg.blockers.some((b) => /listed without content/.test(b)));
});

test("a demo is optional, but an unmeasured one is a finding", () => {
  // Owner rule for the video: a figure nobody measured is not a verified figure,
  // and a video that carries nothing the static panels do not is decoration.
  const root = scratch();
  const video = write(path.join(root, "figs", "demo.mp4"), 900000);
  const withDemo = makePaper(root, {
    figures: [
      { id: "fig:one", path: write(path.join(root, "figs", "one.png"), 200000), source_artifact: write(path.join(root, "data", "summary.csv"), 4096) },
      { id: "fig:demo", kind: "video", path: video },
    ],
  });
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath: withDemo.paperPath });
  assert.equal(pkg.optional_present.demo, true);
  assert.ok(pkg.blockers.some((b) => /ships without a video_check/.test(b)));
  assert.ok(pkg.blockers.some((b) => /names no claim it carries/.test(b)));
});

test("an anonymous venue does not receive the submitting group's directory tree", () => {
  // The manuscript body prints these paths today, and the artifacts are named by
  // them. PDF metadata being clean does not help when the References section
  // spells out the lab's filesystem.
  const root = scratch();
  const { paperPath } = makePaper(root, {
    data_code_availability: [
      "Primary runner result: /opt/researchlab/.research-lab/artifacts/stats/cycle/followup-runner-102/result.json",
    ],
  });
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath });
  assert.equal(pkg.anonymous_venue, true);
  assert.equal(pkg.complete, false);
  assert.ok(pkg.blockers.some((b) => /absolute paths identifying the submitting group/.test(b)));
});

test("a venue that is not anonymous is not asked to hide its paths", () => {
  const root = scratch();
  const { paperPath } = makePaper(root, {
    target_venue: { name: "Open Journal", format: { anonymity: "open" } },
    data_code_availability: ["/opt/researchlab/.research-lab/artifacts/stats/x.csv"],
  });
  const pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath });
  assert.equal(pkg.anonymous_venue, false);
  assert.equal(pkg.complete, true, JSON.stringify(pkg.blockers));
});

test("bundle names are neutral, and the check that guards them can still fail", () => {
  // Renaming into `artifacts/NN-basename` removes the directory tree, which is
  // where the cycle id and lane numbering lived. It does NOT remove an
  // identifying BASENAME, so the guard has to stay able to fire -- a check that
  // cannot fail is not a check.
  const root = scratch();
  const csv = write(path.join(root, "data", "summary.csv"), 4096);
  const clean = makePaper(root, {
    numbers_manifest: [{ value: "0.44", source_artifact: csv }],
    figures: [],
    supplementary_material: [{ id: "S1", title: "t", kind: "table", what_it_contains: "x" }],
    data_code_availability: ["Artifacts ship with the submission."],
  });
  let pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath: clean.paperPath });
  assert.match(pkg.parts.artifacts[0].bundle_name, /^artifacts\/01-summary\.csv$/);
  assert.equal(pkg.complete, true, JSON.stringify(pkg.blockers));

  // What makes a basename identifying is not a name from some list -- it is the
  // cycle's own identifier, which is derived at runtime and works for any
  // deployment and any naming scheme.
  const identifying = write(path.join(root, "data", "run-cycle-g-v89-20260831-summary.csv"), 4096);
  const leaky = makePaper(root, {
    numbers_manifest: [{ value: "0.44", source_artifact: identifying }],
    figures: [],
    supplementary_material: [{ id: "S1", title: "t", kind: "table", what_it_contains: "x" }],
    data_code_availability: ["Artifacts ship with the submission."],
  });
  pkg = buildSubmissionPackage({ root, cycleId: "cycle-g-v89-20260831", paperPath: leaky.paperPath });
  assert.ok(
    pkg.blockers.some((b) => /would ship under identifying names/.test(b)),
    "an identifying filename survives the rename and must still be caught",
  );
});

test("a machine path the packager reads is not a disclosure; one a reviewer reads is", () => {
  // `source_artifact` and `generator` are the packager's own fields: it opens
  // them to find the file and ships it under a neutral bundle name, so a path
  // there never reaches a reviewer. Scanning the whole paper object flagged 50
  // of those as a leak on cycle-g-v89 while never looking at the manuscript body
  // or the reference list, which is where the real one was.
  const root = scratch();
  const internal = write(path.join(root, "opt", "researchlab", ".research-lab", "summary.csv"), 4096);
  const quiet = makePaper(root, {
    numbers_manifest: [{ value: "0.44", source_artifact: internal }],
    figures: [
      { id: "fig:one", path: write(path.join(root, "figs", "one.png"), 200000), source_artifact: internal, caption: "Crossing severity by arm." },
    ],
    supplementary_material: [{ id: "S1", title: "Per-seed results", kind: "table", what_it_contains: "every seed", source_artifact: internal }],
    data_code_availability: ["Values regenerate from artifacts/01-summary.csv."],
  });
  let pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath: quiet.paperPath });
  assert.equal(pkg.anonymous_venue, true);
  assert.equal(
    pkg.blockers.some((b) => /absolute paths identifying/.test(b)),
    false,
    JSON.stringify(pkg.blockers),
  );

  // The reference list and the figure captions are read by a reviewer, and the
  // body scan never covered either before.
  for (const overrides of [
    { references: [{ title: "Runner output", type: "dataset", doi: "/opt/researchlab/.research-lab/x.json" }] },
    { figures: [{ id: "fig:one", path: write(path.join(root, "figs", "one.png"), 200000), source_artifact: internal, caption: "Drawn from /var/runs/lab/output.csv." }] },
    { results: ["The crossing severity is recorded in /opt/researchlab/.research-lab/stats.csv."] },
  ]) {
    const leaky = makePaper(root, {
      numbers_manifest: [{ value: "0.44", source_artifact: internal }],
      supplementary_material: [{ id: "S1", title: "t", kind: "table", what_it_contains: "x" }],
      data_code_availability: ["Artifacts ship with the submission."],
      ...overrides,
    });
    pkg = buildSubmissionPackage({ root, cycleId: "cycle", paperPath: leaky.paperPath });
    assert.ok(
      pkg.blockers.some((b) => /absolute paths identifying/.test(b)),
      `reviewer-visible leak not caught: ${Object.keys(overrides)[0]}`,
    );
  }
});
