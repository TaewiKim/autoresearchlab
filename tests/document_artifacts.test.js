"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildDocumentArtifacts, buildPaperPdf } = require("../src/reporting/document_artifacts");

test("document builder does not start from approval-only gatekeeper draft approval", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-document-gate-"));
  const result = buildDocumentArtifacts({
    cwd,
    cycleId: "document-gate-cycle",
    researcherView: {
      summary: {
        selected_hypothesis: {
          hypothesis_id: "hyp-test",
          statement: "A test hypothesis that should not be drafted before conclusion gate passage.",
        },
      },
    },
    gateReview: {
      gate_passed: false,
      conclusion_gate_passed: false,
      approval_gate_passed: true,
      gatekeeper_review: { verdict: "approve", pending_rubrics: [] },
      gatekeeper_pending_rubrics: [],
      challenge_questions: [],
      blockers: ["gate review deferred until conclusion review becomes eligible"],
    },
  });

  assert.equal(result.built, false);
  assert.equal(result.paper_path, null);
  assert.equal(result.report_path, null);
});

test("paper PDF builder resolves relative TeX paths from the repository cwd", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-paper-pdf-"));
  const binPath = path.join(cwd, "fake-pdflatex");
  fs.writeFileSync(binPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "fake pdfTeX"
  exit 0
fi
outdir=""
tex=""
for arg in "$@"; do
  case "$arg" in
    -output-directory=*) outdir="\${arg#-output-directory=}" ;;
    *.tex) tex="$arg" ;;
  esac
done
test -n "$outdir"
test -f "$tex"
base="$(basename "$tex" .tex)"
mkdir -p "$outdir"
printf "%%PDF-1.5\\n%% fake pdf\\n" > "$outdir/$base.pdf"
`, "utf8");
  fs.chmodSync(binPath, 0o755);

  const oldPdflatex = process.env.RESEARCHLAB_PDFLATEX;
  process.env.RESEARCHLAB_PDFLATEX = binPath;
  try {
    const papersDir = path.join(cwd, ".research-lab", "papers");
    fs.mkdirSync(papersDir, { recursive: true });
    const texPath = path.join(papersDir, "paper-v0001.tex");
    fs.writeFileSync(texPath, "\\documentclass{article}\\begin{document}ok\\end{document}\n", "utf8");

    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const result = buildPaperPdf(".research-lab/papers/paper-v0001.tex");
      assert.equal(result.paper_pdf_build.passed, true);
      assert.equal(result.paper_pdf_build.passes, 2);
      assert.equal(result.paper_pdf_path, path.join(papersDir, "paper-v0001.pdf"));
      assert.equal(fs.existsSync(result.paper_pdf_path), true);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    if (oldPdflatex == null) {
      delete process.env.RESEARCHLAB_PDFLATEX;
    } else {
      process.env.RESEARCHLAB_PDFLATEX = oldPdflatex;
    }
  }
});
