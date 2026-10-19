"use strict";

const { execFileSync } = require("child_process");

function parsePsRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
      };
    })
    .filter(Boolean)
    .filter((row) => Number.isInteger(row.pid) && Number.isInteger(row.ppid));
}

function isRunPlanForCycle(row, cycleId, cwd = null) {
  const command = String(row?.command || "");
  if (!command.includes("researchlab-harness")) return false;
  if (!command.includes(" run-plan ")) return false;
  if (!command.includes(`--cycle-id ${cycleId}`)) return false;
  if (cwd && !command.includes(cwd)) return false;
  return true;
}

function orphanNativeRunPlanRows({ cycleId, cwd = null, psOutput = null }) {
  const output = psOutput ?? execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
  });
  return parsePsRows(output).filter(
    (row) => row.ppid === 1 && isRunPlanForCycle(row, cycleId, cwd),
  );
}

function cleanupOrphanNativeRunPlans({ cycleId, cwd = null, signal = "SIGTERM" }) {
  const rows = orphanNativeRunPlanRows({ cycleId, cwd });
  const cleaned = [];
  for (const row of rows) {
    try {
      process.kill(row.pid, signal);
      cleaned.push({ pid: row.pid, signal, status: "signalled" });
    } catch (error) {
      cleaned.push({ pid: row.pid, signal, status: "error", message: String(error.message || error) });
    }
  }
  return cleaned;
}

module.exports = {
  cleanupOrphanNativeRunPlans,
  isRunPlanForCycle,
  orphanNativeRunPlanRows,
  parsePsRows,
};
