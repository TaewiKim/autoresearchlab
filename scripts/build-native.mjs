import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(packageRoot, "native", "researchlab-harness");
const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const localCargo = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".cargo", "bin", cargoName);
const cargo = process.env.CARGO || (fs.existsSync(localCargo) ? localCargo : cargoName);

const result = spawnSync(cargo, ["build", "--release"], {
  cwd: nativeRoot,
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
