"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir, readJson, writeJson } = require("../shared/json");

function terminationCodePath({ cwd, cycleId }) {
  return path.join(cwd, ".research-lab", "state", `${cycleId}-termination-code.json`);
}

function readTerminationCode({ cwd, cycleId }) {
  const filePath = terminationCodePath({ cwd, cycleId });
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function clearTerminationCode({ cwd, cycleId }) {
  const filePath = terminationCodePath({ cwd, cycleId });
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures so an explicit run can continue.
  }
  return filePath;
}

function writeTerminationCode({
  cwd,
  cycleId,
  code,
  category,
  reason,
  source = "lab-director",
  shouldStop = true,
  metadata = {},
}) {
  const filePath = terminationCodePath({ cwd, cycleId });
  ensureDir(path.dirname(filePath));
  const payload = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    code,
    category,
    reason,
    source,
    should_stop: shouldStop === true,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
  writeJson(filePath, payload);
  return {
    path: filePath,
    terminationCode: payload,
  };
}

// A provider-quota pause is lifted by the next explicit run of the cycle: the
// person restarting it is the one who knows the limit reset or the account
// changed. Any other pause (a researcher's /pause, a Windows sandbox block)
// has its own resume rule and is left alone.
function clearProviderQuotaPause({ cwd, cycleId }) {
  const stateDir = path.join(cwd, ".research-lab", "state");
  const markerPath = path.join(stateDir, `${cycleId}-labdirector-pause.json`);
  let marker = null;
  try {
    marker = readJson(markerPath);
  } catch {
    return false;
  }
  if (marker?.block_type !== "provider_quota") return false;
  try {
    fs.unlinkSync(markerPath);
  } catch {
    return false;
  }
  return true;
}

module.exports = {
  terminationCodePath,
  readTerminationCode,
  clearTerminationCode,
  clearProviderQuotaPause,
  writeTerminationCode,
};
