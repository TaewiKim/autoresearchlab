"use strict";

const { ART_X, ART_Y, MIN_MANUSCRIPT_FONT_SIZE, SLIDE_W_IN, SLIDE_H_IN } = require("./constants");
const { asArray, safeNumber } = require("./utils");

function emu(inches) {
  return Math.round(inches * 914400);
}

function slideBaseTextBoxes(slide) {
  return [
    { name: "panel label", x: ART_X + 0.12, y: ART_Y + 0.1, w: 0.42, h: 0.34, lines: [slide.panel_label], size: 14, first_bold: true, color: "0f766e" },
  ];
}

function normalizedTextBox(box) {
  const lines = asArray(box.lines).map(String);
  const size = Math.max(MIN_MANUSCRIPT_FONT_SIZE, safeNumber(box.size, 12.5));
  const firstSize = Math.max(size, safeNumber(box.first_size || box.firstSize || size, size));
  const largestLineSize = box.first_bold === true || box.firstBold === true ? firstSize : size;
  const minHeight = Math.max(0.12, (Math.max(1, lines.length) * largestLineSize * 1.18) / 72);
  return {
    ...box,
    lines,
    size,
    first_size: box.first_size || box.firstSize ? firstSize : box.first_size,
    h: Math.max(safeNumber(box.h), minHeight),
  };
}

function slideAllTextBoxes(slide) {
  return slideBaseTextBoxes(slide).concat(asArray(slide.text_boxes)).map(normalizedTextBox);
}

function rounded(value) {
  return Number(safeNumber(value).toFixed(3));
}

function textBoxBounds(box) {
  const x = safeNumber(box.x);
  const y = safeNumber(box.y);
  const w = Math.max(0, safeNumber(box.w));
  const h = Math.max(0, safeNumber(box.h));
  return {
    name: String(box.name || "text box"),
    x,
    y,
    w,
    h,
    right: x + w,
    bottom: y + h,
    rotation_degrees: box.rotation_degrees == null ? null : safeNumber(box.rotation_degrees),
    size: safeNumber(box.size, 12),
    lines: asArray(box.lines),
  };
}

function lineWidthEstimateInches(line, size) {
  return String(line || "").length * safeNumber(size, 12) * 0.0058;
}

function evaluateTextBoxQuality(slide) {
  const boxes = slideAllTextBoxes(slide).map(textBoxBounds).filter((box) => box.w > 0 && box.h > 0);
  const minimumFontSize = boxes.reduce((min, box) => Math.min(min, safeNumber(box.size, 0)), Infinity);
  const undersizedTextBoxes = boxes
    .filter((box) => safeNumber(box.size, 0) < MIN_MANUSCRIPT_FONT_SIZE)
    .map((box) => ({
      name: box.name,
      size: rounded(box.size),
    }));
  const outOfBounds = boxes
    .filter((box) => box.x < -0.01 || box.y < -0.01 || box.right > SLIDE_W_IN + 0.01 || box.bottom > SLIDE_H_IN + 0.01)
    .map((box) => ({
      name: box.name,
      x: rounded(box.x),
      y: rounded(box.y),
      w: rounded(box.w),
      h: rounded(box.h),
    }));
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const left = boxes[leftIndex];
      const right = boxes[rightIndex];
      if (left.rotation_degrees || right.rotation_degrees) continue;
      const overlapW = Math.min(left.right, right.right) - Math.max(left.x, right.x);
      const overlapH = Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y);
      if (overlapW <= 0.015 || overlapH <= 0.015) continue;
      const overlapArea = overlapW * overlapH;
      const minArea = Math.max(0.001, Math.min(left.w * left.h, right.w * right.h));
      const ratio = overlapArea / minArea;
      if (ratio < 0.08) continue;
      overlaps.push({
        boxes: [left.name, right.name],
        overlap_w: rounded(overlapW),
        overlap_h: rounded(overlapH),
        overlap_ratio: rounded(ratio),
      });
    }
  }
  const oversizedLines = [];
  for (const box of boxes) {
    if (box.rotation_degrees) continue;
    for (const line of box.lines) {
      const estimatedWidth = lineWidthEstimateInches(line, box.size);
      if (estimatedWidth > box.w * 1.15) {
        oversizedLines.push({
          box: box.name,
          line: String(line || "").slice(0, 80),
          estimated_width: rounded(estimatedWidth),
          box_width: rounded(box.w),
        });
      }
    }
  }
  return {
    passed: overlaps.length === 0 && outOfBounds.length === 0 && undersizedTextBoxes.length === 0,
    text_box_count: boxes.length,
    minimum_font_size: Number.isFinite(minimumFontSize) ? rounded(minimumFontSize) : null,
    minimum_required_font_size: MIN_MANUSCRIPT_FONT_SIZE,
    undersized_text_boxes: undersizedTextBoxes.slice(0, 12),
    overlap_count: overlaps.length,
    overlaps: overlaps.slice(0, 12),
    out_of_bounds: outOfBounds.slice(0, 12),
    text_fit_warning_count: oversizedLines.length,
    text_fit_warnings: oversizedLines.slice(0, 12),
  };
}

module.exports = {
  emu,
  slideBaseTextBoxes,
  normalizedTextBox,
  slideAllTextBoxes,
  rounded,
  textBoxBounds,
  lineWidthEstimateInches,
  evaluateTextBoxQuality,
};
