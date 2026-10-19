"use strict";

const path = require("path");
const { runNative } = require("./native_runtime");

// Transient parse failures the Rust harness can hit when a sibling
// process is mid-writing a JSON state file — most commonly a lane's
// final-status.json or a brief seen by the supervisor at the moment
// it serialised an empty buffer. Rather than aborting the whole
// research cycle for a 0-byte read, retry the native call once after
// a short delay; the file will be complete on the second attempt.
const TRANSIENT_NATIVE_PATTERNS = [
  /EOF while parsing a value at line 1 column 0/,
  /expected value at line 1 column 1/,
];

function isTransientNativeError(stderr) {
  return TRANSIENT_NATIVE_PATTERNS.some((re) => re.test(stderr));
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // tight spin acceptable: only used for sub-second retry pauses
  }
}

function runNativeCapture(argv, options = {}) {
  const invoke = () =>
    runNative(argv, {
      ...options,
      buildStdio: ["ignore", "pipe", "pipe"],
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });

  let result = invoke();
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    if (isTransientNativeError(stderr)) {
      sleepSync(750);
      result = invoke();
    }
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `native command failed: ${argv.join(" ")}`);
  }

  const stdout = (result.stdout || "").trim();
  return stdout ? JSON.parse(stdout) : null;
}

function runtimeRoot(cwd = process.cwd()) {
  return path.join(cwd, ".research-lab");
}

module.exports = {
  runNativeCapture,
  runtimeRoot,
};
