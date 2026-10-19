"use strict";

const { buildArtifactReviewMap } = require("./review_map/build");
const { collectReviewMapEntries } = require("./review_map/collect_entries");

module.exports = {
  buildArtifactReviewMap,
  collectReviewMapEntries,
};
