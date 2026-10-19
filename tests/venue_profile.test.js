"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  inferVenueProfile,
  shapeSectionOutlineForVenue,
} = require("../src/policy/venue_profile");

test("venue profile infers medical observational framing from literature venues", () => {
  const profile = inferVenueProfile({
    papers: [
      { venue: "The Lancet", title: "Coverage and survival" },
      { venue: "BMJ", title: "Measurement quality in vaccine coverage" },
    ],
  });

  assert.equal(profile.profile_id, "medical_observational");
  assert.equal(profile.outline_strategy, "measurement_before_mechanism");
});

test("venue profile reorders outline according to the inferred strategy", () => {
  const sections = shapeSectionOutlineForVenue({
    venueProfile: {
      profile_id: "medical_observational",
      preferred_section_order: [
        "motivation-gap",
        "measurement-design",
        "mechanism-rivals",
      ],
    },
    sections: [
      { section_id: "mechanism-rivals", title: "Mechanisms" },
      { section_id: "measurement-design", title: "Measurement" },
      { section_id: "motivation-gap", title: "Gap" },
    ],
  });

  assert.deepEqual(sections.map((item) => item.section_id), [
    "motivation-gap",
    "measurement-design",
    "mechanism-rivals",
  ]);
});
