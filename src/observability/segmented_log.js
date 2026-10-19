"use strict";

const fs = require("fs");
const path = require("path");

// An append-only log kept as one file per UTC hour:
//
//   <dir>/2026-10-12T03.jsonl
//
// The rule for every log a cycle only ever appends to. Such a log used to be
// one file, written forever and read whole.
//
// MEASURED ON cycle-a-20260919, 2026-10-12, after 23 days:
//   labdirector-decisions.jsonl   12.0 GB  one file
//   labdirector-dialogue.jsonl    12.0 GB  171 files, cut wherever 64 MB fell
//   delivery-receipts.jsonl        1.5 GB  one file, read whole on every bus
//                                          build -- past the 512 MB a string
//                                          can hold, so the read threw, was
//                                          caught, and no message had ever
//                                          been "delivered"
//   labdirector-inbox.jsonl         97 MB  one file, re-read every second
//                                          while the supervisor slept
//
// WRITE: a record goes in the segment of the hour it is appended in. Segments
// therefore sort by name into the order they were written, each is in order
// inside, and a closed hour never changes again.
//
// READ: nothing reads the log as one string. A reader walks segments -- back
// from the newest for "the latest N", forward from a remembered position for
// "what is new", or through all of them a line at a time for a total -- and
// whatever it derives from a closed segment it may keep.
//
// The single file a log used to be is still read, as the oldest segment, for a
// cycle that has not been split. The Rust harness keeps the same layout
// (core::support::segmented_log).

const SEGMENT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

function segmentName(now = new Date()) {
  return `${now.toISOString().slice(0, 13)}.jsonl`;
}

function isSegmentName(name) {
  return SEGMENT_NAME.test(name);
}

// Every complete line of a file from `offset`, without holding the file as one
// string. Returns the offset after the last complete line. A final line with no
// newline is one still being written: a follower leaves it for its next read
// (and gets it whole); a count of what the file holds includes it
// (`includeUnterminated`), as the harness's own count does.
function forEachLine(filePath, offset, onLine, { includeUnterminated = false } = {}) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return offset;
  }
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let position = offset;
    let consumed = offset;
    let pending = [];
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (read <= 0) break;
      position += read;
      let start = 0;
      for (;;) {
        const newline = buffer.indexOf(10, start);
        if (newline < 0 || newline >= read) break;
        const piece = buffer.subarray(start, newline);
        const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
        consumed += line.length + 1;
        pending = [];
        start = newline + 1;
        const text = line.toString("utf8").trim();
        if (text) onLine(text);
      }
      if (start < read) pending.push(Buffer.from(buffer.subarray(start, read)));
    }
    if (includeUnterminated && pending.length) {
      const text = Buffer.concat(pending).toString("utf8").trim();
      if (text) onLine(text);
    }
    return consumed;
  } finally {
    fs.closeSync(fd);
  }
}

function tailLines(filePath, maxBytes) {
  let fd = null;
  try {
    const size = fs.statSync(filePath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, "r");
    const read = fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.subarray(0, read).toString("utf8");
    // A window that starts inside a record starts with a broken one.
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// What was counted in a segment that can no longer change, by path and size.
const closedCounts = new Map();

function segmentedLog({ dir, legacyPath = null }) {
  function segmentPath(now = new Date()) {
    return path.join(dir, segmentName(now));
  }

  function append(rows, { now = new Date(), fsImpl = fs } = {}) {
    const list = Array.isArray(rows) ? rows : [rows];
    if (!list.length) return null;
    const filePath = segmentPath(now);
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.appendFileSync(filePath, `${list.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return filePath;
  }

  // Oldest first; the unsplit single file, when one is still there, first.
  function segments() {
    const found = [];
    if (legacyPath && fs.existsSync(legacyPath)) found.push(legacyPath);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return found;
    }
    for (const name of names.filter(isSegmentName).sort()) found.push(path.join(dir, name));
    return found;
  }

  // The newest `limit` records, newest first.
  function recent({ limit = 8, maxBytesPerSegment = 16 * 1024 * 1024 } = {}) {
    const records = [];
    const all = segments();
    for (let index = all.length - 1; index >= 0 && records.length < limit; index -= 1) {
      const lines = tailLines(all[index], maxBytesPerSegment);
      for (let line = lines.length - 1; line >= 0 && records.length < limit; line -= 1) {
        try {
          records.push(JSON.parse(lines[line]));
        } catch {
          // A record cut short by a crash is not a record.
        }
      }
    }
    return records;
  }

  // Where the log ends right now: what a follower remembers.
  function end() {
    const all = segments();
    const last = all[all.length - 1] || null;
    let offset = 0;
    if (last) {
      try {
        offset = fs.statSync(last).size;
      } catch {
        offset = 0;
      }
    }
    return { segment: last, offset };
  }

  // What was appended since `position`, in order: the rest of the segment the
  // follower was in, then every later segment from its start. `read` is given
  // (filePath, offset) and returns the offset it read up to.
  function follow(position, read) {
    const all = segments();
    let start = position?.segment ? all.indexOf(position.segment) : -1;
    let next = { segment: position?.segment || null, offset: position?.offset || 0 };
    if (start < 0) {
      const name = position?.segment ? path.basename(position.segment) : null;
      // The single file was split under the follower: its records are in the
      // hourly segments now, and replaying those would repeat the whole log.
      if (name && !isSegmentName(name)) return end();
      // No log yet, or the follower's segment is gone: what sorts after it is new.
      start = all.findIndex((segment) => !name || path.basename(segment) > name);
      if (start < 0) return next;
      next = { segment: all[start], offset: 0 };
    }
    for (let index = start; index < all.length; index += 1) {
      const offset = all[index] === next.segment ? next.offset : 0;
      next = { segment: all[index], offset: read(all[index], offset) };
    }
    return next;
  }

  // Every record, oldest first, one line in memory at a time.
  function forEachRecord(onRecord) {
    for (const segment of segments()) {
      forEachLine(segment, 0, (text) => {
        let record;
        try {
          record = JSON.parse(text);
        } catch {
          return;
        }
        onRecord(record, segment);
      }, { includeUnterminated: true });
    }
  }

  // How many records the log holds. A segment that is not the newest cannot
  // change, so it is counted once.
  function countRecords() {
    const all = segments();
    let total = 0;
    all.forEach((segment, index) => {
      let size = 0;
      try {
        size = fs.statSync(segment).size;
      } catch {
        return;
      }
      const key = `${segment}:${size}`;
      const closed = index < all.length - 1;
      if (closedCounts.has(key)) {
        total += closedCounts.get(key);
        return;
      }
      let count = 0;
      forEachLine(segment, 0, () => { count += 1; }, { includeUnterminated: true });
      if (closed) closedCounts.set(key, count);
      total += count;
    });
    return total;
  }

  return { dir, legacyPath, append, countRecords, end, follow, forEachRecord, recent, segmentPath, segments };
}

module.exports = {
  forEachLine,
  isSegmentName,
  segmentName,
  segmentedLog,
};
