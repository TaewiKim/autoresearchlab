"use strict";

// Where the bus keeps its files, and how to read the one producers write.
//
// This exists so `channels.js` can register a channel whose source is
// `raised.jsonl` without requiring `index.js`, which requires `channels.js`.
// The alternative was to leave those channels out of the registry, which is
// what had happened: two REQUEST channels were raised by name from JS and
// appeared nowhere in the list of channels that exist.

const fs = require("fs");
const path = require("path");

function busRoot(root, cycleId) {
  return path.join(root, "messages", cycleId);
}

function readJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn line is one lost record, not a lost bus.
    }
  }
  return out;
}

/** What producers outside this process have put on the bus. */
function readRaised(root, cycleId) {
  return readJsonl(path.join(busRoot(root, cycleId), "raised.jsonl"));
}

/**
 * The raised entries on one channel, newest wins per item.
 *
 * A producer raising the same thing twice is refreshing it, not queueing a
 * second copy -- identity is the channel plus the item, never the wording.
 */
function raisedOnChannel(root, cycleId, channelId) {
  const byItem = new Map();
  for (const entry of readRaised(root, cycleId)) {
    if (entry?.channel !== channelId || !entry?.subject) continue;
    const itemId = String(entry.item_id || entry.subject).slice(0, 160);
    byItem.set(itemId, { ...entry, item_id: itemId });
  }
  return [...byItem.values()];
}

module.exports = { busRoot, readJsonl, readRaised, raisedOnChannel };
