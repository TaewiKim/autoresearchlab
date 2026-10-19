#!/usr/bin/env node
"use strict";

// Ask a running cycle whether its signals arrived.
//
// The admission gate answers "may this record enter a decision". This answers
// the question that gate cannot ask: did the record reach the decision at all.
// See src/provenance/delivery_gate.js for why those are different questions and
// why the second is the one this programme keeps failing.

const path = require("path");
const { evaluateCycleDelivery, undeliveredSignals, VERDICTS } = require("../provenance/delivery_gate");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const cycleId = arg("cycle-id");
if (!cycleId) {
  console.error("usage: delivery_report.js --cycle-id <id> [--root <.research-lab path>]");
  process.exit(2);
}
const root = arg("root", path.join(process.cwd(), ".research-lab"));
const reports = evaluateCycleDelivery({ root, cycleId });

const MARK = {
  [VERDICTS.DELIVERED]: "ok      ",
  [VERDICTS.PRODUCED_NOT_DELIVERED]: "UNREAD  ",
  [VERDICTS.NEVER_PRODUCED]: "absent  ",
  [VERDICTS.NOT_LOCATABLE]: "unlocated",
};

for (const report of reports) {
  // A signal nobody has raised, whose readers are already wired, is a channel
  // waiting rather than a channel missing -- and saying "absent" next to a
  // hundred readers reads like a contradiction.
  const wired = report.verdict === VERDICTS.NEVER_PRODUCED && report.delivered?.count > 0;
  const mark = wired ? "wired   " : MARK[report.verdict];
  const counts = report.delivered ? ` (${report.delivered.count} reader artifact(s))` : "";
  console.log(`${mark} ${report.signal}${counts}`);
  if (report.reason) {
    console.log(`          ${wired ? `nothing sent yet; it is raised ${report.conditional || "conditionally"}` : report.reason}`);
  }
}

const unread = undeliveredSignals(reports);
console.log("");
console.log(`${reports.length} signals; ${unread.length} produced and read by nobody`);
if (unread.length) {
  console.log("A message with a recipient and no reader is the shape that cost v90 and v91 two cycles.");
}
process.exit(unread.length ? 1 : 0);
