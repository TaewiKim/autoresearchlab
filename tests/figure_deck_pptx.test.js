"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { buildFigureDeck } = require("../src/reporting/figure_deck");

function pythonForPptxProbe() {
  const venvPython = path.join(__dirname, "..", ".venv", "bin", "python3");
  return fs.existsSync(venvPython) ? venvPython : "python3";
}

test("figure deck builder creates a python-pptx file PowerPoint can parse", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-figure-deck-"));
  const deck = buildFigureDeck({
    root,
    cycleId: "pptx-cycle",
    revision: 1,
    sections: { supplement: { supplement_artifacts: {} } },
    evidence: { metrics: {}, validation_summary: {}, artifacts: {} },
    contentHash: "test",
  });
  const manifest = JSON.parse(fs.readFileSync(deck.manifest_path, "utf8"));
  assert.equal(manifest.pptx_generation_method, "python-pptx");
  assert.equal(manifest.pptx_embedded_artwork_format, "png");
  assert.equal(manifest.slides.length, 3);
  assert.equal(manifest.slides.every((slide) => fs.existsSync(slide.ppt_artwork_png_path)), true);
  assert.equal(manifest.slides.every((slide) => fs.existsSync(slide.paper_image_png_path)), true);
  assert.equal(manifest.slides.every((slide) => slide.text_box_quality?.passed === true), true);
  assert.equal(manifest.slides.every((slide) => Number(slide.text_box_quality?.minimum_font_size) >= 8), true);
  assert.equal(manifest.slides.every((slide) => slide.rendered_image_quality?.passed === true), true);
  assert.equal(manifest.slides.every((slide) => {
    const labels = slide.ppt_text_boxes.map((item) => String(item).toLowerCase());
    return !labels.includes("caption") && !labels.includes("figure title") && !labels.includes("key message");
  }), true);

  const probe = execFileSync(pythonForPptxProbe(), ["-c", `
import json
import sys
import zipfile
from pptx import Presentation

pptx_path = sys.argv[1]
prs = Presentation(pptx_path)
with zipfile.ZipFile(pptx_path) as z:
    media = z.namelist()
print(json.dumps({
    "slide_count": len(prs.slides),
    "media_png_count": len([name for name in media if name.startswith("ppt/media/") and name.endswith(".png")]),
    "media_svg_count": len([name for name in media if name.startswith("ppt/media/") and name.endswith(".svg")]),
    "shape_counts": [len(slide.shapes) for slide in prs.slides],
}))
`, deck.pptx_path], { encoding: "utf8" });
  const parsed = JSON.parse(probe);
  assert.equal(parsed.slide_count, 3);
  assert.equal(parsed.media_png_count, 3);
  assert.equal(parsed.media_svg_count, 0);
  assert.equal(parsed.shape_counts.every((count) => count > 10), true);
});
