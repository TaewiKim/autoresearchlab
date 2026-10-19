"use strict";

const {
  escapeHtml,
  formatSigned,
  outcomeTone,
} = require("./shared");

function barChartSvg(items, options = {}) {
  const width = options.width || 760;
  const height = options.height || 260;
  const maxValue = Math.max(1, ...items.map((item) => Number(item.value) || 0));
  const barWidth = Math.max(40, Math.floor((width - 60) / Math.max(1, items.length)));

  const bars = items
    .map((item, index) => {
      const value = Number(item.value) || 0;
      const x = 40 + index * barWidth;
      const barHeight = Math.round((value / maxValue) * (height - 80));
      const y = height - 40 - barHeight;
      const label = escapeHtml(item.label);
      const fill = item.color || "#2563eb";
      return `
        <rect x="${x}" y="${y}" width="${barWidth - 12}" height="${barHeight}" rx="8" fill="${fill}"></rect>
        <text x="${x + (barWidth - 12) / 2}" y="${y - 8}" text-anchor="middle" font-size="12" fill="#0f172a">${value}</text>
        <text x="${x + (barWidth - 12) / 2}" y="${height - 14}" text-anchor="middle" font-size="11" fill="#475569">${label}</text>
      `;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="Research cycle metrics">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <line x1="30" y1="${height - 40}" x2="${width - 10}" y2="${height - 40}" stroke="#cbd5e1" />
      ${bars}
    </svg>
  `;
}

function renderSignalScorecardSvg(items, options = {}) {
  const width = options.width || 920;
  const height = options.height || 300;
  const margin = { top: 36, right: 36, bottom: 52, left: 180 };
  const innerWidth = width - margin.left - margin.right;
  const rowHeight = 88;
  const centerX = margin.left + innerWidth / 2;
  const maxAbs = Math.max(
    0.45,
    ...items.flatMap((item) => [item.pooled, item.adjusted, item.regression].map((value) => Math.abs(Number(value) || 0))),
  );
  const scale = (value) => (Math.abs(Number(value) || 0) / maxAbs) * (innerWidth / 2 - 36);

  const rows = items.map((item, index) => {
    const y = margin.top + index * rowHeight;
    const pooled = Number(item.pooled) || 0;
    const adjusted = Number(item.adjusted) || 0;
    const regression = Number(item.regression) || 0;
    const pooledWidth = scale(pooled);
    const adjustedWidth = scale(adjusted);
    const regWidth = scale(regression);
    const direction = pooled >= 0 ? 1 : -1;
    const pooledX = direction >= 0 ? centerX : centerX - pooledWidth;
    const adjustedDirection = adjusted >= 0 ? 1 : -1;
    const adjustedX = adjustedDirection >= 0 ? centerX : centerX - adjustedWidth;
    const regDirection = regression >= 0 ? 1 : -1;
    const regX = regDirection >= 0 ? centerX : centerX - regWidth;
    return `
      <text x="${margin.left - 16}" y="${y + 22}" text-anchor="end" font-size="15" font-weight="700" fill="#0f172a">${escapeHtml(item.label)}</text>
      <text x="${margin.left - 16}" y="${y + 42}" text-anchor="end" font-size="12" fill="#64748b">${escapeHtml(item.note || "")}</text>
      <rect x="${pooledX}" y="${y}" width="${pooledWidth}" height="18" rx="9" fill="${outcomeTone(pooled)}"></rect>
      <rect x="${adjustedX}" y="${y + 24}" width="${adjustedWidth}" height="12" rx="6" fill="#1d4ed8" opacity="0.82"></rect>
      <rect x="${regX}" y="${y + 44}" width="${regWidth}" height="12" rx="6" fill="#7c3aed" opacity="0.82"></rect>
      <text x="${direction >= 0 ? pooledX + pooledWidth + 8 : pooledX - 8}" y="${y + 13}" text-anchor="${direction >= 0 ? "start" : "end"}" font-size="12" fill="#0f172a">pooled ${formatSigned(pooled)}</text>
      <text x="${adjustedDirection >= 0 ? adjustedX + adjustedWidth + 8 : adjustedX - 8}" y="${y + 34}" text-anchor="${adjustedDirection >= 0 ? "start" : "end"}" font-size="12" fill="#1e3a8a">adjusted ${formatSigned(adjusted)}</text>
      <text x="${regDirection >= 0 ? regX + regWidth + 8 : regX - 8}" y="${y + 54}" text-anchor="${regDirection >= 0 ? "start" : "end"}" font-size="12" fill="#6d28d9">reg ${formatSigned(regression)}</text>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Primary outcome chart")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <line x1="${centerX}" y1="${margin.top - 10}" x2="${centerX}" y2="${height - margin.bottom + 10}" stroke="#94a3b8" stroke-dasharray="5 5"></line>
      <text x="${centerX + 10}" y="${height - 18}" font-size="12" fill="#64748b">supports claim</text>
      <text x="${centerX - 10}" y="${height - 18}" text-anchor="end" font-size="12" fill="#64748b">opposes claim</text>
      <text x="${margin.left}" y="22" font-size="12" fill="#475569">Pooled, adjusted, and model-based evidence signals</text>
      ${rows}
    </svg>
  `;
}

function renderPrimarySignalSummarySvg(items, options = {}) {
  const width = options.width || 980;
  const rowHeight = 52;
  const height = options.height || Math.max(320, 108 + items.length * rowHeight);
  const margin = { top: 64, right: 156, bottom: 44, left: 240 };
  const innerWidth = width - margin.left - margin.right;
  const zeroX = margin.left + innerWidth / 2;
  const summaryText = options.summaryText || "Adjustment changes the pooled signal, but every decision-critical check remains on the same side of zero.";
  const supportLabel = options.supportLabel || "supports claim";
  const opposeLabel = options.opposeLabel || "opposes claim";
  const values = items.map((item) => Number(item.value)).filter((value) => Number.isFinite(value));
  const maxAbs = Math.max(0.15, ...values.map((value) => Math.abs(value)));
  const scale = (value) => (Math.abs(Number(value) || 0) / maxAbs) * (innerWidth / 2 - 28);
  const pooledItem = items.find((item) => /pooled/i.test(item.label || ""));
  const pooledValue = Number(pooledItem?.value);

  const rows = items.map((item, index) => {
    const y = margin.top + index * rowHeight;
    const value = Number(item.value) || 0;
    const barWidth = scale(value);
    const barX = value >= 0 ? zeroX : zeroX - barWidth;
    const deltaVsPooled = Number.isFinite(pooledValue) ? value - pooledValue : null;
    const deltaLabel = Number.isFinite(deltaVsPooled)
      ? deltaVsPooled === 0
        ? "same as pooled"
        : `${deltaVsPooled > 0 ? "+" : ""}${deltaVsPooled.toFixed(2)} vs pooled`
      : item.note || "";
    const labelFill = value >= 0 ? "#0f766e" : "#991b1b";
    const valueFill = value >= 0 ? "#166534" : "#991b1b";
    return `
      <text x="${margin.left - 16}" y="${y + 16}" text-anchor="end" font-size="13" font-weight="700" fill="${labelFill}">${escapeHtml(item.label)}</text>
      <text x="${margin.left - 16}" y="${y + 34}" text-anchor="end" font-size="11" fill="#64748b">${escapeHtml(item.note || "")}</text>
      <line x1="${zeroX}" y1="${y - 6}" x2="${zeroX}" y2="${y + 30}" stroke="#cbd5e1" stroke-dasharray="4 4"></line>
      <rect x="${barX}" y="${y + 2}" width="${Math.max(2, barWidth)}" height="20" rx="10" fill="${escapeHtml(item.color || "#0f766e")}"></rect>
      <circle cx="${zeroX}" cy="${y + 12}" r="3.5" fill="#ffffff" stroke="#94a3b8"></circle>
      <text x="${value >= 0 ? barX + barWidth + 10 : barX - 10}" y="${y + 16}" text-anchor="${value >= 0 ? "start" : "end"}" font-size="12" font-weight="700" fill="${valueFill}">${formatSigned(value)}</text>
      <text x="${zeroX}" y="${y + 34}" text-anchor="middle" font-size="10" fill="#64748b">${escapeHtml(deltaLabel)}</text>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Primary evidence summary")}">
      <defs>
        <linearGradient id="primary-signal-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#eff6ff"></stop>
          <stop offset="100%" stop-color="#f8fafc"></stop>
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="${width}" height="${height}" fill="url(#primary-signal-bg)"></rect>
      <text x="${margin.left}" y="28" font-size="12" fill="#475569">${escapeHtml(summaryText)}</text>
      <text x="${margin.left + 8}" y="28" font-size="11" fill="#991b1b">${escapeHtml(opposeLabel)}</text>
      <text x="${margin.left + innerWidth - 8}" y="28" text-anchor="end" font-size="11" fill="#166534">${escapeHtml(supportLabel)}</text>
      ${rows}
    </svg>
  `;
}

function renderPrimaryClaimBridgeSvg(items, options = {}) {
  const width = options.width || 980;
  const height = options.height || 360;
  const margin = { top: 72, right: 56, bottom: 58, left: 70 };
  const usableWidth = width - margin.left - margin.right;
  const step = items.length > 1 ? usableWidth / (items.length - 1) : 0;
  const axisY = height / 2 + 10;
  const values = items.map((item) => Number(item.value)).filter((value) => Number.isFinite(value));
  const maxAbs = Math.max(0.12, ...values.map((value) => Math.abs(value)));
  const valueScale = (value) => axisY - (Number(value) || 0) / maxAbs * 92;

  const points = items.map((item, index) => {
    const x = margin.left + index * step;
    const y = valueScale(item.value);
    return { item, x, y };
  });

  const pathData = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const supportItems = items.filter((item) => item.kind !== "adjusted");
  const leadItem = items.find((item) => item.kind === "adjusted") || items[0];
  const leadText = leadItem
    ? `${options.claimLabel || "Lead claim"}: adjusted signal stays ${Number(leadItem.value) >= 0 ? "positive" : "negative"} at ${formatSigned(leadItem.value)}.`
    : "";
  const supportText = supportItems.length
    ? `${options.supportRangeLabel || "Support checks stay"} between ${formatSigned(Math.min(...supportItems.map((item) => Number(item.value) || 0)))} and ${formatSigned(Math.max(...supportItems.map((item) => Number(item.value) || 0)))}.`
    : "";

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Primary claim bridge")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <text x="${margin.left}" y="24" font-size="12" fill="#475569">${escapeHtml(options.summaryText || "The adjusted estimate is the decision point; pooled, change, and lag checks show the sign does not collapse when the framing changes.")}</text>
      <line x1="${margin.left}" y1="${axisY}" x2="${width - margin.right}" y2="${axisY}" stroke="#cbd5e1"></line>
      <path d="${pathData}" fill="none" stroke="#0f766e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
      ${points.map((point) => `
      <circle cx="${point.x}" cy="${point.y}" r="7" fill="${point.item.kind === "adjusted" ? "#7c3aed" : "#0f766e"}"></circle>
      <text x="${point.x}" y="${point.y - 14}" text-anchor="middle" font-size="12" font-weight="700" fill="#0f172a">${formatSigned(point.item.value)}</text>
      <text x="${point.x}" y="${axisY + 18}" text-anchor="middle" font-size="12" font-weight="700" fill="#0f172a">${escapeHtml(point.item.short_label || point.item.label)}</text>
      <text x="${point.x}" y="${axisY + 34}" text-anchor="middle" font-size="11" fill="#64748b">${escapeHtml(point.item.note || "")}</text>
      `).join("")}
      <rect x="${width - 320}" y="18" width="284" height="52" rx="14" fill="#ffffff" stroke="#e2e8f0"></rect>
      <text x="${width - 300}" y="39" font-size="11" font-weight="700" fill="#0f172a">${escapeHtml(leadText)}</text>
      <text x="${width - 300}" y="57" font-size="11" fill="#475569">${escapeHtml(supportText)}</text>
    </svg>
  `;
}

function renderSubgroupHeterogeneitySvg(items, options = {}) {
  const width = options.width || 980;
  const rowHeight = 56;
  const height = options.height || Math.max(340, 120 + items.length * rowHeight);
  const margin = { top: 68, right: 124, bottom: 44, left: 224 };
  const innerWidth = width - margin.left - margin.right;
  const zeroX = margin.left + innerWidth / 2;
  const values = items
    .flatMap((item) => [item.primary, item.secondary, item.value, item.effect])
    .filter((value) => Number.isFinite(Number(value)));
  const maxAbs = Math.max(0.12, ...values.map((value) => Math.abs(Number(value))));
  const scale = (value) => (Math.abs(Number(value) || 0) / maxAbs) * (innerWidth / 2 - 30);

  const rows = items.map((item, index) => {
    const y = margin.top + index * rowHeight;
    const primary = Number(item.primary ?? item.value ?? item.effect) || 0;
    const secondary = Number(item.secondary ?? item.comparator) || 0;
    const primaryWidth = scale(primary);
    const secondaryWidth = scale(secondary);
    const primaryX = primary >= 0 ? zeroX : zeroX - primaryWidth;
    const secondaryX = secondary >= 0 ? zeroX : zeroX - secondaryWidth;
    const groupMeta = item.note || `${item.group_count || item.region_count || "n/a"} slices`;
    return `
      <text x="${margin.left - 16}" y="${y + 16}" text-anchor="end" font-size="14" font-weight="700" fill="#0f172a">${escapeHtml(item.label)}</text>
      <text x="${margin.left - 16}" y="${y + 31}" text-anchor="end" font-size="10" fill="#64748b">${escapeHtml(groupMeta)}</text>
      <rect x="${primaryX}" y="${y + 2}" width="${Math.max(2, primaryWidth)}" height="14" rx="7" fill="#0f766e"></rect>
      <rect x="${secondaryX}" y="${y + 20}" width="${Math.max(2, secondaryWidth)}" height="14" rx="7" fill="#b91c1c"></rect>
      <text x="${primary >= 0 ? primaryX + primaryWidth + 8 : primaryX - 8}" y="${y + 10}" text-anchor="${primary >= 0 ? "start" : "end"}" font-size="11" fill="#0f766e">primary ${formatSigned(primary)}</text>
      <text x="${secondary >= 0 ? secondaryX + secondaryWidth + 8 : secondaryX - 8}" y="${y + 28}" text-anchor="${secondary >= 0 ? "start" : "end"}" font-size="11" fill="#991b1b">secondary ${formatSigned(secondary)}</text>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Subgroup heterogeneity chart")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <line x1="${zeroX}" y1="${margin.top - 14}" x2="${zeroX}" y2="${height - margin.bottom + 10}" stroke="#cbd5e1" stroke-dasharray="4 4"></line>
      <text x="${margin.left}" y="28" font-size="12" fill="#475569">${escapeHtml(options.summaryText || "Subgroup slices mainly vary in magnitude; the question is whether the sign survives across groups.")}</text>
      ${rows}
    </svg>
  `;
}

function renderRobustnessSvg(items, options = {}) {
  const width = options.width || 980;
  const rowHeight = 52;
  const height = options.height || Math.max(340, 120 + items.length * rowHeight);
  const margin = { top: 68, right: 156, bottom: 44, left: 224 };
  const innerWidth = width - margin.left - margin.right;
  const zeroX = margin.left + innerWidth / 2;
  const values = items
    .flatMap((item) => [item.primary, item.secondary, item.value, item.effect])
    .filter((value) => Number.isFinite(Number(value)));
  const maxAbs = Math.max(0.12, ...values.map((value) => Math.abs(Number(value))));
  const scale = (value) => (Math.abs(Number(value) || 0) / maxAbs) * (innerWidth / 2 - 28);

  const rows = items.map((item, index) => {
    const y = margin.top + index * rowHeight;
    const primary = Number(item.primary ?? item.value ?? item.effect) || 0;
    const secondary = Number(item.secondary ?? item.comparator) || 0;
    const sampleNote = item.note || `drop ${item.label}`;
    const primaryWidth = scale(primary);
    const secondaryWidth = scale(secondary);
    const primaryX = primary >= 0 ? zeroX : zeroX - primaryWidth;
    const secondaryX = secondary >= 0 ? zeroX : zeroX - secondaryWidth;
    return `
      <text x="${margin.left - 14}" y="${y + 14}" text-anchor="end" font-size="13" fill="#0f172a">${escapeHtml(item.label)}</text>
      <text x="${margin.left - 14}" y="${y + 28}" text-anchor="end" font-size="10" fill="#64748b">${escapeHtml(sampleNote)}</text>
      <rect x="${primaryX}" y="${y + 1}" width="${Math.max(2, primaryWidth)}" height="12" rx="6" fill="#0f766e"></rect>
      <rect x="${secondaryX}" y="${y + 18}" width="${Math.max(2, secondaryWidth)}" height="12" rx="6" fill="#b91c1c"></rect>
      <text x="${primary >= 0 ? primaryX + primaryWidth + 8 : primaryX - 8}" y="${y + 10}" text-anchor="${primary >= 0 ? "start" : "end"}" font-size="11" fill="#0f766e">${formatSigned(primary)}</text>
      <text x="${secondary >= 0 ? secondaryX + secondaryWidth + 8 : secondaryX - 8}" y="${y + 26}" text-anchor="${secondary >= 0 ? "start" : "end"}" font-size="11" fill="#991b1b">${formatSigned(secondary)}</text>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Robustness chart")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <line x1="${zeroX}" y1="${margin.top - 14}" x2="${zeroX}" y2="${height - margin.bottom + 10}" stroke="#cbd5e1" stroke-dasharray="4 4"></line>
      <text x="${margin.left}" y="28" font-size="12" fill="#475569">${escapeHtml(options.summaryText || "If no single subgroup omission flips the sign, the result is not being carried by one subgroup.")}</text>
      ${rows}
    </svg>
  `;
}

function renderPromotedHypothesesSummarySvg(items, options = {}) {
  const width = options.width || 780;
  const height = options.height || Math.max(260, 90 + items.length * 44);
  const maxValue = Math.max(1, ...items.map((item) => Number(item.value) || 0));
  const margin = { top: 48, right: 28, bottom: 28, left: 220 };
  const innerWidth = width - margin.left - margin.right;
  const rows = items.map((item, index) => {
    const y = margin.top + index * 40;
    const value = Number(item.value) || 0;
    const barWidth = (value / maxValue) * (innerWidth - 20);
    return `
      <text x="${margin.left - 16}" y="${y + 14}" text-anchor="end" font-size="13" fill="#0f172a">${escapeHtml(item.label)}</text>
      <rect x="${margin.left}" y="${y}" width="${barWidth}" height="14" rx="7" fill="${item.color || "#2563eb"}"></rect>
      <text x="${margin.left + barWidth + 10}" y="${y + 11}" font-size="11" fill="#0f172a">${escapeHtml(String(value))}</text>
      <text x="${margin.left}" y="${y + 30}" font-size="10" fill="#64748b">${escapeHtml(item.note || "")}</text>
    `;
  }).join("");
  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Promoted hypothesis support summary")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <text x="${margin.left}" y="24" font-size="12" fill="#475569">${escapeHtml(options.summaryText || "How many executed support checks back each promoted hypothesis.")}</text>
      ${rows}
    </svg>
  `;
}

function renderValidationCoverageSvg(items, options = {}) {
  const width = options.width || 860;
  const height = options.height || Math.max(260, 100 + items.length * 46);
  const margin = { top: 56, right: 32, bottom: 30, left: 200 };
  const innerWidth = width - margin.left - margin.right;
  const maxChecks = Math.max(1, ...items.map((item) => Number(item.check_count) || 0));
  const rows = items.map((item, index) => {
    const y = margin.top + index * 42;
    const checkWidth = ((Number(item.check_count) || 0) / maxChecks) * Math.max(80, innerWidth - 240);
    return `
      <text x="${margin.left - 16}" y="${y + 13}" text-anchor="end" font-size="12" fill="#0f172a">${escapeHtml(item.label)}</text>
      <rect x="${margin.left}" y="${y}" width="${checkWidth}" height="12" rx="6" fill="#2563eb"></rect>
      <text x="${margin.left + checkWidth + 8}" y="${y + 10}" font-size="11" fill="#0f172a">${escapeHtml(String(item.check_count))} checks</text>
      <text x="${width - margin.right - 116}" y="${y + 10}" font-size="11" fill="#1d4ed8">method ${escapeHtml(String(item.method_score ?? "n/a"))}</text>
      <text x="${width - margin.right - 36}" y="${y + 10}" font-size="11" fill="#7c3aed">acc ${escapeHtml(String(item.accuracy_score ?? "n/a"))}</text>
      <text x="${margin.left}" y="${y + 28}" font-size="10" fill="#64748b">${escapeHtml(item.note || "")}</text>
    `;
  }).join("");
  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Validation coverage summary")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      <text x="${margin.left}" y="24" font-size="12" fill="#475569">${escapeHtml(options.summaryText || "Coverage of executed checks across the promoted-hypothesis support set.")}</text>
      ${rows}
    </svg>
  `;
}

function renderMetricTiles(items) {
  return `
    <div class="mini-card-grid">
      ${items.map((item) => `
        <article class="mini-card" data-tone="${escapeHtml(item.tone || "neutral")}">
          <div class="k">${escapeHtml(item.label || "")}</div>
          <div class="mini-value">${escapeHtml(item.value || "n/a")}</div>
          ${item.note ? `<div class="meta">${escapeHtml(item.note)}</div>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderPriorityCards(items) {
  return `
    <div class="priority-card-grid">
      ${items.map((item) => `
        <article class="priority-card">
          <div class="priority-row">
            <span class="priority-rank">#${escapeHtml(item.priority || "")}</span>
            <strong>${escapeHtml(item.title || item.kind || "Untitled")}</strong>
          </div>
          <div class="meta">${escapeHtml(item.why_it_matters || "")}</div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderRivalFamilyCards(items) {
  return `
    <div class="family-card-grid">
      ${items.map((item) => `
        <article class="family-card">
          <div class="family-row">
            <strong>${escapeHtml(item.family_root || "family")}</strong>
            <span class="status-pill" data-tone="${escapeHtml(item.verdict || "open")}">${escapeHtml(item.verdict || item.package_state || "open")}</span>
          </div>
          <div class="meta">${escapeHtml(item.adjudication_note || "")}</div>
          <div class="family-stats">
            <span class="family-stat">score ${escapeHtml(String(item.family_score ?? "n/a"))}</span>
            <span class="family-stat">support ${escapeHtml(String(item.support_count ?? "n/a"))}</span>
            <span class="family-stat">lanes ${escapeHtml(String(item.lane_coverage ?? "n/a"))}</span>
            <span class="family-stat">validations ${escapeHtml(String(item.validation_count ?? "n/a"))}</span>
          </div>
          ${
            Array.isArray(item.rival_family_ids) && item.rival_family_ids.length
              ? `<div class="meta">rivals ${escapeHtml(item.rival_family_ids.join(", "))}</div>`
              : ""
          }
        </article>
      `).join("")}
    </div>
  `;
}

function renderList(items, formatter) {
  return `
    <ul>
      ${(items || []).map((item) => `<li>${formatter(item)}</li>`).join("")}
    </ul>
  `;
}

function renderSupportBasis(item) {
  const basis = Array.isArray(item.support_basis) && item.support_basis.length
    ? item.support_basis.join(", ")
    : "n/a";
  const roles = Array.isArray(item.evidence_roles) && item.evidence_roles.length
    ? item.evidence_roles.join(", ")
    : "n/a";
  const cluster = item.cluster_key || "unclustered";
  return `<span class="meta">basis ${escapeHtml(basis)} | roles ${escapeHtml(roles)} | cluster ${escapeHtml(cluster)} | quality ${escapeHtml(item.evidence_quality_score || 0)}</span>`;
}

function renderKnowledgeGraphSummary(knowledgeGraph) {
  const literatureGraph = knowledgeGraph?.literature_graph || {};
  const dataGraph = knowledgeGraph?.data_graph || {};
  const reasoningGraph = knowledgeGraph?.reasoning_graph || {};
  return `
    <div class="graph-grid">
      <div class="graph-card literature">
        <div class="k">Literature Graph</div>
        <div class="graph-stat">${escapeHtml(literatureGraph.hypothesis_count || 0)} hypotheses</div>
        <div class="meta">nodes ${escapeHtml(literatureGraph.node_count || 0)} | edges ${escapeHtml(literatureGraph.edge_count || 0)}</div>
      </div>
      <div class="graph-card data">
        <div class="k">Data Graph</div>
        <div class="graph-stat">${escapeHtml(dataGraph.hypothesis_count || 0)} hypotheses</div>
        <div class="meta">nodes ${escapeHtml(dataGraph.node_count || 0)} | edges ${escapeHtml(dataGraph.edge_count || 0)}</div>
      </div>
      <div class="graph-card literature">
        <div class="k">Reasoning Graph</div>
        <div class="graph-stat">${escapeHtml(reasoningGraph.claim_count || 0)} claims</div>
        <div class="meta">analysis ${escapeHtml(reasoningGraph.analysis_result_count || 0)} | tests ${escapeHtml(reasoningGraph.test_count || 0)} | gaps ${escapeHtml(reasoningGraph.unresolved_gap_count || 0)}</div>
      </div>
    </div>
  `;
}

function renderStaticKnowledgeGraph(graph, options = {}) {
  const width = options.width || 920;
  const height = options.height || 360;
  const palette = {
    paper: "#2563eb",
    query: "#7c3aed",
    concept: "#0f766e",
    variable: "#0891b2",
    context: "#0f766e",
    condition: "#d97706",
    evidence: "#16a34a",
    claim: "#7c3aed",
    test: "#16a34a",
    analysis_result: "#0ea5e9",
    gap: "#b45309",
    hypothesis: "#dc2626",
  };
  const order = ["query", "paper", "concept", "variable", "context", "condition", "claim", "test", "analysis_result", "gap", "evidence", "hypothesis"];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.slice(0, 28) : [];
  const edges = Array.isArray(graph?.edges)
    ? graph.edges.filter((edge) => nodes.some((node) => node.node_id === edge.source) && nodes.some((node) => node.node_id === edge.target)).slice(0, 40)
    : [];
  const types = Array.from(new Set(nodes.map((node) => node.type || "concept")))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const columns = new Map();
  types.forEach((type, index) => {
    const x = 120 + index * ((width - 240) / Math.max(1, types.length - 1 || 1));
    columns.set(type, x);
  });
  const grouped = new Map();
  nodes.forEach((node) => {
    const type = node.type || "concept";
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(node);
  });
  const layout = new Map();
  grouped.forEach((items, type) => {
    items.forEach((node, index) => {
      layout.set(node.node_id, {
        x: columns.get(type) || width / 2,
        y: 76 + index * 52,
      });
    });
  });

  const edgeMarkup = edges.map((edge) => {
    const start = layout.get(edge.source);
    const end = layout.get(edge.target);
    if (!start || !end) return "";
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2 - 6;
    return `
      <line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="#cbd5e1" stroke-width="1.5"></line>
      <text x="${midX}" y="${midY}" text-anchor="middle" font-size="10" fill="#64748b">${escapeHtml(edge.relation || "related")}</text>
    `;
  }).join("");

  const nodeMarkup = nodes.map((node) => {
    const point = layout.get(node.node_id);
    if (!point) return "";
    const fill = palette[node.type] || "#334155";
    const w = node.type === "hypothesis" ? 156 : 116;
    const h = node.type === "hypothesis" ? 38 : 30;
    return `
      <rect x="${point.x - w / 2}" y="${point.y - h / 2}" width="${w}" height="${h}" rx="15" fill="${fill}" opacity="0.94"></rect>
      <text x="${point.x}" y="${point.y - 1}" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">${escapeHtml(String(node.label || node.node_id).slice(0, node.type === "hypothesis" ? 24 : 18))}</text>
      <text x="${point.x}" y="${point.y + 12}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.8)">${escapeHtml(node.type || "node")}</text>
    `;
  }).join("");

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(options.title || "Knowledge graph preview")}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"></rect>
      ${edgeMarkup}
      ${nodeMarkup}
    </svg>
  `;
}

function renderKnowledgeGraphPreviews(explorerData) {
  const literature = explorerData?.literature_graph || {};
  const data = explorerData?.data_graph || {};
  const reasoning = explorerData?.reasoning_graph || {};
  return `
    <div class="kg-preview-grid">
      <div class="kg-preview-card">
        <div class="k">Literature Graph Preview</div>
        <div class="meta">nodes ${escapeHtml((literature.nodes || []).length)} | edges ${escapeHtml((literature.edges || []).length)}</div>
        ${renderStaticKnowledgeGraph(literature, { title: "Literature graph preview" })}
      </div>
      <div class="kg-preview-card">
        <div class="k">Data Graph Preview</div>
        <div class="meta">nodes ${escapeHtml((data.nodes || []).length)} | edges ${escapeHtml((data.edges || []).length)}</div>
        ${renderStaticKnowledgeGraph(data, { title: "Data graph preview" })}
      </div>
      <div class="kg-preview-card">
        <div class="k">Reasoning Graph Preview</div>
        <div class="meta">nodes ${escapeHtml((reasoning.nodes || []).length)} | edges ${escapeHtml((reasoning.edges || []).length)}</div>
        ${renderStaticKnowledgeGraph(reasoning, { title: "Reasoning graph preview" })}
      </div>
    </div>
  `;
}

function safeJsonScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildKnowledgeGraphExplorer(hypothesisLedger) {
  const hypotheses = Array.isArray(hypothesisLedger?.hypotheses) ? hypothesisLedger.hypotheses : [];

  function scaffoldFromHypothesis(item, layer) {
    const statement = String(item?.statement || "");
    let xVariable = item?.x_variable || null;
    let yVariable = item?.y_variable || null;
    let condition = item?.condition || null;

    if (layer === "data") {
      xVariable = xVariable || item?.primary_exposure || "primary_exposure";
      const yVariables = Array.isArray(item?.y_variables) ? item.y_variables.filter(Boolean) : [];
      yVariable = yVariable || item?.outcome || yVariables[0] || "target_outcome";
      condition = condition || (item?.family === "subgroup-stratification"
        ? item?.group_name || item?.region_name || "subgroup context"
        : item?.family === "partition-and-threshold"
          ? "coverage regime"
          : item?.family === "unit-change"
            ? "unit-level change over time"
          : item?.family === "adjusted-signal"
              ? "unit-time adjusted model"
            : item?.family === "leave-one-group-out"
                ? "leave-one-group-out sensitivity"
                : null);
    }

    if (!xVariable || !yVariable) {
      let match = statement.match(/relationship between (.+?) and (.+?) may vary across (.+?) contexts/i);
      if (match) {
        xVariable = xVariable || match[1];
        yVariable = yVariable || match[2];
        condition = condition || match[3];
      }
      match = statement.match(/patterns involving (.+?) and (.+?) may depend/i);
      if (match) {
        xVariable = xVariable || match[1];
        yVariable = yVariable || match[2];
        condition = condition || "measurement quality";
      }
      match = statement.match(/(.+?) may align more strongly with (.+?) than/i);
      if (match) {
        xVariable = xVariable || match[1];
        yVariable = yVariable || match[2];
      }
    }

    const hypothesisId = `hypothesis:${item.hypothesis_id || "unknown"}`;
    const xId = xVariable
      ? `${layer}-x:${String(xVariable).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`
      : null;
    const yId = yVariable
      ? `${layer}-y:${String(yVariable).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`
      : null;
    const conditionId = condition
      ? `${layer}-condition:${String(condition).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`
      : null;
    const nodes = [
      xVariable ? { node_id: xId, type: layer === "data" ? "variable" : "concept", label: xVariable } : null,
      yVariable ? { node_id: yId, type: layer === "data" ? "variable" : "concept", label: yVariable } : null,
      { node_id: hypothesisId, type: "hypothesis", label: item.statement || item.hypothesis_id || "hypothesis" },
      condition ? { node_id: conditionId, type: "condition", label: condition } : null,
    ].filter(Boolean);

    const edges = [
      xVariable ? { source: xId, target: hypothesisId, relation: "from_x" } : null,
      yVariable ? { source: hypothesisId, target: yId, relation: "to_y" } : null,
      condition ? { source: hypothesisId, target: conditionId, relation: "under_z" } : null,
    ].filter(Boolean);

    if (layer === "literature") {
      (item.paper_examples || []).slice(0, 4).forEach((paper, index) => {
        const paperId = `paper:${String(paper).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || index + 1}`;
        nodes.push({ node_id: paperId, type: "paper", label: paper });
        edges.push({ source: paperId, target: hypothesisId, relation: "supports" });
      });
    }

    return { nodes, edges };
  }

  function aggregate(layer) {
    const nodes = new Map();
    const edges = new Map();
    const linkedHypotheses = [];

    for (const item of hypotheses) {
      const graph = item?.graph_support;
      const inferredSourceGraphs = Array.isArray(item?.source_graphs) && item.source_graphs.length
        ? item.source_graphs
        : item?.kind === "literature"
          ? ["literature"]
          : item?.kind === "data"
            ? ["data"]
            : item?.kind === "mixed"
              ? ["literature", "data"]
              : [];
      if (!inferredSourceGraphs.includes(layer)) continue;

      linkedHypotheses.push({
        hypothesis_id: item.hypothesis_id || null,
        statement: item.statement || null,
        score: Number(item.hypothesis_score || 0),
        state: item.state || item.latest_status || null,
        x_variable: item.x_variable || null,
        y_variable: item.y_variable || null,
        condition: item.condition || null,
        mechanism: item.mechanism || null,
      });

      const fallbackGraph = !graph ? scaffoldFromHypothesis(item, layer) : null;
      const effectiveGraph = graph && graph.layer === layer ? graph : fallbackGraph;
      if (!effectiveGraph) continue;

      for (const node of effectiveGraph.nodes || []) {
        if (!node?.node_id) continue;
        if (!nodes.has(node.node_id)) {
          nodes.set(node.node_id, { ...node, linked_hypotheses: [] });
        }
        const current = nodes.get(node.node_id);
        if (item.hypothesis_id && !current.linked_hypotheses.includes(item.hypothesis_id)) {
          current.linked_hypotheses.push(item.hypothesis_id);
        }
      }

      for (const edge of effectiveGraph.edges || []) {
        if (!edge?.source || !edge?.target) continue;
        const key = `${edge.source}|${edge.relation || "related"}|${edge.target}`;
        if (!edges.has(key)) {
          edges.set(key, { ...edge, linked_hypotheses: [] });
        }
        const current = edges.get(key);
        if (item.hypothesis_id && !current.linked_hypotheses.includes(item.hypothesis_id)) {
          current.linked_hypotheses.push(item.hypothesis_id);
        }
      }
    }

    return {
      layer,
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      hypotheses: linkedHypotheses
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 24),
    };
  }

  function aggregateReasoning() {
    const nodes = new Map();
    const edges = new Map();
    const linkedHypotheses = [];

    function addNode(node, hypothesisId) {
      if (!node?.node_id) return;
      if (!nodes.has(node.node_id)) {
        nodes.set(node.node_id, { ...node, linked_hypotheses: [] });
      }
      const current = nodes.get(node.node_id);
      if (hypothesisId && !current.linked_hypotheses.includes(hypothesisId)) {
        current.linked_hypotheses.push(hypothesisId);
      }
    }

    function addEdge(edge, hypothesisId) {
      if (!edge?.source || !edge?.target) return;
      const key = `${edge.source}|${edge.relation || "related"}|${edge.target}`;
      if (!edges.has(key)) {
        edges.set(key, { ...edge, linked_hypotheses: [] });
      }
      const current = edges.get(key);
      if (hypothesisId && !current.linked_hypotheses.includes(hypothesisId)) {
        current.linked_hypotheses.push(hypothesisId);
      }
    }

    for (const item of hypotheses) {
      const hypothesisId = item.hypothesis_id || null;
      linkedHypotheses.push({
        hypothesis_id: hypothesisId,
        statement: item.statement || null,
        score: Number(item.hypothesis_score || 0),
        state: item.state || item.latest_status || null,
        x_variable: item.x_variable || null,
        y_variable: item.y_variable || null,
        condition: item.condition || null,
        mechanism: item.mechanism || null,
      });

      const hypothesisNodeId = `hypothesis:${hypothesisId || "unknown"}`;
      addNode({
        node_id: hypothesisNodeId,
        type: "hypothesis",
        label: item.statement || hypothesisId || "hypothesis",
      }, hypothesisId);

      for (const claim of item.claims || []) {
        addNode({
          node_id: claim.claim_id,
          type: "claim",
          label: claim.statement || claim.claim_id,
        }, hypothesisId);
        addEdge({
          source: claim.claim_id,
          target: hypothesisNodeId,
          relation: "supports_candidate",
        }, hypothesisId);
      }

      for (const result of item.analysis_results || []) {
        addNode({
          node_id: result.analysis_result_id,
          type: "analysis_result",
          label: result.family || result.outcome || result.analysis_result_id,
        }, hypothesisId);
        addEdge({
          source: result.analysis_result_id,
          target: hypothesisNodeId,
          relation: "tests",
        }, hypothesisId);
      }

      for (const test of item.falsification_tests || []) {
        addNode({
          node_id: test.test_id,
          type: "test",
          label: test.label || test.test_id,
        }, hypothesisId);
        addEdge({
          source: hypothesisNodeId,
          target: test.test_id,
          relation: "requires_test",
        }, hypothesisId);
      }

      for (const gap of item.unresolved_gaps || []) {
        const gapId = `gap:${String(hypothesisId || "hypothesis").toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${String(gap).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        addNode({
          node_id: gapId,
          type: "gap",
          label: gap,
        }, hypothesisId);
        addEdge({
          source: gapId,
          target: hypothesisNodeId,
          relation: "missing_test_for",
        }, hypothesisId);
      }

      for (const mechanism of item.mechanisms || []) {
        const mechanismId = `mechanism:${String(mechanism).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
        addNode({ node_id: mechanismId, type: "concept", label: mechanism }, hypothesisId);
        addEdge({ source: mechanismId, target: hypothesisNodeId, relation: "mediates" }, hypothesisId);
      }
    }

    return {
      layer: "reasoning",
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
      hypotheses: linkedHypotheses
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 24),
    };
  }

  return {
    literature_graph: aggregate("literature"),
    data_graph: aggregate("data"),
    reasoning_graph: aggregateReasoning(),
  };
}

function renderKnowledgeGraphExplorer(explorerData) {
  return `
    <div class="kg-explorer" id="kg-explorer">
      ${renderKnowledgeGraphPreviews(explorerData)}
      <div class="kg-toolbar">
        <button class="kg-tab active" type="button" data-graph-target="literature_graph">Literature Graph</button>
        <button class="kg-tab" type="button" data-graph-target="data_graph">Data Graph</button>
        <button class="kg-tab" type="button" data-graph-target="reasoning_graph">Reasoning Graph</button>
      </div>
      <div class="kg-legend" id="kg-legend"></div>
      <div class="kg-layout">
        <section class="kg-canvas-panel">
          <div class="kg-canvas-header">
            <h3 id="kg-title">Knowledge Graph</h3>
            <div class="kg-canvas-meta">
              <div class="meta" id="kg-stats"></div>
              <div class="kg-controls">
                <button class="kg-control" type="button" id="kg-zoom-out">-</button>
                <button class="kg-control" type="button" id="kg-reset-view">Reset</button>
                <button class="kg-control" type="button" id="kg-zoom-in">+</button>
              </div>
            </div>
          </div>
          <div class="kg-stage">
            <svg id="kg-canvas" viewBox="0 0 1400 860" width="100%" height="auto" role="img" aria-label="Knowledge graph explorer"></svg>
            <div class="kg-inspector" id="kg-inspector">
              <div class="kg-inspector-title">Selection</div>
              <div class="meta" id="kg-inspector-body">Click a node or edge to inspect it.</div>
            </div>
          </div>
        </section>
        <aside class="kg-sidebar">
          <div class="kg-box">
            <h3>Connected Hypotheses</h3>
            <div id="kg-hypotheses"></div>
          </div>
          <div class="kg-box">
            <h3>Nodes</h3>
            <div id="kg-nodes"></div>
          </div>
          <div class="kg-box">
            <h3>Edges</h3>
            <div id="kg-edges"></div>
          </div>
        </aside>
      </div>
    </div>
    <script id="kg-data" type="application/json">${safeJsonScript(explorerData)}</script>
  `;
}

module.exports = {
  barChartSvg,
  renderSignalScorecardSvg,
  renderPrimarySignalSummarySvg,
  renderPrimaryClaimBridgeSvg,
  renderSubgroupHeterogeneitySvg,
  renderRobustnessSvg,
  renderPromotedHypothesesSummarySvg,
  renderValidationCoverageSvg,
  renderMetricTiles,
  renderPriorityCards,
  renderRivalFamilyCards,
  renderList,
  renderSupportBasis,
  renderKnowledgeGraphSummary,
  renderStaticKnowledgeGraph,
  renderKnowledgeGraphPreviews,
  safeJsonScript,
  buildKnowledgeGraphExplorer,
  renderKnowledgeGraphExplorer,
};
