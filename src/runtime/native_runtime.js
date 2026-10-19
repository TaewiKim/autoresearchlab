"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..", "..");
const nativeRoot = path.join(packageRoot, "native", "researchlab-harness");
const binaryName = process.platform === "win32" ? "researchlab-harness.exe" : "researchlab-harness";

function cargoBin() {
  if (process.env.CARGO) {
    return process.env.CARGO;
  }

  const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
  const candidates = [
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".cargo", "bin", cargoName),
    "/usr/local/cargo/bin/cargo",
    "/home/codespace/.cargo/bin/cargo",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return cargoName;
}

function nativeBuildEnv() {
  const cargoDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".cargo", "bin");
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const env = { ...process.env };
  const prepend = [];

  if (cargoDir && fs.existsSync(cargoDir) && !pathEntries.includes(cargoDir)) {
    prepend.push(cargoDir);
  }

  // The long-running native harness may be launched from cron/nohup/GUI
  // contexts that do not source nvm. In that environment `/usr/local/bin`
  // can even contain stale/broken `codex` symlinks, so make the known-good
  // nvm bins visible before the rest of PATH. This is runtime env, not just
  // build env: codex-agent lanes resolve the Codex CLI from the native process.
  const nvmRoot = path.join(process.env.HOME || "", ".nvm", "versions", "node");
  if (fs.existsSync(nvmRoot)) {
    for (const version of fs.readdirSync(nvmRoot).sort().reverse()) {
      const binDir = path.join(nvmRoot, version, "bin");
      if (fs.existsSync(path.join(binDir, "codex")) && !pathEntries.includes(binDir)) {
        prepend.push(binDir);
      }
    }
  }

  if (prepend.length > 0) {
    env.PATH = [...prepend, ...pathEntries].join(path.delimiter);
  }

  return env;
}

function nativeBinaryPath() {
  return (
    process.env.RESEARCHLAB_NATIVE_BIN ||
    path.join(nativeRoot, "target", "release", binaryName)
  );
}

function newestMtimeMs(rootDir) {
  let newest = 0;
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    for (const entry of fs.readdirSync(current)) {
      if (entry === "target" || entry === "node_modules" || entry.startsWith(".")) continue;
      stack.push(path.join(current, entry));
    }
  }

  return newest;
}

function shouldRebuildNative(nativeBinary) {
  if (!fs.existsSync(nativeBinary)) {
    return true;
  }

  const binaryMtimeMs = fs.statSync(nativeBinary).mtimeMs;
  const sourceRoots = [
    path.join(nativeRoot, "src"),
    path.join(nativeRoot, "Cargo.toml"),
    path.join(nativeRoot, "Cargo.lock"),
  ].filter((candidate) => fs.existsSync(candidate));

  const newestSourceMtimeMs = Math.max(...sourceRoots.map((candidate) => newestMtimeMs(candidate)));
  return newestSourceMtimeMs > binaryMtimeMs;
}

// The source state whose build last failed, so a broken edit is compiled once
// rather than on every native call until someone fixes it.
let failedBuildSourceMtimeMs = null;

function newestNativeSourceMtimeMs() {
  const sourceRoots = [
    path.join(nativeRoot, "src"),
    path.join(nativeRoot, "Cargo.toml"),
    path.join(nativeRoot, "Cargo.lock"),
  ].filter((candidate) => fs.existsSync(candidate));
  return Math.max(0, ...sourceRoots.map((candidate) => newestMtimeMs(candidate)));
}

function ensureNativeBuilt(options = {}) {
  const nativeBinary = nativeBinaryPath();
  const haveBinary = fs.existsSync(nativeBinary);
  if (haveBinary && !shouldRebuildNative(nativeBinary)) {
    return nativeBinary;
  }
  const sourceMtimeMs = newestNativeSourceMtimeMs();
  if (haveBinary && failedBuildSourceMtimeMs !== null && sourceMtimeMs === failedBuildSourceMtimeMs) {
    return nativeBinary;
  }

  const result = spawnSync(cargoBin(), ["build", "--release"], {
    cwd: nativeRoot,
    stdio: options.stdio || "inherit",
    env: nativeBuildEnv(),
    encoding: options.encoding,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    // MEASURED on cycle-a-20260919, 2026-09-28: a source file in the
    // shared volume was mid-edit and did not compile (serde_json's macro
    // recursion limit). This build ran on the next native call, cargo exited
    // 101, and this line used to be process.exit(101) -- so a running cycle,
    // with a working binary on disk from the last good build, died because
    // someone's edit was unfinished. Without a binary there is nothing to run
    // and exiting is right; with one, the last good build is strictly better
    // than a dead cycle. Say so loudly, and do not recompile the same broken
    // state on every call.
    if (!haveBinary) {
      process.exit(result.status || 1);
    }
    failedBuildSourceMtimeMs = sourceMtimeMs;
    console.error(
      `[native] cargo build --release failed (exit ${result.status}); continuing on the last good binary `
      + `${nativeBinary}. Fix the source and the next native call rebuilds.`,
    );
    return nativeBinary;
  }
  failedBuildSourceMtimeMs = null;

  return nativeBinary;
}

function runNative(argv, options = {}) {
  const nativeBinary = ensureNativeBuilt({
    stdio: options.buildStdio,
    encoding: options.encoding,
  });
  const result = spawnSync(nativeBinary, argv, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || "inherit",
    env: {
      ...nativeBuildEnv(),
      RESEARCHLAB_PACKAGE_ROOT: packageRoot,
      ...(options.env || {}),
    },
    encoding: options.encoding,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  return result;
}

module.exports = {
  ensureNativeBuilt,
  nativeBuildEnv,
  nativeBinaryPath,
  packageRoot,
  runNative,
};
