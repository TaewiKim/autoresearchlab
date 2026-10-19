"use strict";

// The other half of the reference monitor.
//
// `message_bound_gate.js` governs ADMISSION: what a record must prove before it
// may enter an active decision. It is a real monitor and it works. It also
// cannot see the failure this programme actually has, because it can only
// refuse a record that ARRIVES. It has no concept of one that never does, so
// downstream these three are one absence:
//
//     never produced   |   produced and never delivered   |   denied
//
// Every failure measured on 2026-09-12 and 13 was the middle one.
// `lab_director_alerts` named its recipient and its reason and was read by
// nothing for two cycles, while cycle-g-v90 and v91 sat at `running: 0` waiting
// for a human. `skipped_lanes` was written by the only component that ever saw
// the stray lane directory, into a field with no reader anywhere in the tree.
// The gatekeeper was asked whether a falsification was adequate and was never
// shown it. None of them is an admission question.
//
// So this asks the delivery question, at runtime, from the cycle's own
// artifacts: for THIS cycle, was the signal produced, and does it appear where
// its consumer reads it. Three verdicts instead of one silence.
//
// What it is not: a claim that every signal in three runtimes is registered.
// Nobody can enumerate those. It answers the question for the signals that are,
// which are the ones whose absence has been measured.

const fs = require("fs");
const path = require("path");

const { interRoleSignals } = require("../policy/dispatch_authority");

const VERDICTS = Object.freeze({
  DELIVERED: "delivered",
  PRODUCED_NOT_DELIVERED: "produced_not_delivered",
  NEVER_PRODUCED: "never_produced",
  NOT_LOCATABLE: "not_locatable",
});

function expand(pattern, cycleId) {
  return pattern.replaceAll("{cycle}", cycleId);
}

/**
 * Files matching a pattern whose wildcards are whole path segments.
 *
 * The first version treated `*` as a filename prefix inside one directory, so
 * `lanes/<cycle>/&#42;/role-plan.json` -- a wildcard in the MIDDLE of the path,
 * which is how every lane artifact is addressed -- matched nothing. The report
 * then said four signals were read by nobody, half an hour after those same
 * four had been measured reaching 16, 34, 17 and 137 role plans.
 *
 * Recorded because the comment above it claimed fifteen lines could not
 * surprise anybody. They can: a pattern language is a parser, and a parser that
 * silently returns the empty set turns a working system into a broken report.
 *
 * Still no dependency, and now segment-wise, which is what the patterns
 * actually use.
 */
function matchFiles(root, pattern) {
  const segments = pattern.split("/").filter((part) => part.length);
  let current = [root];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    const next = [];
    for (const base of current) {
      if (!segment.includes("*")) {
        const candidate = path.join(base, segment);
        if (fs.existsSync(candidate)) next.push(candidate);
        continue;
      }
      // A segment wildcard: every child whose name fits prefix*suffix.
      const [prefix, suffix = ""] = segment.split("*");
      let entries = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
        if (!last && !entry.isDirectory()) continue;
        next.push(path.join(base, entry.name));
      }
    }
    current = next;
    if (!current.length) return [];
  }
  return current.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function carries(file, key) {
  if (!key) return true;           // the artifact's existence IS the signal
  try {
    return fs.readFileSync(file, "utf8").includes(key);
  } catch {
    return false;
  }
}

/**
 * Was this signal produced in this cycle, and did it reach where it is read.
 *
 * `never_produced` is reported rather than judged: a signal raised only when a
 * blocking lane fails is correctly absent in a cycle where none has, and the
 * entry says so in `conditional` so a reader is not told a healthy cycle is
 * broken.
 */
function evaluateDelivery({ root, cycleId, entry }) {
  const base = { signal: entry.signal, what: entry.what, conditional: entry.runtime?.conditional || null };
  if (!entry.runtime) {
    return {
      ...base,
      verdict: VERDICTS.NOT_LOCATABLE,
      reason: entry.runtime_absent_reason || "no runtime locator recorded for this signal",
    };
  }
  const { produced, delivered } = entry.runtime;
  const producedFiles = matchFiles(root, expand(produced.glob, cycleId))
    .filter((file) => carries(file, produced.key));
  const deliveredFiles = matchFiles(root, expand(delivered.glob, cycleId))
    .filter((file) => carries(file, delivered.key));

  if (!producedFiles.length) {
    return {
      ...base,
      verdict: VERDICTS.NEVER_PRODUCED,
      produced: { where: expand(produced.glob, cycleId), count: 0 },
      delivered: { where: expand(delivered.glob, cycleId), count: deliveredFiles.length },
      reason: entry.runtime.conditional
        ? `not produced in this cycle; it is raised ${entry.runtime.conditional}`
        : "not produced in this cycle",
    };
  }
  if (!deliveredFiles.length) {
    return {
      ...base,
      verdict: VERDICTS.PRODUCED_NOT_DELIVERED,
      produced: { where: producedFiles[0], count: producedFiles.length },
      delivered: { where: expand(delivered.glob, cycleId), count: 0 },
      reason: `produced by ${entry.producer.role} and absent from everything ${entry.consumer.role} reads`,
    };
  }
  return {
    ...base,
    verdict: VERDICTS.DELIVERED,
    produced: { where: producedFiles[0], count: producedFiles.length },
    delivered: { where: deliveredFiles[0], count: deliveredFiles.length },
    reason: null,
  };
}

function evaluateCycleDelivery({ root, cycleId }) {
  return interRoleSignals().map((entry) => evaluateDelivery({ root, cycleId, entry }));
}

/** The verdict that means a message was sent to nobody. */
function undeliveredSignals(reports) {
  return reports.filter((report) => report.verdict === VERDICTS.PRODUCED_NOT_DELIVERED);
}

module.exports = {
  VERDICTS,
  evaluateDelivery,
  evaluateCycleDelivery,
  undeliveredSignals,
  matchFiles,
};
