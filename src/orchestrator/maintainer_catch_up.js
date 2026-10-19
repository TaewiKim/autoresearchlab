"use strict";

// A maintainer pass owed by a run-research that reloaded onto new source.
//
// The maintainer looks at a cycle after each run-plan, once the derived state
// is refreshed. When the harness source changed during that run-plan, the
// refresh refuses to write from mixed revisions (runtime/source_revision.js)
// and the process exits 75 to be restarted on the new source -- before the
// maintainer's pass. Every commit therefore cost the next pass, the
// maintainer's own commits included.
//
// MEASURED ON cycle-a-20260919, 2026-10-18/19: no maintainer pass
// from 21:09 to 01:45 (its health, progress and budget records all last
// written at 21:08) across three reloads, while runners 514/515 repeated a
// measurement the new repeated_result detector exists to catch.
//
// The exiting process leaves this note; the next one, on the new source, makes
// the pass first.

const fs = require("fs");
const path = require("path");

function catchUpPath(cwd, cycleId) {
  return path.join(cwd, ".research-lab", "runtime", `${cycleId}-maintainer-catch-up.json`);
}

function noteMaintainerCatchUp({ cwd, cycleId, reason }) {
  if (!cycleId) return;
  try {
    const filePath = catchUpPath(cwd, cycleId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ cycle_id: cycleId, noted_at: new Date().toISOString(), reason: String(reason || "") })}\n`);
  } catch {
    // Without the note the next run-plan's pass still comes; one is late.
  }
}

// True once, when a pass is owed; the note is gone afterwards.
function takeMaintainerCatchUp({ cwd, cycleId }) {
  const filePath = catchUpPath(cwd, cycleId);
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    return false;
  }
  return true;
}

module.exports = { catchUpPath, noteMaintainerCatchUp, takeMaintainerCatchUp };
