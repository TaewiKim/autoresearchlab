# Analyst canonical reference

The "Data Foundations" layer adapted from Anthropic's self-service
data-analytics design: a governed, snapshot-stable registry the analyst
resolves concepts against first.

## How it is built

`src/agents/shared/canonical_reference.js` derives the registry
deterministically from the cycle data graph (datasets with trust tier +
freshness, families, hypothesis→family routing, per-family reference notes).
It is pinned once per cycle in `lab_director` `loadCyclePlanningContext` and
surfaced (compact) into the analyst role plan as `canonical_reference`, where
`sources_of_truth_policy` tier 1 ("semantic_definitions") points at it.

## reference_notes_overlay.json (governed)

Per-family curated `gotchas` / `routing_triggers` that survive graph rebuilds.
`buildCanonicalReference({ referenceNotesOverlay })` merges this on top of the
graph-derived notes. This is the file the correction harvester edits.

## Correction harvesting (the loop back)

`scripts/harvest_corrections.js` scans gate-review + eval-telemetry correction
signals and distils them into proposed overlay patches:

```
node scripts/harvest_corrections.js --cycle <cycleId>           # writes *.proposed.json + PATCH_SUMMARY.md
node scripts/harvest_corrections.js --cycle <cycleId> --apply   # promotes proposed -> reference_notes_overlay.json
node scripts/harvest_corrections.js --cycle <cycleId> --apply --open-pr
```

Meant to run periodically (same pattern as `scripts/watch_cycle_long_run.sh`).
`--open-pr` is the thin shell that stages the overlay for a `gh pr create`,
colocating the doc change with the data model. Distiller logic lives in
`src/agents/shared/correction_harvester.js`.
