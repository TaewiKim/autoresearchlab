"use strict";

const fs = require("fs");
const path = require("path");

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function uniqueStrings(values) {
  return Array.from(new Set(asArray(values).map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function collectColumnProfiles(container, out = []) {
  if (!container || typeof container !== "object") return out;
  if (Array.isArray(container)) {
    for (const item of container) collectColumnProfiles(item, out);
    return out;
  }
  for (const key of ["column_profiles", "columns", "schema_columns"]) {
    for (const column of asArray(container[key])) {
      if (typeof column === "string") out.push({ name: column });
      else if (column && typeof column === "object") out.push({ ...column, name: column.name || column.column || column.column_name || column.id || column.label });
    }
  }
  for (const key of ["files", "csvs", "tables", "datasets", "candidate_datasets", "dataset_candidates"]) {
    for (const child of asArray(container[key])) collectColumnProfiles(child, out);
  }
  return out;
}

function inferColumnRole(name, profile = {}) {
  const n = normalizeName(name);
  const type = String(profile.type || profile.dtype || profile.data_type || "").toLowerCase();
  const roles = new Set();
  if (/(^|_)(sample|case|patient|subject|participant|donor|cell|barcode|specimen|aliquot|entity)(_id)?($|_)/.test(n) || /(^|_)id$/.test(n)) roles.add("entity_key");
  if (/(^|_)(time|date|year|month|day|visit|wave|period|baseline|followup)($|_)/.test(n)) roles.add("time_key");
  if (/(^|_)(batch|site|center|platform|source|caller|instrument|group|study|file|run|lane)($|_)/.test(n)) roles.add("batch_or_source");
  if (/(^|_)(sex|gender|age|race|ethnicity|ancestry|smoking|bmi)($|_)/.test(n)) roles.add("batch_or_source");
  if (/(^|_)(outcome|endpoint|response|survival|mortality|score|status|event|label|phenotype|trait|diagnosis|disease|progression|class|group)(_state)?($|_)/.test(n)) roles.add("outcome_candidate");
  if (/(^|_)(expression|expr|rna|tpm|count|abundance|copy|cna|cnv|mutation|methylation|protein|feature|marker|signature|cluster|subtype|exposure|treatment|dose|index|module|gene)(_id|_score|_matrix)?($|_)/.test(n)) roles.add("exposure_candidate");
  if (/int|float|double|numeric|number/.test(type) || profile.numeric === true || Number.isFinite(Number(profile.mean))) roles.add("numeric");
  if (roles.size === 0) roles.add("descriptive");
  return Array.from(roles);
}

function readFirstCsvRow(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const firstLine = buffer.slice(0, bytes).toString("utf8").split(/\r?\n/)[0] || "";
    return firstLine.split(",").map((value) => value.replace(/^"|"$/g, "").trim()).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

function collectDatasetRoots({ cwd = process.cwd(), cycleId = null, datasetRoot = null } = {}) {
  const roots = [];
  if (datasetRoot && fs.existsSync(datasetRoot)) roots.push(datasetRoot);
  if (cycleId) {
    const cycleDatasetDir = path.join(cwd, ".research-lab", "datasets", cycleId);
    if (fs.existsSync(cycleDatasetDir)) {
      for (const entry of fs.readdirSync(cycleDatasetDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(cycleDatasetDir, entry.name);
        if (fs.existsSync(path.join(candidate, "manifest.json")) || fs.existsSync(path.join(candidate, "csv"))) roots.push(candidate);
      }
    }
  }
  return Array.from(new Set(roots));
}

function geoMetadataColumns(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const columns = new Map();
  const add = (name, extra = {}) => {
    const norm = normalizeName(name);
    if (norm && !columns.has(norm)) columns.set(norm, { name, ...extra });
  };
  add("sample_id");
  add("geo_accession");
  add("library_id");
  for (const line of text.split(/\r?\n/)) {
    const first = line.split("\t", 1)[0] || "";
    if (/Sample_source_name/i.test(first)) add("source_name");
    if (/Sample_characteristics/i.test(first) || /Sample_description/i.test(first)) {
      const matches = Array.from(line.matchAll(/"\s*([^":\t]+?)\s*:/g)).map((m) => m[1]);
      for (const label of matches) add(label);
    }
  }
  return Array.from(columns.values());
}

function collectTablesFromDatasetRoot(root) {
  if (!root || !fs.existsSync(root)) return [];
  const tables = [];
  const csvDir = path.join(root, "csv");
  const csvFiles = fs.existsSync(csvDir)
    ? fs.readdirSync(csvDir).filter((name) => name.endsWith(".csv") || name.endsWith(".txt"))
    : [];
  for (const name of csvFiles) {
    const filePath = path.join(csvDir, name);
    if (/geo-metadata/i.test(name)) {
      const columns = geoMetadataColumns(filePath);
      if (columns.length) tables.push({ table_id: name, columns });
      continue;
    }
    const header = readFirstCsvRow(filePath);
    if (!header.length) continue;
    const first = normalizeName(header[0]);
    const sampleLikeCount = header.slice(1).filter((col) => /^vgh\d+/i.test(col) || /^gsm\d+/i.test(col)).length;
    if ((first === "gene_id" || first === "id_ref") && sampleLikeCount >= 5) {
      const assay = /tpm/i.test(name) ? "tpm" : /expected|count/i.test(name) ? "expected_count" : "expression";
      tables.push({
        table_id: name,
        columns: [
          { name: "gene_id", type: "string" },
          { name: `${assay}_matrix`, type: "numeric", numeric: true },
          { name: "sample_id", type: "string" },
        ],
      });
      continue;
    }
    tables.push({ table_id: name, columns: header.slice(0, 200).map((column) => ({ name: column })) });
  }
  return tables;
}

function collectTablesFromContainer(container, tableHint = null, out = []) {
  if (!container || typeof container !== "object") return out;
  if (Array.isArray(container)) {
    for (const item of container) collectTablesFromContainer(item, tableHint, out);
    return out;
  }
  const tableName = container.name || container.table || container.dataset || container.file || container.path || container.id || tableHint;
  const columns = [];
  for (const key of ["column_profiles", "columns", "schema_columns"]) {
    for (const column of asArray(container[key])) {
      const col = typeof column === "string" ? { name: column } : { ...column, name: column?.name || column?.column || column?.column_name || column?.id || column?.label };
      if (col.name) columns.push(col);
    }
  }
  if (tableName && columns.length) {
    out.push({ table_id: String(tableName), columns });
  }
  for (const key of ["files", "csvs", "tables", "datasets", "candidate_datasets", "dataset_candidates"]) {
    for (const child of asArray(container[key])) collectTablesFromContainer(child, tableName, out);
  }
  return out;
}

function tableFromDataGraph(dataGraph = {}) {
  const nodes = asArray(dataGraph.nodes);
  const columnNodes = nodes.filter((node) => ["column", "variable", "feature"].includes(String(node?.type || "").toLowerCase()));
  if (!columnNodes.length) return [];
  return [{
    table_id: "data_graph_columns",
    columns: columnNodes.map((node) => ({ name: node.label || node.id, id: node.id, type: node.type, provenance: node.provenance })),
  }];
}

function buildDatasetProfile({ literature = {}, dataGraph = null, candidateDatasets = [], cwd = process.cwd(), cycleId = null, datasetRoot = null } = {}) {
  const tables = [
    ...collectTablesFromContainer(literature),
    ...collectTablesFromContainer(candidateDatasets),
    ...collectDatasetRoots({ cwd, cycleId, datasetRoot }).flatMap(collectTablesFromDatasetRoot),
    ...tableFromDataGraph(dataGraph || literature?.data_graph || {}),
  ];
  const dedup = new Map();
  for (const table of tables) {
    const key = normalizeName(table.table_id || "table");
    if (!dedup.has(key)) dedup.set(key, { table_id: table.table_id || key, columns: [] });
    const target = dedup.get(key);
    const seen = new Set(target.columns.map((col) => normalizeName(col.name)));
    for (const column of table.columns || []) {
      const name = column.name || column.column || column.id || column.label;
      const norm = normalizeName(name);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      target.columns.push({
        name: String(name),
        normalized_name: norm,
        roles: inferColumnRole(name, column),
        type: column.type || column.dtype || column.data_type || null,
      });
    }
  }
  const profiledTables = Array.from(dedup.values()).filter((table) => table.columns.length);
  const allColumns = profiledTables.flatMap((table) => table.columns.map((column) => ({ ...column, table_id: table.table_id })));
  const roleIndex = (role) => allColumns.filter((column) => asArray(column.roles).includes(role));
  const modalityHints = uniqueStrings(allColumns.flatMap((column) => {
    const n = column.normalized_name;
    const hints = [];
    if (/expression|rna|count|transcript|gene/.test(n)) hints.push("expression_like");
    if (/copy|cna|cnv|segment/.test(n)) hints.push("copy_number_like");
    if (/mutation|variant|maf/.test(n)) hints.push("variant_like");
    if (/clinical|survival|mortality|phenotype|status|event/.test(n)) hints.push("clinical_like");
    if (/methylation|protein|proteomic/.test(n)) hints.push("other_omics_like");
    return hints;
  }));
  return {
    table_count: profiledTables.length,
    tables: profiledTables,
    columns: allColumns,
    entity_keys: roleIndex("entity_key"),
    time_keys: roleIndex("time_key"),
    batch_or_source_fields: roleIndex("batch_or_source"),
    exposure_candidates: roleIndex("exposure_candidate"),
    outcome_candidates: roleIndex("outcome_candidate"),
    numeric_columns: roleIndex("numeric"),
    modality_hints: modalityHints,
    profile_quality: profiledTables.length && allColumns.length ? "structured" : "insufficient_schema",
  };
}

function designCandidate(id, label, feasible, score, rationale, requiredInputs = []) {
  return { design_id: id, label, feasible: Boolean(feasible), feasibility_score: feasible ? score : 0, rationale, required_inputs: requiredInputs };
}

function selectValidationDesigns(profile = {}, hypotheses = []) {
  const hasEntity = asArray(profile.entity_keys).length > 0;
  const hasTime = asArray(profile.time_keys).length > 0;
  const hasBatch = asArray(profile.batch_or_source_fields).length > 0;
  const hasExposure = asArray(profile.exposure_candidates).length > 0;
  const hasOutcome = asArray(profile.outcome_candidates).length > 0;
  const hasTwoNumeric = asArray(profile.numeric_columns).length >= 2;
  const hasMultipleModalities = asArray(profile.modality_hints).length >= 2 || Number(profile.table_count || 0) >= 2;
  const hasHypothesisEdge = asArray(hypotheses).some((h) => h?.x_variable || h?.primary_exposure || h?.y_variable || h?.outcome);
  return [
    designCandidate("paired_concordance", "Paired concordance across tables/modalities", hasEntity && hasMultipleModalities, 88, "Detected join/entity keys and multiple tables or modality hints.", ["entity_key", "two_modalities_or_tables"]),
    designCandidate("source_batch_confounding_audit", "Source/caller/batch confounding audit", hasBatch && (hasOutcome || hasExposure || hasTwoNumeric), 82, "Detected batch/source/caller-like fields plus analyzable outcome/exposure columns.", ["batch_or_source_field", "outcome_or_numeric_feature"]),
    designCandidate("adjusted_association_sensitivity", "Adjusted association with sensitivity checks", (hasExposure && hasOutcome) || hasTwoNumeric, 76, "Detected candidate exposure/outcome or at least two numeric features.", ["exposure", "outcome_or_numeric_feature"]),
    designCandidate("within_unit_or_event_study", "Within-unit change or event-style design", hasEntity && hasTime && hasTwoNumeric, 73, "Detected entity and time keys with numeric measures.", ["entity_key", "time_key", "numeric_feature"]),
    designCandidate("graph_edge_permutation", "Graph-edge permutation or label-shuffle falsification", hasHypothesisEdge && hasEntity && hasTwoNumeric, 70, "Hypothesis has an edge-like claim and the schema has entity keys plus numeric fields.", ["hypothesis_edge", "entity_key", "numeric_feature"]),
    designCandidate("schema_identity_audit", "Dataset identity, schema, and join-key audit", true, Number(profile.profile_quality === "structured" ? 55 : 35), "Always feasible as a pre-validation audit; blocks stronger designs when schema is missing.", ["dataset_manifest_or_schema"]),
  ].sort((a, b) => b.feasibility_score - a.feasibility_score || a.design_id.localeCompare(b.design_id));
}

function findMappedColumn(profile, value) {
  const target = normalizeName(value);
  if (!target || target.startsWith("auto_")) return null;
  return asArray(profile.columns).find((column) => column.normalized_name === target || normalizeName(column.name).includes(target) || target.includes(column.normalized_name)) || null;
}

function buildValidationTarget({ hypothesis = {}, profile = {}, design = null } = {}) {
  const xRaw = hypothesis.x_variable || hypothesis.primary_exposure || asArray(hypothesis.primary_exposure_variables)[0] || null;
  const yRaw = hypothesis.y_variable || hypothesis.outcome || asArray(hypothesis.outcome_variables)[0] || null;
  const xMapped = findMappedColumn(profile, xRaw);
  const yMapped = findMappedColumn(profile, yRaw);
  const exposureCandidates = xMapped ? [xMapped] : asArray(profile.exposure_candidates).slice(0, 5);
  const outcomeCandidates = yMapped ? [yMapped] : asArray(profile.outcome_candidates).slice(0, 5);
  const hasFallbackExposure = exposureCandidates.length || asArray(profile.numeric_columns).length;
  const hasFallbackOutcome = outcomeCandidates.length || asArray(profile.numeric_columns).length >= 2;
  const missing = [];
  if (!asArray(profile.tables).length) missing.push("dataset_schema_or_manifest");
  if (!asArray(profile.entity_keys).length && ["paired_concordance", "within_unit_or_event_study", "graph_edge_permutation"].includes(String(design?.design_id || ""))) missing.push("entity_key");
  if (!hasFallbackExposure) missing.push("exposure_or_numeric_feature");
  if (!hasFallbackOutcome) missing.push("outcome_or_second_numeric_feature");
  if (xRaw && !xMapped && !hasFallbackExposure) missing.push("x_variable_not_mapped_to_schema");
  if (yRaw && !yMapped && !hasFallbackOutcome) missing.push("y_variable_not_mapped_to_schema");
  const mappingWarnings = [];
  if (xRaw && !xMapped && hasFallbackExposure) mappingWarnings.push("x_variable_unmapped_using_profile_exposure_candidates");
  if (yRaw && !yMapped && hasFallbackOutcome) mappingWarnings.push("y_variable_unmapped_using_profile_outcome_candidates");
  return {
    target_hypothesis_id: hypothesis.hypothesis_id || null,
    claim_text: hypothesis.statement || null,
    selected_design_id: design?.design_id || "schema_identity_audit",
    required_data_modalities: asArray(profile.modality_hints),
    required_entity_keys: uniqueStrings(asArray(profile.entity_keys).map((c) => c.name)).slice(0, 5),
    candidate_exposure_variables: exposureCandidates.map((c) => c.name),
    candidate_outcome_variables: outcomeCandidates.map((c) => c.name),
    required_pairing_or_join_keys: uniqueStrings(asArray(profile.entity_keys).map((c) => c.name)).slice(0, 5),
    confounder_or_batch_fields: uniqueStrings(asArray(profile.batch_or_source_fields).map((c) => c.name)).slice(0, 8),
    negative_or_permutation_controls: ["label_shuffle", "entity_key_permutation", "batch_stratified_sensitivity"],
    minimum_artifacts_required: ["dataset_profile", "analysis_trace", "validation_summary", "tabular_result", "figure_or_diagnostic_plot"],
    variable_mapping: {
      x_variable: xRaw ? { requested: xRaw, mapped_column: xMapped?.name || null, table_id: xMapped?.table_id || null } : null,
      y_variable: yRaw ? { requested: yRaw, mapped_column: yMapped?.name || null, table_id: yMapped?.table_id || null } : null,
    },
    mapping_warnings: mappingWarnings,
    design_blocked: missing.length > 0,
    missing_requirements: uniqueStrings(missing),
  };
}

module.exports = {
  buildDatasetProfile,
  selectValidationDesigns,
  buildValidationTarget,
  __private: { normalizeName, inferColumnRole, collectTablesFromContainer, collectTablesFromDatasetRoot },
};
