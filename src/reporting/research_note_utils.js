"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readTextIfExists(filePath, maxChars = 4000) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let text = "";
  let wasTruncated = false;
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = Math.max(1024, Number(maxChars) || 4000);
    if (stat.size > maxBytes) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
      wasTruncated = true;
    } else {
      text = fs.readFileSync(filePath, "utf8");
    }
  } catch {
    return null;
  }
  return wasTruncated || text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function compactText(value, maxChars = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]`;
}

function uniqueStrings(items, limit = Infinity) {
  const seen = new Set();
  const output = [];
  for (const item of asArray(items)) {
    const value = compactText(item, 1200);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function markdownList(items) {
  const values = Array.isArray(items) ? items : [];
  if (values.length === 0) return "- none";
  return values
    .map((item) => {
      if (item && typeof item === "object") {
        return `- ${compactText(item.description || item.summary || item.statement || JSON.stringify(item), 500)}`;
      }
      return `- ${compactText(item, 500)}`;
    })
    .join("\n");
}

function parseJsonPayload(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 1024 * 1024) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function stripReviewPrefix(value) {
  let text = compactText(value, 1200);
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text.replace(
      /^(independent hypothesis gate|conclusion gate|evidence readiness|report gate|paper gate|approval gate|gate review|current approval review)\s*:\s*/i,
      "",
    ).trim();
  }
  return text;
}

function normalizedBlockerKey(value) {
  return stripReviewPrefix(value)
    .toLowerCase()
    .replace(/[^\w\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STALE_BLOCKER_PATTERNS = [
  /\bno lead hypothesis is present\b/i,
  /\bno validation evidence exists\b/i,
  /\bzero evidence packets\b/i,
  /\bpackage is empty\b/i,
  /\bcurrent evidence package is empty\b/i,
  /\bdataset mandate is unresolved\b/i,
  /\bhas not selected an executable fetched bundle\b/i,
  /\bselect at least one fetched geo bundle\b/i,
  /\bretrieve same-dataset papers or dataset landing-page provenance\b/i,
  /\bdefine one or more falsifiable lead hypotheses\b/i,
  /\brequired chronicle .* context is empty\b/i,
  /\bno same-dataset reference baseline has been extracted\b/i,
];

const CURRENT_LEAD_STALE_AUDIT_PATTERNS = [
  /\b8[-\s]?gene\b/i,
  /\bP[-\s]?MCI\b|\bS[-\s]?MCI\b/i,
  /\bpublished AUC\s*0\.93\b/i,
  /\bLOOCV AUC\s*0\.682\b/i,
  /\b0\.682\s+(?:vs|versus)\s+0\.712\b/i,
  /\bage\/sex\b|\bage[-\s]?sex\b|\bcovariate[-\s]?only baseline\b/i,
  /\bsex[-\s]?by[-\s]?diagnosis\b/i,
  /\bCIBERSORT\b|\bleukocyte\b|\bblood[-\s]?cell\b/i,
  /\bsame[-\s]?dataset (?:baseline|paper|reproduction|audit)\b/i,
  /\breproducibility audit\b|\baudit of the published\b/i,
  /\bDESeq2\b.*\bsex\b|\bsex\b.*\bDESeq2\b/i,
  /\bimmune[-\s]?cell deconvolution from (?:the )?(?:open )?.*TPM\b/i,
  /\bnested[-\s]?(?:cross[-\s]?)?validation benchmark of the published\b/i,
  /\bpanel[-\s]?plus[-\s]?covariate\b|\bpublished .*panel\b/i,
  /\bgeneric leukocyte\b|\brepeated[-\s]?subject\b/i,
  /\bthreshold and pancreas\b|\bthreshold\/pancreas\b|\bliterature[-\s]?only threshold\b/i,
  /\bPCA[-\s]?style\b|\bsurrogate PCA\b|\bactual promoted model\b/i,
  /\bretained lead\b.*\bif pivoted\b|\bif (?:you )?pivot(?:ed)? to\b/i,
  /\bmulti[-\s]?omics framing\b|\bsecond modality\b/i,
  /\bexecuted local evidence\b.*\bbaseline\b|\bleakage[-\s]?aware predictive comparison\b/i,
  /\bcross[-\s]?family rivals\b|\bsame[-\s]?paper comparators\b/i,
  /\bpredictor[-\s]?superiority framing\b/i,
];

function extractGeoAccessions(value) {
  return uniqueStrings(String(value || "").match(/\bGSE\d+\b/gi) || []).map((item) => item.toUpperCase());
}

function currentLeadAccessions(options = {}) {
  const explicit = extractGeoAccessions(asArray(options.currentLeadAccessions).join(" "));
  if (explicit.length > 0) return explicit;
  return extractGeoAccessions([
    options.currentLeadText,
    options.currentLeadDataset,
    options.currentLeadHypothesis?.statement,
    options.currentLeadHypothesis?.dataset_or_accession,
    options.currentLeadHypothesis?.selected_accession,
    options.currentLeadHypothesis?.materialized_dataset?.accession,
  ].filter(Boolean).join("\n"));
}

function hasForeignOnlyGeoAccessions(value, accessions) {
  const current = new Set((accessions || []).map((item) => String(item || "").toUpperCase()).filter(Boolean));
  if (current.size === 0) return false;
  const mentioned = extractGeoAccessions(value);
  if (mentioned.length === 0) return false;
  return mentioned.every((item) => !current.has(item));
}

function isCurrentLeadScopedStaleBlocker(value, options = {}) {
  const accessions = currentLeadAccessions(options);
  if (accessions.length === 0) return false;
  const text = stripReviewPrefix(value);
  if (!text) return false;
  if (hasForeignOnlyGeoAccessions(text, accessions)) return true;
  const mentionsCurrent = extractGeoAccessions(text).some((item) => accessions.includes(item));
  const staleAudit = CURRENT_LEAD_STALE_AUDIT_PATTERNS.some((pattern) => pattern.test(text));
  if (!staleAudit) return false;
  if (!mentionsCurrent) return true;
  return /\bpivot(?:ed)?\b|\babandon\b|\bretaining\b|\bwithdraw\b|\bcross[-\s]?family\b|\bstale\b/i.test(text);
}

function extractStillBlocking(value) {
  const text = stripReviewPrefix(value);
  const match = text.match(/still blocking\s*:\s*(.+)$/i);
  return match?.[1] ? compactText(match[1], 700) : "";
}

function matchesResolvedEvidence(value, options = {}) {
  const patterns = Array.isArray(options.resolvedBlockerPatterns) ? options.resolvedBlockerPatterns : [];
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(value);
    return new RegExp(String(pattern), "i").test(value);
  });
}

function addUnique(target, value, seen) {
  const text = stripReviewPrefix(value);
  if (!text) return false;
  const key = normalizedBlockerKey(text);
  if (!key || seen.has(key)) return false;
  seen.add(key);
  target.push(text);
  return true;
}

function classifyReviewBlockers(items, options = {}) {
  const rawBlockers = asArray(items).map(stripReviewPrefix).filter(Boolean).slice(0, 200);
  const hasProgressSignal =
    options.hasLeadHypothesis === true ||
    options.hasValidationEvidence === true ||
    options.hasDataset === true ||
    rawBlockers.some((item) => /resolved|superseded prior|no longer empty/i.test(item));
  const activeBlockers = [];
  const resolvedOrSupersededBlockers = [];
  const staleBlockers = [];
  const duplicateBlockers = [];
  const seenActive = new Set();
  const seenResolved = new Set();
  const seenStale = new Set();

  for (const blocker of rawBlockers) {
    const key = normalizedBlockerKey(blocker);
    const stillBlocking = extractStillBlocking(blocker);
    const resolvedMarker = /resolved|superseded prior|no longer empty/i.test(blocker);
    const stale = hasProgressSignal && STALE_BLOCKER_PATTERNS.some((pattern) => pattern.test(blocker));
    const currentLeadScopedStale = isCurrentLeadScopedStaleBlocker(blocker, options);
    const resolvedByEvidence = matchesResolvedEvidence(blocker, options);

    if (resolvedMarker || resolvedByEvidence) {
      addUnique(resolvedOrSupersededBlockers, blocker, seenResolved);
      if (stillBlocking && !isCurrentLeadScopedStaleBlocker(stillBlocking, options)) {
        addUnique(activeBlockers, `Still blocking: ${stillBlocking}`, seenActive);
      }
      continue;
    }

    if (stale || currentLeadScopedStale) {
      addUnique(staleBlockers, blocker, seenStale);
      addUnique(resolvedOrSupersededBlockers, blocker, seenResolved);
      continue;
    }

    if (seenActive.has(key)) {
      duplicateBlockers.push(blocker);
      continue;
    }
    addUnique(activeBlockers, blocker, seenActive);
  }

  return {
    raw_blocker_count: rawBlockers.length,
    active_blocker_count: activeBlockers.length,
    resolved_or_superseded_blocker_count: resolvedOrSupersededBlockers.length,
    stale_blocker_count: staleBlockers.length,
    duplicate_blocker_count: duplicateBlockers.length,
    active_blockers: activeBlockers,
    resolved_or_superseded_blockers: resolvedOrSupersededBlockers,
    stale_blockers: staleBlockers,
    duplicate_blockers: uniqueStrings(duplicateBlockers, 50),
  };
}

function normalizeAction(item) {
  if (typeof item === "string") {
    return { description: compactText(item, 700), preferred_role: null, type: null };
  }
  if (!item || typeof item !== "object") return null;
  const description = compactText(
    item.description ||
      item.summary ||
      item.action ||
      item.task ||
      item.reason ||
      JSON.stringify(item),
    700,
  );
  if (!description) return null;
  return {
    description,
    preferred_role: item.preferred_role || item.role || null,
    type: item.type || item.action_type || null,
    priority: item.priority || null,
  };
}

function normalizeActions(items, limit = 12) {
  const output = [];
  const seen = new Set();
  for (const item of asArray(items)) {
    const action = normalizeAction(item);
    if (!action) continue;
    const key = `${action.preferred_role || ""}::${action.type || ""}::${action.description}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(action);
    if (output.length >= limit) break;
  }
  return output;
}

module.exports = {
  asArray,
  classifyReviewBlockers,
  compactText,
  ensureDir,
  fileMtimeMs,
  markdownList,
  normalizeActions,
  parseJsonPayload,
  readJsonIfExists,
  readTextIfExists,
  stripReviewPrefix,
  uniqueStrings,
  writeJson,
};
