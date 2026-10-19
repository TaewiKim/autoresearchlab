"use strict";

// A correct analyst report stopped the whole cycle.
//
// `isWindowsSetupBlock` detects one specific runtime failure: the Windows
// sandbox setup helper cancelled or left incomplete. When it fires the cycle
// writes RUNTIME_SETUP_BLOCKED with `should_stop: true` and
// `manual_resume_required: true`, and the launch wrapper refuses to relaunch.
// It is the heaviest verdict the self-healer can reach.
//
// MEASURED ON cycle-g-v91, 2026-09-12 23:16 KST, on a LINUX container. The
// loosest branch of the signature was
//
//     (?:sandbox|setup)[^\r\n]*(?:helper|installation)[^\r\n]*(?:cancel|incomplete)
//
// where `[^\r\n]*` was meant to hold the tokens inside one LOG LINE. A minified
// JSON document has no newlines, so the gap spanned the entire file.
// followup-analyst-02 reported that "selection stopped before cloning,
// INSTALLATION, or execution as required by the lane contract", listed
// provisional SETUP_commands, and noted that "the INCOMPLETE novelty audit
// prevents a defensible novelty claim". Three ordinary English words, thousands
// of characters apart, in a document that never mentions Windows.
//
// Third time a substring classifier reading an agent's own prose has taken this
// harness down. v89 halted four hours on a FILENAME containing "quota".

const test = require("node:test");
const assert = require("node:assert");

const { isWindowsSetupBlock } = require("../src/orchestrator/self_healing_cycle");

// The shape of the report that stopped v91: one line, no newlines, Windows
// never mentioned, and the three trigger words far apart and unrelated.
const ANALYST_REPORT = JSON.stringify({
  open_source_analysis_agent_discovery: {
    candidates: [
      {
        name: "a renderer",
        reuse_decision: "reject",
        setup_commands: [
          "Engineer provision a pinned interface and record scalar CPU or required GPU capability.",
        ],
      },
    ],
    query_log: [
      "Reviewed official repositories; selection stopped before cloning, installation, or execution as required by the lane contract.",
    ],
  },
  self_review: {
    failure_modes: ["The incomplete novelty audit prevents a defensible novelty claim."],
  },
});

function onPlatform(platform, run) {
  const previous = process.env.RESEARCHLAB_RUNTIME_PLATFORM;
  process.env.RESEARCHLAB_RUNTIME_PLATFORM = platform;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.RESEARCHLAB_RUNTIME_PLATFORM;
    else process.env.RESEARCHLAB_RUNTIME_PLATFORM = previous;
  }
}

test("an analyst report is not a Windows sandbox failure", () => {
  onPlatform("linux", () => {
    assert.equal(
      isWindowsSetupBlock(ANALYST_REPORT),
      false,
      "the report that stopped cycle-g-v91 is still read as a runtime block",
    );
  });
});

test("distance matters: the tokens must be near each other, not merely present", () => {
  // Even on Windows, three words scattered across a minified document are not
  // evidence of anything. Bounding the gap is the half of the fix that survives
  // if the platform guard is ever loosened.
  onPlatform("win32", () => {
    assert.equal(
      isWindowsSetupBlock(ANALYST_REPORT),
      false,
      "an unbounded gap still lets ordinary prose satisfy the signature",
    );
  });
});

test("the real failure is still caught on Windows", () => {
  onPlatform("win32", () => {
    assert.equal(isWindowsSetupBlock("orchestrator_helper_launch_canceled"), true);
    assert.equal(isWindowsSetupBlock("ShellExecuteExW failed: 1223"), true);
    assert.equal(isWindowsSetupBlock("win32 error 1223"), true);
    assert.equal(
      isWindowsSetupBlock("sandbox setup helper was canceled by the user"),
      true,
      "the signature this exists for no longer matches",
    );
  });
});

test("the signature is unreachable where the thing it describes cannot happen", () => {
  // A Linux container has no Windows sandbox helper, so no text on it can be
  // evidence of one. The cycle that stopped was running on Linux.
  onPlatform("linux", () => {
    assert.equal(isWindowsSetupBlock("orchestrator_helper_launch_canceled"), false);
    assert.equal(isWindowsSetupBlock("sandbox setup helper was canceled by the user"), false);
  });
});
