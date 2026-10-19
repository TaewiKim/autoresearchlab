"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { nativeBuildEnv } = require("../src/runtime/native_runtime");

test("native build env prepends ~/.cargo/bin when shell PATH omits rustup shims", () => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-native-home-"));
  fs.mkdirSync(path.join(home, ".cargo", "bin"), { recursive: true });

  try {
    process.env.HOME = home;
    process.env.PATH = ["/usr/bin", "/bin"].join(path.delimiter);

    const env = nativeBuildEnv();
    assert.equal(env.PATH.split(path.delimiter)[0], path.join(home, ".cargo", "bin"));
    assert.equal(process.env.PATH, ["/usr/bin", "/bin"].join(path.delimiter));
  } finally {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
  }
});

test("native runtime env prepends nvm codex bins before stale system paths", () => {
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-native-home-"));
  const nvmBin = path.join(home, ".nvm", "versions", "node", "v99.0.0", "bin");
  fs.mkdirSync(nvmBin, { recursive: true });
  fs.writeFileSync(path.join(nvmBin, "codex"), "#!/bin/sh\n", "utf8");

  try {
    process.env.HOME = home;
    process.env.PATH = ["/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);

    const env = nativeBuildEnv();
    const entries = env.PATH.split(path.delimiter);
    assert.equal(entries[0], nvmBin);
    assert.equal(entries.includes("/usr/local/bin"), true);
    assert.equal(process.env.PATH, ["/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter));
  } finally {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
  }
});

test("a failed rebuild keeps the cycle on its last good binary, and does not retry the same source", () => {
  // MEASURED on cycle-a-20260919, 2026-09-28: a source file in the
  // shared volume was mid-edit and did not compile; the next native call rebuilt,
  // cargo exited 101, and ensureNativeBuilt called process.exit(101) -- killing a
  // running cycle that had a working binary on disk.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-native-rebuild-"));
  const runtimeDir = path.join(root, "src", "runtime");
  const nativeRoot = path.join(root, "native", "researchlab-harness");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, "target", "release"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "..", "src", "runtime", "native_runtime.js"), path.join(runtimeDir, "native_runtime.js"));

  const binaryName = process.platform === "win32" ? "researchlab-harness.exe" : "researchlab-harness";
  const binary = path.join(nativeRoot, "target", "release", binaryName);
  fs.writeFileSync(binary, "last good build", "utf8");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(binary, past, past);
  fs.writeFileSync(path.join(nativeRoot, "src", "main.rs"), "fn main() { this does not compile }\n", "utf8");

  const calls = path.join(root, "cargo-calls");
  const fakeCargo = path.join(root, process.platform === "win32" ? "cargo.cmd" : "cargo");
  fs.writeFileSync(
    fakeCargo,
    process.platform === "win32"
      ? `@echo off\r\necho x>> "${calls}"\r\nexit /b 101\r\n`
      : `#!/bin/sh\necho x >> "${calls}"\nexit 101\n`,
    "utf8",
  );
  fs.chmodSync(fakeCargo, 0o755);

  const previousCargo = process.env.CARGO;
  const previousBin = process.env.RESEARCHLAB_NATIVE_BIN;
  const originalExit = process.exit;
  const originalError = console.error;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`); };
  console.error = () => {};
  try {
    process.env.CARGO = fakeCargo;
    delete process.env.RESEARCHLAB_NATIVE_BIN;
    const { ensureNativeBuilt } = require(path.join(runtimeDir, "native_runtime.js"));

    assert.equal(ensureNativeBuilt({ stdio: "ignore" }), binary, "a failed rebuild should fall back to the last good binary");
    assert.equal(ensureNativeBuilt({ stdio: "ignore" }), binary);
    assert.equal(exitCode, null, "the cycle exited because an edit did not compile");
    assert.equal(fs.readFileSync(calls, "utf8").trim().split(/\r?\n/).length, 1, "the same broken source was compiled twice");
  } finally {
    process.exit = originalExit;
    console.error = originalError;
    if (previousCargo === undefined) delete process.env.CARGO; else process.env.CARGO = previousCargo;
    if (previousBin === undefined) delete process.env.RESEARCHLAB_NATIVE_BIN; else process.env.RESEARCHLAB_NATIVE_BIN = previousBin;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
