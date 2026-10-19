"use strict";

const researcherViewStyles = String.raw`    :root {
      --bg: #f8fafc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --border: #dbe4ee;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.12), transparent 26%),
        linear-gradient(180deg, #f8fafc 0%, #eef6f6 100%);
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px 20px 60px;
    }
    h1, h2, h3 { margin: 0 0 14px; }
    p { line-height: 1.55; }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 18px 42px rgba(15, 23, 42, 0.06);
    }
    .hero {
      margin-bottom: 20px;
      background:
        linear-gradient(135deg, rgba(15,118,110,0.08), rgba(255,255,255,0.96)),
        var(--panel);
    }
    .view-tabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .view-tab {
      border: 1px solid var(--border);
      background: #fff;
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      color: var(--ink);
      font: inherit;
    }
    .view-tab.active {
      background: #0f172a;
      color: #fff;
      border-color: #0f172a;
    }
    .view-panel.hidden {
      display: none;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin: 20px 0 24px;
    }
    .card {
      padding: 18px;
      border-radius: 16px;
      background: #fcfdfd;
      border: 1px solid var(--border);
    }
    .card .k {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .card .v {
      font-size: 32px;
      font-weight: 700;
      margin-top: 8px;
    }
    .graph-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }
    .graph-card {
      padding: 16px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #fcfdfd;
    }
    .graph-card.literature { background: linear-gradient(180deg, #f8fcff 0%, #ffffff 100%); }
    .graph-card.data { background: linear-gradient(180deg, #f7fffb 0%, #ffffff 100%); }
    .graph-stat {
      margin-top: 8px;
      font-size: 24px;
      font-weight: 700;
    }
    .kg-explorer {
      display: grid;
      gap: 16px;
    }
    .kg-preview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
    }
    .kg-preview-card {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #fcfdfd;
    }
    .kg-toolbar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .kg-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .kg-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #fff;
      font-size: 13px;
      color: var(--ink);
    }
    .kg-swatch {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      display: inline-block;
    }
    .kg-tab {
      border: 1px solid var(--border);
      background: #fff;
      border-radius: 999px;
      padding: 8px 14px;
      cursor: pointer;
      color: var(--ink);
      font: inherit;
    }
    .kg-tab.active {
      background: #0f766e;
      color: #fff;
      border-color: #0f766e;
    }
    .kg-layout {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 16px;
    }
    .kg-canvas-panel, .kg-box {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: #fcfdfd;
    }
    .kg-canvas-panel {
      padding: 16px;
      overflow: hidden;
    }
    .graph-studio {
      display: grid;
      gap: 18px;
    }
    .graph-studio .kg-layout {
      grid-template-columns: minmax(0, 1.5fr) minmax(320px, 0.5fr);
    }
    .graph-studio .kg-canvas-panel {
      padding: 18px;
    }
    .graph-studio .kg-stage {
      min-height: 720px;
    }
    .graph-studio #kg-canvas {
      min-height: 720px;
    }
    .kg-stage {
      position: relative;
    }
    .kg-canvas-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 12px;
    }
    .kg-canvas-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .kg-controls {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .kg-control {
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.96);
      border-radius: 999px;
      padding: 6px 12px;
      cursor: pointer;
      color: var(--ink);
      font: inherit;
      min-width: 42px;
    }
    .kg-sidebar {
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .kg-box {
      padding: 14px;
      max-height: 260px;
      overflow: auto;
    }
    .kg-inspector {
      position: absolute;
      right: 16px;
      bottom: 16px;
      width: min(280px, calc(100% - 32px));
      padding: 12px 14px;
      border-radius: 16px;
      border: 1px solid rgba(148, 163, 184, 0.35);
      background: rgba(255,255,255,0.96);
      box-shadow: 0 16px 36px rgba(15, 23, 42, 0.12);
      backdrop-filter: blur(10px);
    }
    .kg-inspector-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .kg-list {
      display: grid;
      gap: 8px;
    }
    .kg-list-item {
      padding: 10px 12px;
      border-radius: 12px;
      background: #fff;
      border: 1px solid var(--border);
    }
    .kg-node-label {
      font-size: 11px;
      fill: #0f172a;
      font-weight: 600;
    }
    .kg-edge-label {
      font-size: 10px;
      fill: #64748b;
    }
    .kg-node-meta {
      font-size: 9px;
      fill: #475569;
    }
    .kg-edge-line {
      stroke: #cbd5e1;
      stroke-width: 1.6;
      fill: none;
      opacity: 0.9;
    }
    .kg-edge-line.active {
      stroke: #0f766e;
      stroke-width: 2.4;
    }
    .kg-node-shape {
      stroke: rgba(15, 23, 42, 0.14);
      stroke-width: 1.2;
    }
    .kg-node-shape.active {
      stroke: #0f172a;
      stroke-width: 2.6;
    }
    .kg-node-shadow {
      fill: rgba(15, 23, 42, 0.08);
    }
    .evidence-strip {
      display: grid;
      gap: 18px;
      margin: 24px 0;
    }
    .signal-banner {
      padding: 20px 22px;
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(15,118,110,0.12), rgba(255,255,255,0.96));
      border: 1px solid rgba(15,118,110,0.16);
    }
    .hero-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(300px, 0.7fr);
      gap: 18px;
      margin-top: 18px;
    }
    .hero-side {
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .hero-card {
      padding: 16px;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(255,255,255,0.84);
    }
    .hero-card strong {
      display: block;
      margin-bottom: 6px;
    }
    .verdict-strip {
      display: grid;
      gap: 12px;
      margin-top: 16px;
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.92);
      border: 1px solid rgba(148, 163, 184, 0.22);
    }
    .verdict-strip strong {
      display: block;
      font-size: 22px;
      margin: 0;
    }
    .verdict-points {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .verdict-pill {
      display: inline-flex;
      align-items: center;
      padding: 7px 11px;
      border-radius: 999px;
      background: #ecfdf5;
      border: 1px solid rgba(15,118,110,0.16);
      color: #0f172a;
      font-size: 12px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .metric-chip {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.9);
      border: 1px solid rgba(148, 163, 184, 0.22);
    }
    .metric-chip .value {
      font-size: 24px;
      font-weight: 700;
      margin-top: 6px;
    }
    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .evidence-badge {
      display: inline-flex;
      align-items: center;
      padding: 7px 11px;
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      border: 1px solid rgba(148, 163, 184, 0.24);
      font-size: 12px;
      color: var(--ink);
    }
    .decision-list {
      display: grid;
      gap: 10px;
      margin: 0;
      padding-left: 18px;
    }
    .decision-list li {
      margin: 0;
    }
    .checkpoint-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .checkpoint-card {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.88);
      border: 1px solid rgba(148, 163, 184, 0.22);
    }
    .checkpoint-card .value {
      font-size: 28px;
      font-weight: 700;
      margin: 6px 0 4px;
    }
    .checkpoint-card[data-tone="positive"] .value {
      color: #0f766e;
    }
    .checkpoint-card[data-tone="mixed"] .value {
      color: #b45309;
    }
    .answer-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .answer-card {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.9);
      border: 1px solid rgba(148, 163, 184, 0.22);
    }
    .answer-card .value {
      font-size: 24px;
      font-weight: 700;
      margin: 8px 0 6px;
    }
    .answer-card[data-tone="positive"] .value {
      color: #0f766e;
    }
    .answer-card[data-tone="mixed"] .value {
      color: #b45309;
    }
    .path-grid, .objection-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .path-card, .objection-card {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.9);
      border: 1px solid rgba(148, 163, 184, 0.22);
    }
    .path-step {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: #0f172a;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .path-card .value {
      font-size: 24px;
      font-weight: 700;
      margin: 8px 0 6px;
    }
    .objection-card strong {
      display: block;
      margin-bottom: 6px;
    }
    .evidence-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .visual-card {
      padding: 18px;
      border-radius: 18px;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, #ffffff 0%, #f8fbfb 100%);
    }
    .visual-card svg {
      margin: 14px 0 8px;
      border-radius: 14px;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
    }
    .takeaway {
      margin-top: 10px;
      padding: 12px 14px;
      border-radius: 14px;
      background: #f8fafc;
      border: 1px solid var(--border);
      font-size: 14px;
    }
    .priority-list {
      display: grid;
      gap: 12px;
    }
    .priority-item {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #fcfdfd;
    }
    .priority-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .priority-rank {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 36px;
      height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: #e0f2fe;
      color: #0c4a6e;
      font-size: 12px;
      font-weight: 700;
    }
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .mini-card {
      padding: 14px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: #fcfdfd;
    }
    .mini-card[data-tone="positive"] {
      background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 100%);
    }
    .mini-card[data-tone="mixed"] {
      background: linear-gradient(180deg, #fff7ed 0%, #ffffff 100%);
    }
    .mini-value {
      font-size: 24px;
      font-weight: 700;
      margin: 6px 0 4px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: #e2e8f0;
      color: #334155;
    }
    .status-pill[data-tone="leading"] {
      background: #dcfce7;
      color: #166534;
    }
    .status-pill[data-tone="contested"] {
      background: #fef3c7;
      color: #92400e;
    }
    .status-pill[data-tone="trailing"] {
      background: #fee2e2;
      color: #991b1b;
    }
    .family-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 10px 0 8px;
    }
    .family-stat {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: #f8fafc;
      border: 1px solid var(--border);
      font-size: 12px;
      color: var(--ink);
    }
    .layout {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      gap: 18px;
    }
    .stack {
      display: grid;
      gap: 18px;
    }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 8px 0; line-height: 1.45; }
    .meta {
      color: var(--muted);
      font-size: 14px;
    }
    .paper {
      padding: 14px 0;
      border-top: 1px solid var(--border);
    }
    .paper:first-child { border-top: 0; padding-top: 0; }
    .badge {
      display: inline-block;
      margin-right: 8px;
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 999px;
      background: rgba(15,118,110,0.1);
      color: var(--accent);
    }
    .empty { color: var(--muted); font-style: italic; }
    .rubric-row {
      display: grid;
      grid-template-columns: 1.4fr 0.4fr 1.8fr;
      gap: 12px;
      padding: 12px 0;
      border-top: 1px solid var(--border);
      align-items: start;
    }
    .rubric-row:first-child { border-top: 0; padding-top: 0; }
    .score-pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: #e2f3f1;
      color: #0f766e;
      font-weight: 700;
      text-align: center;
    }
    @media (max-width: 900px) {
      .hero-grid { grid-template-columns: 1fr; }
      .layout { grid-template-columns: 1fr; }
      .kg-layout { grid-template-columns: 1fr; }
      .rubric-row { grid-template-columns: 1fr; }
      .graph-studio .kg-layout { grid-template-columns: 1fr; }
      .graph-studio .kg-stage { min-height: 520px; }
      .graph-studio #kg-canvas { min-height: 520px; }
    }`;

module.exports = {
  researcherViewStyles,
};
