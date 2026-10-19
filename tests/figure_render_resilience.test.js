"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { pythonCommand, writePngWithPython } = require("../src/reporting/figure_deck/python_tools");

// cycle-g-v89, 13:00:52: the supervisor died with
//   PIL.UnidentifiedImageError: cannot identify image file <_io.BytesIO ...>
// raised while python-pptx read an artwork PNG, and the crash reached
// runResearch. followup-runner-131 -- the adopted experiment -- was created
// three minutes later and could not start for 37 minutes, because the pass
// that dispatches lanes dies in the document-artifact step.

function pythonHasPillow() {
  try {
    execFileSync(pythonCommand(), ["-c", "import PIL"], { stdio: "ignore", timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">`
  + `<rect x="10" y="10" width="100" height="60" fill="#3366cc"/></svg>`;

test("a rendered PNG is verified before it is handed on as artwork", { skip: !pythonHasPillow() && "python Pillow unavailable" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figure-render-"));
  const svgPath = path.join(dir, "panel.svg");
  const pngPath = path.join(dir, "panel.png");
  fs.writeFileSync(svgPath, SVG, "utf8");

  const rendered = writePngWithPython(svgPath, pngPath);
  assert.equal(rendered, pngPath, "a valid SVG still renders");

  // The bytes at the returned path decode. Before this fix the renderer
  // checked only that a file existed there.
  const head = fs.readFileSync(pngPath).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");

  // No temporary rendering artifact is left behind to be mistaken for output.
  assert.ok(fs.readdirSync(dir).every((name) => !name.includes(".partial")), "the partial file was renamed away");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unrenderable figure yields no artwork path instead of throwing", { skip: !pythonHasPillow() && "python Pillow unavailable" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figure-render-"));
  const svgPath = path.join(dir, "broken.svg");
  const pngPath = path.join(dir, "broken.png");
  fs.writeFileSync(svgPath, "<svg><unclosed>", "utf8");

  const rendered = writePngWithPython(svgPath, pngPath);
  assert.equal(rendered, null, "a figure that cannot be rendered reports nothing, and does not throw");
  assert.ok(fs.readdirSync(dir).every((name) => !name.includes(".partial")), "no half-written file is left behind");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stale unreadable file at the target path is never returned as artwork", { skip: !pythonHasPillow() && "python Pillow unavailable" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "figure-render-"));
  const svgPath = path.join(dir, "broken.svg");
  const pngPath = path.join(dir, "broken.png");
  fs.writeFileSync(svgPath, "<svg><unclosed>", "utf8");
  // Exactly the file that killed the cycle: present, non-empty, undecodable.
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));

  assert.equal(writePngWithPython(svgPath, pngPath), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a document-artifact failure is recorded, and the research pass survives it", () => {
  const source = fs.readFileSync(require.resolve("../src/reporting/refresh/full.js"), "utf8");
  const call = source.slice(source.indexOf("buildDocumentArtifacts({"));
  assert.ok(
    /catch \(error\) \{\s*documentArtifactsFailure = \{/.test(source),
    "the document-artifact build is guarded",
  );
  assert.ok(
    source.includes("document_artifacts_failure: documentArtifactsFailure"),
    "the failure reaches the refresh snapshot rather than vanishing",
  );
  assert.ok(call.length > 0);
});
