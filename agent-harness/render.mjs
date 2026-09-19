#!/usr/bin/env node
/**
 * render.mjs — turns data/projects.json into the product surfaces.
 *
 *   assets/cards/<slug>.svg   one card per project, for markdown embedding
 *   site/index.html           the browsable registry (self-contained, no CDN)
 *   data/index.md             markdown directory, grouped by harness layer
 *
 * Everything is generated from the state file, so the whole site can be rebuilt
 * from scratch at any time. Nothing here is authoritative; GitHub is.
 *
 *   node render.mjs [--root .]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(process.env.CORPUS_ROOT ?? argValue('--root') ?? '.');
const DRY_RUN = process.env.DRY_RUN === '1';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

const STATE_PATH = join(ROOT, 'data', 'projects.json');
if (!existsSync(STATE_PATH)) {
  console.error(`error: ${STATE_PATH} not found — run collect.mjs first`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
const projects = state.projects ?? [];

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// Graphite surface, warm off-white type, gold/copper accent, violet counterpoint.
// Deliberately not the navy/blue of a GitHub profile theme.
const LAYERS = {
  runtime: { label: 'Runtime', short: 'RUNTIME', accent: '#A78BFA' },
  orchestration: { label: 'Orchestration', short: 'ORCHESTR', accent: '#38BDF8' },
  tools: { label: 'Tools & MCP', short: 'TOOLS', accent: '#34D399' },
  sandbox: { label: 'Sandboxing', short: 'SANDBOX', accent: '#FB923C' },
  memory: { label: 'Memory & Context', short: 'MEMORY', accent: '#22D3EE' },
  eval: { label: 'Eval & Tracing', short: 'EVAL', accent: '#A3E635' },
  governance: { label: 'Governance', short: 'GOVERN', accent: '#FB7185' },
  protocol: { label: 'Protocols', short: 'PROTO', accent: '#F472B6' },
  gateway: { label: 'Model Gateway', short: 'GATEWAY', accent: '#818CF8' },
  other: { label: 'Other', short: 'OTHER', accent: '#94A3B8' },
};

// Single quotes inside the font stacks on purpose: these strings are
// interpolated into XML attributes delimited by double quotes in the card
// SVGs, and a nested double quote terminates the attribute — the card then
// fails to parse and renders as an empty box.
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,monospace";

const GOLD = '#E3B778';
const GOLD_DEEP = '#C98A4B';
const VIOLET = '#7C5CFF';

const layerOf = (id) => LAYERS[id] ?? LAYERS.other;

// How many layers to claim. `other` is a catch-all bucket, not a harness layer —
// the constellation draws one satellite per populated layer and omits it, so
// counting it made every surface state a number one higher than the diagram
// sitting next to it. One definition, used by the banner, the stats strip, the
// run strip and the site, so the headline and the artwork cannot drift apart.
const populatedLayerIds = (counts) =>
  Object.keys(LAYERS).filter((k) => k !== 'other' && (counts[k] ?? 0) > 0);
const populatedLayers = (counts) => populatedLayerIds(counts).length;

const slug = (fullName) => fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const nfmt = (n) => Number(n ?? 0).toLocaleString('en-US');

function rgba(hex, alpha) {
  const h = String(hex ?? '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full || '000000', 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '\u2026';
}

function writeFile(relPath, contents) {
  const abs = join(ROOT, relPath);
  if (existsSync(abs) && readFileSync(abs, 'utf8') === contents) return false;
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Run ledger — the pipeline's own activity, read back out of history/
// ---------------------------------------------------------------------------

/**
 * Read history/runs.jsonl and re-verify the hash chain.
 *
 * The chain check is duplicated here on purpose: the site should be able to
 * state "chain intact" from the artefacts alone, without trusting a badge that
 * some other process wrote.
 */
function readLedger() {
  const p = join(ROOT, 'history', 'runs.jsonl');
  if (!existsSync(p)) return null;
  let rows;
  try {
    rows = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { runs: 0, intact: false, latest: null };
  }
  if (!rows.length) return { runs: 0, intact: false, latest: null };

  let prev = 'genesis';
  let intact = true;
  for (const r of rows) {
    if (r.prevHash !== prev) intact = false;
    prev = r.entryHash;
  }
  return { runs: rows.length, intact, latest: rows[rows.length - 1] };
}

/**
 * Percentile by stars inside this corpus, as a fraction where 0 is the top.
 * Honest description of what it is: a rank within the projects held here, not a
 * claim about GitHub at large.
 *
 * The label is deliberately coarse (`ceil(rank * 100)`), which reads well on a
 * card but collapses at scale: once the corpus passed a few hundred projects the
 * top six all displayed "TOP 1%". That is accurate — they genuinely are — but it
 * carries no information. Showing an ordinal instead would fix the strip and
 * rewrite every card, so the coarse label stays until the card layout is next
 * revisited.
 */
function buildRank(projects) {
  const sorted = projects.map((p) => p.stars).sort((a, b) => b - a);
  const rank = new Map();
  const index = new Map();
  sorted.forEach((s, i) => {
    if (!index.has(s)) index.set(s, i);
  });
  for (const p of projects) rank.set(p.fullName, index.get(p.stars) / projects.length);
  return rank;
}

// ---------------------------------------------------------------------------
// SVG cards — for embedding in markdown
// ---------------------------------------------------------------------------

const W = 480;
const H = 176;

const CARD = {
  surface0: '#14161C',
  surface1: '#0A0B0F',
  border: 'rgba(255,255,255,0.10)',
  title: '#F5F2EA',
  body: '#A9A49A',
  muted: '#7C7669',
  chip: '#C6C1B7',
  gold: GOLD,
};

function chipRow(items, x, y, maxWidth, limit, accent) {
  const out = [];
  let cx = x;
  const shown = items.slice(0, limit);
  const overflow = items.length - shown.length;

  for (const label of shown) {
    const w = label.length * 6.1 + 16;
    if (cx + w > x + maxWidth) break;
    const fill = accent ? rgba(accent, 0.14) : 'rgba(255,255,255,0.045)';
    const stroke = accent ? rgba(accent, 0.38) : 'rgba(255,255,255,0.075)';
    const fg = accent ?? CARD.chip;
    out.push(
      `<rect x="${cx.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="18" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="0.75"/>` +
        `<text x="${(cx + w / 2).toFixed(1)}" y="${(y + 12.6).toFixed(1)}" font-size="10" fill="${fg}" text-anchor="middle" font-family="${MONO}">${esc(label)}</text>`,
    );
    cx += w + 6;
  }

  if (overflow > 0) {
    const w = 34;
    if (cx + w <= x + maxWidth) {
      out.push(
        `<rect x="${cx.toFixed(1)}" y="${y}" width="${w}" height="18" rx="9" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)" stroke-width="0.75"/>` +
          `<text x="${(cx + w / 2).toFixed(1)}" y="${(y + 12.6).toFixed(1)}" font-size="10" fill="${CARD.muted}" text-anchor="middle" font-family="${MONO}">+${overflow}</text>`,
      );
    }
  }
  return out.join('');
}

const shortSha = (s) => (s ? s.slice(0, 7) : '\u2014');

/**
 * Standalone card. Motion is decorative only: every animated element sits on
 * top of a static equivalent, and the whole motion layer is hidden under
 * `prefers-reduced-motion`. Nothing here carries meaning that motion is
 * responsible for delivering.
 */
function renderCard(p, rank) {
  const layer = layerOf(p.layer);
  const langColor = p.languageColor || layer.accent;

  const meta = [];
  meta.push(`\u2605 ${nfmt(p.stars)}`);
  if (p.forks > 0) meta.push(`\u2442 ${nfmt(p.forks)}`);
  if (p.license) meta.push(p.license);
  if (p.archived) meta.push('archived');

  const topPct = Math.max(1, Math.ceil(rank * 100));
  const fillPct = Math.round((1 - rank) * 100);
  const barX = 22;
  const barW = W - 44;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(p.fullName)} — ${esc(layer.label)}, ${nfmt(p.stars)} stars, top ${topPct}% of this corpus">
  <style>
    /* Motion is additive decoration. With reduced motion requested the whole
       motion layer is hidden and the card is still complete and correct. */
    @media (prefers-reduced-motion: reduce){ .mo{ display:none } }
  </style>
  <defs>
    <linearGradient id="surface" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${CARD.surface0}"/>
      <stop offset="1" stop-color="${CARD.surface1}"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${layer.accent}" stop-opacity="0.9"/>
      <stop offset="0.45" stop-color="${layer.accent}" stop-opacity="0.25"/>
      <stop offset="1" stop-color="${CARD.gold}" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="rail" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${layer.accent}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${layer.accent}" stop-opacity="0.06"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0" r="0.85">
      <stop offset="0" stop-color="${layer.accent}" stop-opacity="0.20"/>
      <stop offset="1" stop-color="${layer.accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.055"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rankFill" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${rgba(layer.accent, 0.55)}"/>
      <stop offset="0.55" stop-color="${layer.accent}"/>
      <stop offset="1" stop-color="${CARD.gold}"/>
    </linearGradient>
    <pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="0.65" fill="#ffffff" opacity="0.045"/>
    </pattern>
    <clipPath id="frame"><rect x="0" y="0" width="${W}" height="${H}" rx="14"/></clipPath>
  </defs>

  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="url(#surface)"/>
    <rect width="${W}" height="${H}" fill="url(#dots)"/>
    <ellipse cx="${W * 0.72}" cy="-40" rx="${W * 0.62}" ry="150" fill="url(#glow)"/>
    <rect x="0" y="0" width="3" height="${H}" fill="url(#rail)"/>
    <rect x="0" y="0" width="${W}" height="1.4" fill="url(#edge)"/>
  </g>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="${CARD.border}" stroke-width="1"/>

  <!-- ── motion layer: sheen sweep + a signal travelling down the accent rail ── -->
  <g class="mo" clip-path="url(#frame)">
    <rect x="-150" y="0" width="130" height="${H}" fill="url(#sheen)">
      <animate attributeName="x" values="-150;${W + 20}" dur="5.5s" repeatCount="indefinite"/>
    </rect>
    <circle r="2.6" fill="${layer.accent}" opacity="0">
      <animateMotion dur="3.4s" repeatCount="indefinite" calcMode="linear"
                     keyPoints="0.04;0.96" keyTimes="0;1" path="M1.5 0 L1.5 ${H}"/>
      <animate attributeName="opacity" values="0;0.95;0.95;0" keyTimes="0;0.12;0.82;1"
               dur="3.4s" repeatCount="indefinite"/>
    </circle>
  </g>

  <text x="22" y="30" font-size="9.5" letter-spacing="1.1" fill="${CARD.muted}" font-family="${MONO}">${esc(truncate(p.owner.toUpperCase(), 26))}</text>
  <text x="22" y="55" font-size="17.5" font-weight="600" fill="${CARD.title}" font-family="${SANS}">${esc(truncate(p.name, 28))}</text>
  <text x="${W - 40}" y="54" font-size="11" fill="${CARD.body}" text-anchor="end" font-family="${MONO}">${esc(truncate(p.language ?? 'Unknown', 14))}</text>
  <circle cx="${W - 30}" cy="50" r="4.5" fill="${langColor}"/>
  <g class="mo">
    <g>
      <animateTransform attributeName="transform" type="rotate" from="0 ${W - 30} 50" to="360 ${W - 30} 50"
                        dur="7s" repeatCount="indefinite"/>
      <circle cx="${W - 30}" cy="36" r="1.7" fill="${langColor}" opacity="0.85"/>
    </g>
    <circle cx="${W - 30}" cy="50" r="4.5" fill="none" stroke="${langColor}" stroke-width="1">
      <animate attributeName="r" values="4.5;11;4.5" dur="4s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="4s" repeatCount="indefinite"/>
    </circle>
  </g>

  <text x="22" y="78" font-size="12" fill="${CARD.body}" font-family="${SANS}">${esc(truncate(p.description ?? 'No description', 74))}</text>
  ${chipRow([layer.label], 22, 90, W - 44, 1, layer.accent)}${chipRow(p.stack.length ? p.stack : ['—'], 22 + (layer.label.length * 6.1 + 22), 90, W - 44 - (layer.label.length * 6.1 + 22), 4)}

  <!-- ── stars rank within this corpus ── -->
  <text x="${barX}" y="134" font-size="8.6" letter-spacing="1.4" fill="${CARD.muted}" font-family="${MONO}">STARS RANK</text>
  <text x="${W - barX}" y="134" font-size="8.6" letter-spacing="1.4" fill="${layer.accent}" text-anchor="end" font-family="${MONO}">TOP ${topPct}%</text>
  <rect x="${barX}" y="142" width="${barW}" height="4" rx="2" fill="rgba(255,255,255,0.07)"/>
  <rect x="${barX}" y="142" width="${((barW * fillPct) / 100).toFixed(1)}" height="4" rx="2" fill="url(#rankFill)">
    <animate attributeName="width" from="0" to="${((barW * fillPct) / 100).toFixed(1)}"
             dur="1.1s" fill="freeze" calcMode="spline" keySplines="0.16 1 0.3 1" keyTimes="0;1"/>
  </rect>

  <text x="22" y="${H - 14}" font-size="10.5" fill="${CARD.muted}" font-family="${MONO}">${esc(meta.join('   \u00b7   '))}</text>
  <text x="${W - 22}" y="${H - 14}" font-size="10.5" fill="${CARD.muted}" text-anchor="end" font-family="${MONO}" opacity="0.75">${esc(shortSha(p.commit))}</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
// Markdown directory
// ---------------------------------------------------------------------------

function renderMarkdown(projects) {
  const byLayer = new Map();
  for (const p of projects) {
    if (!byLayer.has(p.layer)) byLayer.set(p.layer, []);
    byLayer.get(p.layer).push(p);
  }

  const order = [...byLayer.keys()].sort((a, b) => byLayer.get(b).length - byLayer.get(a).length);

  const lines = [
    '# Agent-Harness registry',
    '',
    `Generated from \`data/projects.json\` on ${state.stateChangedAt ?? '—'}.`,
    `Classifier v${state.classifierVersion}. ${projects.length} projects across ${byLayer.size} layers.`,
    '',
    'Regenerate with `node collect.mjs && node render.mjs`. Do not edit by hand.',
    '',
  ];

  for (const layer of order) {
    const rows = byLayer.get(layer);
    lines.push(`## ${layerOf(layer).label} (${rows.length})`, '');
    lines.push('| Project | Stars | Language | Stack | Description |');
    lines.push('| --- | ---: | --- | --- | --- |');
    for (const p of rows) {
      const stack = p.stack.slice(0, 4).join(', ') || '—';
      const desc = truncate((p.description ?? '—').replace(/\|/g, '\\|'), 90);
      lines.push(
        `| [${p.fullName}](${p.url}) | ${nfmt(p.stars)} | ${p.language ?? '—'} | ${esc(stack)} | ${esc(desc)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The agent mesh — the site's signature animation
// ---------------------------------------------------------------------------

/**
 * A live constellation: the corpus hub at the centre, one satellite per layer,
 * packets running the spokes. Satellite radius tracks layer size, so the
 * animation is also the legend — the shape of the mesh is the shape of the
 * corpus.
 */
function renderMesh(counts, opts = {}) {
  const standalone = opts.standalone === true;
  const items = populatedLayerIds(counts)
    .map((k) => ({ id: k, short: LAYERS[k].short, accent: LAYERS[k].accent, n: counts[k] }))
    .sort((a, b) => b.n - a.n);

  const VBW = 560;
  const VBH = 420;
  const cx = 280;
  const cy = 208;
  // 178 rather than 186: the right-hand labels now extend outward from the node
  // edge instead of straddling it, so the ellipse gives back the margin the
  // widest label ("ORCHESTR") needs to stay inside the viewBox.
  const rx = 178;
  const ry = 134;
  const n = Math.max(items.length, 1);
  const maxN = Math.max(1, ...items.map((d) => d.n));

  const spokes = [];
  const nodes = [];
  const labels = [];
  const packets = [];

  // Labels are anchored to whichever side of the hub the node sits on, and painted
  // after every node. The previous design put a centred label at a fixed radial
  // offset, which meant any label wider than the gap between the node's edge and its
  // own centre ran back under the node — and since the circles were painted last,
  // they covered the first characters. "ORCHESTR" and "MEMORY" both rendered as
  // half-words. Side anchoring cannot collide, because the label begins at the node
  // edge plus a gap and extends outward, away from the circle.
  const LABEL_GAP = 11;

  items.forEach((it, i) => {
    const a = ((-90 + (360 / n) * i) * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = cx + ca * rx;
    const y = cy + sa * ry;
    const r = 15.5 + Math.sqrt(it.n / maxN) * 9;
    const delay = (i * 0.46).toFixed(2);

    spokes.push(
      `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${rgba(it.accent, 0.2)}" stroke-width="1"/>`,
    );

    nodes.push(
      `<g>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r + 6).toFixed(1)}" fill="${rgba(it.accent, 0.07)}"/>` +
        `<circle class="mo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r + 2).toFixed(1)}" fill="none" stroke="${it.accent}" stroke-width="1">` +
        `<animate attributeName="r" values="${(r + 2).toFixed(1)};${(r + 13).toFixed(1)};${(r + 2).toFixed(1)}" dur="3.8s" begin="${delay}s" repeatCount="indefinite"/>` +
        `<animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="3.8s" begin="${delay}s" repeatCount="indefinite"/>` +
        `</circle>` +
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#0C0E13" stroke="${rgba(it.accent, 0.55)}" stroke-width="1.1"/>` +
        `<text x="${x.toFixed(1)}" y="${(y + 4.2).toFixed(1)}" font-size="11.5" font-weight="600" fill="${it.accent}" text-anchor="middle" font-family="${MONO}">${it.n}</text>` +
        `</g>`,
    );

    let lx = x;
    let ly = y + 3.6;
    let anchor = 'middle';
    if (ca > 0.3) {
      anchor = 'start';
      lx = x + r + LABEL_GAP;
    } else if (ca < -0.3) {
      anchor = 'end';
      lx = x - r - LABEL_GAP;
    } else {
      ly = sa < 0 ? y - r - LABEL_GAP + 3 : y + r + LABEL_GAP + 3;
    }
    labels.push(
      `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="8.6" letter-spacing="1.5" fill="#7C7669" text-anchor="${anchor}" font-family="${MONO}">${esc(it.short)}</text>`,
    );

    packets.push(
      `<circle class="mo" r="2.8" fill="${it.accent}" opacity="0">` +
        `<animateMotion dur="3.8s" begin="${delay}s" repeatCount="indefinite" calcMode="linear" ` +
        `keyPoints="0.26;0.9;0.26" keyTimes="0;0.5;1" path="M${cx} ${cy} L${x.toFixed(1)} ${y.toFixed(1)}"/>` +
        `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.14;0.86;1" dur="3.8s" begin="${delay}s" repeatCount="indefinite"/>` +
        `</circle>`,
    );
  });

  const label = `Layer constellation: ${items
    .map((d) => `${d.short.toLowerCase()} ${d.n}`)
    .join(', ')}`;

  // Same mesh, two hosts: an inline <svg> for the site, and a standalone
  // document for the README. The standalone form carries its own reduced-motion
  // rule, because SMIL inside an <img> cannot be stopped by the host page.
  const open = standalone
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${VBW}" height="${VBH}" viewBox="0 0 ${VBW} ${VBH}" role="img" aria-label="${esc(label)}">
  <style>@media (prefers-reduced-motion: reduce){ .mo{ display:none } }</style>`
    : `<svg class="mesh" viewBox="0 0 ${VBW} ${VBH}" role="img" aria-label="${esc(label)}">`;

  return open + `
    <defs>
      <linearGradient id="hubGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${GOLD}"/><stop offset="0.55" stop-color="${GOLD_DEEP}"/><stop offset="1" stop-color="${VIOLET}"/>
      </linearGradient>
      <radialGradient id="hubBloom" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="${rgba(GOLD, 0.16)}"/><stop offset="1" stop-color="${rgba(GOLD, 0)}"/>
      </radialGradient>
    </defs>

    <circle cx="${cx}" cy="${cy}" r="196" fill="url(#hubBloom)"/>
    ${spokes.join('\n    ')}

    <g class="mo">
      <circle cx="${cx}" cy="${cy}" r="112" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="2 9">
        <animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="46s" repeatCount="indefinite"/>
      </circle>
      <circle cx="${cx}" cy="${cy}" r="168" fill="none" stroke="rgba(255,255,255,0.045)" stroke-width="1" stroke-dasharray="2 12">
        <animateTransform attributeName="transform" type="rotate" from="360 ${cx} ${cy}" to="0 ${cx} ${cy}" dur="64s" repeatCount="indefinite"/>
      </circle>
    </g>

    ${nodes.join('\n    ')}
    ${labels.join('\n    ')}
    ${packets.join('\n    ')}

    <circle cx="${cx}" cy="${cy}" r="52" fill="none" stroke="${rgba(GOLD, 0.22)}" stroke-width="1"/>
    <circle class="mo" cx="${cx}" cy="${cy}" r="38" fill="none" stroke="${GOLD}" stroke-width="1.2">
      <animate attributeName="r" values="38;52;38" dur="4.4s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values="0.55;0;0.55" dur="4.4s" repeatCount="indefinite"/>
    </circle>
    <circle cx="${cx}" cy="${cy}" r="38" fill="#0A0C11" stroke="url(#hubGrad)" stroke-width="1.5"/>
    <text x="${cx}" y="${cy - 1}" font-size="8.6" letter-spacing="1.7" fill="#8A8478" text-anchor="middle" font-family="${MONO}">AGENT</text>
    <text x="${cx}" y="${cy + 12}" font-size="8.6" letter-spacing="1.7" fill="#8A8478" text-anchor="middle" font-family="${MONO}">HARNESS</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// The run strip — real numbers out of history/runs.jsonl
// ---------------------------------------------------------------------------

function renderRunStrip(ledger, layerCount, projectCount) {
  const run = ledger?.latest ?? {};
  const nodes = [
    { x: 110, label: 'DISCOVER', big: `${nfmt(run.candidates ?? 0)} candidates`, sub: 'search queries' },
    { x: 370, label: 'ENRICH', big: `${nfmt(run.enriched ?? 0)} manifests`, sub: 'no clones' },
    { x: 630, label: 'CLASSIFY', big: `${nfmt(projectCount)} projects`, sub: `${layerCount} layers` },
    {
      x: 890,
      label: 'RECORD',
      big: ledger?.intact ? 'chain intact' : 'chain broken',
      sub: `${ledger?.runs ?? 0} runs · append-only`,
    },
  ];

  const packets = [];
  for (let i = 0; i < 3; i++) {
    const from = nodes[i].x + 16;
    const to = nodes[i + 1].x - 16;
    packets.push(
      `<circle class="mo" r="3" fill="${i === 2 ? VIOLET : GOLD}" opacity="0">` +
        `<animateMotion dur="2.4s" begin="${(i * 0.8).toFixed(2)}s" repeatCount="indefinite" calcMode="linear" ` +
        `keyPoints="0;1" keyTimes="0;1" path="M${from} 32 L${to} 32"/>` +
        `<animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.16;0.84;1" dur="2.4s" begin="${(i * 0.8).toFixed(2)}s" repeatCount="indefinite"/>` +
        `</circle>`,
    );
  }

  return `<svg viewBox="0 0 1000 96" role="img" aria-label="Pipeline run: ${nodes
    .map((d) => `${d.label} ${d.big}`)
    .join(', ')}">
    <defs>
      <linearGradient id="flowGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${GOLD}" stop-opacity="0"/>
        <stop offset="0.5" stop-color="${GOLD}"/>
        <stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/>
      </linearGradient>
    </defs>

    <path class="pipe-line" d="M110 32 H 890"/>
    <path class="pipe-flow" d="M110 32 H 890"/>
    ${packets.join('\n    ')}

    ${nodes
      .map(
        (d, i) =>
          `<g>` +
          `<circle class="mo" cx="${d.x}" cy="32" r="11" fill="none" stroke="${rgba(GOLD, 0.5)}" stroke-width="1">` +
          `<animate attributeName="r" values="11;21;11" dur="3.2s" begin="${(i * 0.6).toFixed(1)}s" repeatCount="indefinite"/>` +
          `<animate attributeName="stroke-opacity" values="0.45;0;0.45" dur="3.2s" begin="${(i * 0.6).toFixed(1)}s" repeatCount="indefinite"/>` +
          `</circle>` +
          `<circle class="pipe-node" cx="${d.x}" cy="32" r="11"/>` +
          `<circle class="pipe-dot" cx="${d.x}" cy="32" r="3.4" style="animation-delay:${(i * 0.4).toFixed(1)}s"/>` +
          `<g class="mo"><g><animateTransform attributeName="transform" type="rotate" from="0 ${d.x} 32" to="360 ${d.x} 32" dur="${18 + i * 4}s" repeatCount="indefinite"/>` +
          `<circle cx="${d.x}" cy="16" r="1.9" fill="${GOLD}" opacity="0.8"/></g></g>` +
          `<text class="pipe-label" x="${d.x}" y="60">${d.label}</text>` +
          `<text class="pipe-big" x="${d.x}" y="76">${esc(d.big)}</text>` +
          `<text class="pipe-sub" x="${d.x}" y="90">${esc(d.sub)}</text>` +
          `</g>`,
      )
      .join('\n    ')}
  </svg>`;
}

// ---------------------------------------------------------------------------
// README assets
// ---------------------------------------------------------------------------
//
// GitHub sanitises HTML in a README: <style>, <script> and your own CSS classes
// are stripped, so a README cannot be styled. The one thing it does render is an
// <img> pointing at an SVG file in the repo — GitHub serves the file and the
// browser animates it. That is the whole trick behind a "profile README that
// looks like a UI", and it is why these exist as files rather than as markup.
//
// They are regenerated by every run, so the numbers in them are never stale.
// Same XML rule as the cards: the font stacks use single quotes internally.

const compact = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
};

const REDUCED_MOTION_STYLE = `  <style>@media (prefers-reduced-motion: reduce){ .mo{ display:none } }</style>`;

function renderBanner(projects, counts, ledger) {
  const W = 1200;
  const H = 320;
  const totalStars = projects.reduce((a, p) => a + p.stars, 0);
  const layerCount = populatedLayers(counts);
  const runs = ledger?.runs ?? 0;

  const rows = populatedLayerIds(counts)
    .map((k) => ({ id: k, ...LAYERS[k], n: counts[k] }))
    .sort((a, b) => b.n - a.n);

  const maxN = Math.max(1, ...rows.map((r) => r.n));
  const railX = 842;
  const railW = 268;
  const railTop = 62;
  const step = 26;

  const bars = rows
    .map((r, i) => {
      const y = railTop + i * step;
      const w = Math.max(6, (r.n / maxN) * railW);
      return (
        `<text x="${railX - 12}" y="${y + 5}" font-size="9" letter-spacing="1.1" fill="#7C7669" text-anchor="end" font-family="${MONO}">${esc(r.short)}</text>` +
        `<rect x="${railX}" y="${y}" width="${railW}" height="7" rx="3.5" fill="rgba(255,255,255,0.055)"/>` +
        `<rect x="${railX}" y="${y}" width="${w.toFixed(1)}" height="7" rx="3.5" fill="${r.accent}" opacity="0.85">` +
        `<animate attributeName="width" from="0" to="${w.toFixed(1)}" dur="1.2s" begin="${(i * 0.09).toFixed(2)}s" fill="freeze" calcMode="spline" keySplines="0.16 1 0.3 1" keyTimes="0;1"/>` +
        `</rect>` +
        `<circle class="mo" r="2.4" fill="#F5F2EA" opacity="0">` +
        `<animateMotion dur="4.4s" begin="${(i * 0.42).toFixed(2)}s" repeatCount="indefinite" calcMode="linear" keyPoints="0;1" keyTimes="0;1" path="M${railX + 4} ${y + 3.5} L${(railX + w - 4).toFixed(1)} ${y + 3.5}"/>` +
        `<animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.15;0.8;1" dur="4.4s" begin="${(i * 0.42).toFixed(2)}s" repeatCount="indefinite"/>` +
        `</circle>` +
        `<text x="${W - 44}" y="${y + 5}" font-size="9.5" fill="#C6C1B7" text-anchor="end" font-family="${MONO}">${r.n}</text>`
      );
    })
    .join('\n    ');

  const stats = [
    `${nfmt(projects.length)} projects`,
    `${compact(totalStars)} stars`,
    `${layerCount} layers`,
    `${runs} runs logged`,
  ].join('   \u00b7   ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Agent-Harness — a live, versioned registry of the agent-harness ecosystem. ${esc(stats)}">
${REDUCED_MOTION_STYLE}
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#101218"/>
      <stop offset="0.55" stop-color="#0A0B0F"/>
      <stop offset="1" stop-color="#08090C"/>
    </linearGradient>
    <radialGradient id="bloomL" cx="0.06" cy="0.1" r="0.6">
      <stop offset="0" stop-color="${rgba(VIOLET, 0.20)}"/>
      <stop offset="1" stop-color="${rgba(VIOLET, 0)}"/>
    </radialGradient>
    <radialGradient id="bloomR" cx="0.94" cy="0.9" r="0.62">
      <stop offset="0" stop-color="${rgba(GOLD, 0.15)}"/>
      <stop offset="1" stop-color="${rgba(GOLD, 0)}"/>
    </radialGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFF8EC"/>
      <stop offset="0.55" stop-color="${GOLD}"/>
      <stop offset="1" stop-color="#B99BE8"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GOLD}" stop-opacity="0.85"/>
      <stop offset="0.5" stop-color="${VIOLET}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.045"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="46" height="46" patternUnits="userSpaceOnUse">
      <path d="M46 0 H0 V46" fill="none" stroke="#ffffff" stroke-opacity="0.028" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <rect width="${W}" height="${H}" fill="url(#bloomL)"/>
  <rect width="${W}" height="${H}" fill="url(#bloomR)"/>
  <rect width="${W}" height="2" fill="url(#edge)"/>

  <g class="mo">
    <rect x="-220" y="0" width="200" height="${H}" fill="url(#sheen)">
      <animate attributeName="x" values="-220;${W + 40}" dur="7s" repeatCount="indefinite"/>
    </rect>
  </g>

  <text x="56" y="106" font-size="41" font-weight="700" letter-spacing="1.4" fill="url(#title)" font-family="${MONO}">AGENT-HARNESS</text>

  <text x="56" y="144" font-size="14.5" fill="#A9A49A" font-family="${SANS}">A live, versioned registry of the agent-harness ecosystem.</text>
  <text x="56" y="168" font-size="14.5" fill="#7C7669" font-family="${SANS}">Discovered from GitHub, enriched from real manifests, classified into layers,</text>
  <text x="56" y="192" font-size="14.5" fill="#7C7669" font-family="${SANS}">and committed on a schedule — so every change is a diff.</text>

  <g>
    <rect x="56" y="216" width="118" height="26" rx="13" fill="${rgba(GOLD, 0.09)}" stroke="${rgba(GOLD, 0.34)}" stroke-width="1"/>
    <circle cx="76" cy="229" r="3.4" fill="${GOLD}">
      <animate attributeName="opacity" values="1;0.3;1" dur="2.4s" repeatCount="indefinite"/>
    </circle>
    <circle cx="76" cy="229" r="3.4" fill="none" stroke="${GOLD}" stroke-width="1">
      <animate attributeName="r" values="3.4;10;3.4" dur="2.4s" repeatCount="indefinite"/>
      <animate attributeName="stroke-opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite"/>
    </circle>
    <text x="92" y="233" font-size="10" font-weight="600" letter-spacing="2" fill="${GOLD}" font-family="${MONO}">LIVE</text>
  </g>

  <text x="56" y="282" font-size="10.5" letter-spacing="0.6" fill="#6E695F" font-family="${MONO}">${esc(stats)}</text>

  <g>
    <text x="${W - 44}" y="42" font-size="9.5" letter-spacing="2.2" fill="#6E695F" text-anchor="end" font-family="${MONO}">LAYER DISTRIBUTION</text>
    ${bars}
  </g>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="rgba(255,255,255,0.09)"/>
</svg>
`;
}

/**
 * A small endpoint so the README's numbers can be fetched live.
 *
 * shields.io can pull a JSON document when a badge image is requested, which
 * makes the badge current at *page-view* time rather than at commit time. Two
 * things stop it using projects.json directly: that file is ~2.3 MB, and shields
 * has no thousands separator. Hence this: scalars pre-formatted for display,
 * plus the per-layer counts.
 *
 * Derived from committed state only — deliberately no wall-clock timestamp. A
 * `generatedAt` field would differ on every run, and because the workflow commits
 * only when the staged diff is non-empty, that would turn a change-gated pipeline
 * into one that commits four times a day for nothing.
 *
 * Note what this does and does not buy. The badge is fetched live; the data
 * behind it is as fresh as the last collect. A README cannot be more real-time
 * than the pipeline that feeds it.
 */
function renderSummary(projects, counts, ledger) {
  const totalStars = projects.reduce((a, p) => a + p.stars, 0);
  const ordered = populatedLayerIds(counts)
    .map((k) => ({ id: k, label: LAYERS[k].label, short: LAYERS[k].short, count: counts[k] }))
    .sort((a, b) => b.count - a.count);

  // Keyed by layer id rather than an array, so a badge addresses one layer by a
  // path that cannot move. `$.layers.0.count` would silently resolve to a
  // different layer the first time two layers swap rank — a wrong number is worse
  // than a missing one, because nothing looks broken. `layerOrder` carries the
  // ranking separately for anything that wants it.
  const layers = Object.fromEntries(
    ordered.map((l) => [l.id, { label: l.label, short: l.short, count: l.count }]),
  );

  const top = [...projects]
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 8)
    .map((p) => ({ fullName: p.fullName, stars: p.stars, starsCompact: compact(p.stars), layer: p.layer }));

  return `${JSON.stringify(
    {
      schemaVersion: 1,
      classifierVersion: state.classifierVersion,
      stateChangedAt: state.stateChangedAt ?? null,
      stateChangedDate: (state.stateChangedAt ?? '').slice(0, 10),
      projectCount: projects.length,
      projectCountLabel: nfmt(projects.length),
      totalStars,
      totalStarsLabel: nfmt(totalStars),
      totalStarsCompact: compact(totalStars),
      layerCount: ordered.length,
      runs: ledger?.runs ?? 0,
      layerOrder: ordered.map((l) => l.id),
      layers,
      top,
    },
    null,
    2,
  )}\n`;
}

function renderStatsAsset(projects, counts, ledger) {
  const W = 1200;
  const H = 148;
  const totalStars = projects.reduce((a, p) => a + p.stars, 0);
  const cells = [
    { v: nfmt(projects.length), l: 'PROJECTS' },
    { v: nfmt(totalStars), l: 'STARS' },
    { v: String(populatedLayers(counts)), l: 'LAYERS' },
    { v: String(ledger?.runs ?? 0), l: 'RUNS LOGGED' },
    { v: (state.stateChangedAt ?? '—').slice(0, 10), l: 'STATE AS OF', small: true },
    { v: `v${state.classifierVersion}`, l: 'CLASSIFIER', small: true },
  ];

  const cw = (W - 2) / cells.length;
  const body = cells
    .map((c, i) => {
      const x = 1 + i * cw;
      const right = i === cells.length - 1;
      return (
        (right ? '' : `<rect x="${(x + cw).toFixed(1)}" y="1" width="1" height="${H - 2}" fill="rgba(255,255,255,0.075)"/>`) +
        `<text x="${(x + 26).toFixed(1)}" y="76" font-size="${c.small ? 19 : 27}" font-weight="600" fill="#F5F2EA" font-family="${MONO}" letter-spacing="-0.4">${esc(c.v)}</text>` +
        `<text x="${(x + 26).toFixed(1)}" y="100" font-size="9.5" letter-spacing="1.7" fill="#8A8478" font-family="${MONO}">${c.l}</text>` +
        (c.small
          ? ''
          : `<circle class="mo" cx="${(x + 26).toFixed(1)}" cy="118" r="2.2" fill="${GOLD}" opacity="0.7">` +
            `<animate attributeName="opacity" values="0.7;0.15;0.7" dur="${(3 + i * 0.4).toFixed(1)}s" repeatCount="indefinite"/>` +
            `</circle>`)
      );
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Registry state: ${esc(
    cells.map((c) => `${c.l.toLowerCase()} ${c.v}`).join(', '),
  )}">
${REDUCED_MOTION_STYLE}
  <defs>
    <linearGradient id="panel" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="rgba(255,255,255,0.055)"/>
      <stop offset="1" stop-color="rgba(255,255,255,0.014)"/>
    </linearGradient>
    <linearGradient id="top" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GOLD}" stop-opacity="0.8"/>
      <stop offset="0.55" stop-color="${VIOLET}" stop-opacity="0.35"/>
      <stop offset="1" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#0A0B0F"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="url(#panel)"/>
  <rect x="1" y="1" width="${W - 2}" height="2" fill="url(#top)"/>
  ${body}
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="none" stroke="rgba(255,255,255,0.09)"/>
</svg>
`;
}

function renderFeatured(projects, rank) {
  const tiles = [...projects].sort((a, b) => b.stars - a.stars).slice(0, 6);
  const W = 1384;
  const H = 240;
  const tw = 440;
  const th = 96;

  const body = tiles
    .map((p, i) => {
      const x = 16 + (i % 3) * (tw + 16);
      const y = 16 + Math.floor(i / 3) * (th + 16);
      const layer = layerOf(p.layer);
      const r = rank.get(p.fullName) ?? 0;
      const topPct = Math.max(1, Math.ceil(r * 100));
      const fill = Math.round((1 - r) * 100);

      return (
        `<g>` +
        `<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="12" fill="#0C0E13" stroke="rgba(255,255,255,0.09)"/>` +
        `<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="12" fill="${rgba(layer.accent, 0.035)}"/>` +
        `<clipPath id="tile${i}"><rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="12"/></clipPath>` +
        `<g clip-path="url(#tile${i})">` +
        `<rect x="${x}" y="${y}" width="3" height="${th}" fill="${layer.accent}" opacity="0.9"/>` +
        `<rect x="${x}" y="${y}" width="${tw}" height="1.2" fill="${layer.accent}" opacity="0.35"/>` +
        `<g class="mo"><rect x="${x - 150}" y="${y}" width="120" height="${th}" fill="url(#tileSheen)" opacity="0.5">` +
        `<animate attributeName="x" values="${x - 150};${x + tw + 20}" dur="${(5.5 + i * 0.6).toFixed(1)}s" repeatCount="indefinite"/>` +
        `</rect></g>` +
        `</g>` +
        `<text x="${x + 18}" y="${y + 24}" font-size="8.6" letter-spacing="1.3" fill="#6E695F" font-family="${MONO}">${esc(truncate(p.owner.toUpperCase(), 26))}</text>` +
        `<text x="${x + 18}" y="${y + 48}" font-size="15.5" font-weight="600" fill="#F5F2EA" font-family="${SANS}">${esc(truncate(p.name, 26))}</text>` +
        `<circle cx="${x + tw - 24}" cy="${y + 44}" r="4" fill="${p.languageColor || layer.accent}"/>` +
        `<text x="${x + tw - 34}" y="${y + 47}" font-size="9.5" fill="#A9A49A" text-anchor="end" font-family="${MONO}">${esc(truncate(p.language ?? 'Unknown', 13))}</text>` +
        `<text x="${x + 18}" y="${y + 70}" font-size="9.5" fill="#7C7669" font-family="${MONO}">\u2605 ${compact(p.stars)}   \u00b7   ${esc(layer.short)}${p.license ? `   \u00b7   ${esc(p.license)}` : ''}</text>` +
        `<text x="${x + tw - 18}" y="${y + 70}" font-size="9.5" fill="${layer.accent}" text-anchor="end" font-family="${MONO}">TOP ${topPct}%</text>` +
        `<rect x="${x + 18}" y="${y + 80}" width="${tw - 36}" height="3" rx="1.5" fill="rgba(255,255,255,0.07)"/>` +
        `<rect x="${x + 18}" y="${y + 80}" width="${(((tw - 36) * fill) / 100).toFixed(1)}" height="3" rx="1.5" fill="${layer.accent}">` +
        `<animate attributeName="width" from="0" to="${(((tw - 36) * fill) / 100).toFixed(1)}" dur="1.1s" begin="${(i * 0.08).toFixed(2)}s" fill="freeze" calcMode="spline" keySplines="0.16 1 0.3 1" keyTimes="0;1"/>` +
        `</rect>` +
        `</g>`
      );
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Six highest-starred projects in the registry">
${REDUCED_MOTION_STYLE}
  <defs>
    <linearGradient id="tileSheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
    ${body}
</svg>
`;
}

function renderDivider() {
  const W = 1200;
  const H = 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="">
  <defs>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GOLD}" stop-opacity="0"/>
      <stop offset="0.28" stop-color="${GOLD}" stop-opacity="0.5"/>
      <stop offset="0.5" stop-color="${VIOLET}" stop-opacity="0.75"/>
      <stop offset="0.72" stop-color="${GOLD}" stop-opacity="0.5"/>
      <stop offset="1" stop-color="${GOLD}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="6" width="${W}" height="1.4" fill="url(#rule)"/>
  <g transform="translate(${W / 2} 7)">
    <path d="M0 -6 L6 0 L0 6 L-6 0 Z" fill="#0A0B0F" stroke="${GOLD}" stroke-width="1.2" stroke-opacity="0.75"/>
    <path d="M0 -2.6 L2.6 0 L0 2.6 L-2.6 0 Z" fill="${VIOLET}">
      <animate attributeName="opacity" values="1;0.35;1" dur="3.6s" repeatCount="indefinite"/>
    </path>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------

function renderSite(projects, ledger, rank) {
  // Rank is derived, so it is computed once here and carried in the payload
  // rather than recomputed in the browser on every filter pass.
  const rows = projects.map((p) => {
    const r = rank.get(p.fullName) ?? 0;
    return { ...p, rankPct: Math.round((1 - r) * 100), topPct: Math.max(1, Math.ceil(r * 100)) };
  });

  const payload = JSON.stringify({
    generatedAt: state.stateChangedAt ?? null,
    classifierVersion: state.classifierVersion,
    projectCount: rows.length,
    layerCounts: state.layerCounts ?? {},
    projects: rows,
  }).replace(/</g, '\\u003c');

  const layerOrder = Object.keys(LAYERS).filter((k) => k !== 'other');
  const counts = state.layerCounts ?? {};
  const totalStars = projects.reduce((a, p) => a + p.stars, 0);
  const presentLayers = populatedLayers(counts);

  const layerChips = layerOrder
    .filter((k) => counts[k])
    .map(
      (k) =>
        `<button class="chip" type="button" data-layer="${k}" style="--accent:${layerOf(k).accent}"><i class="dot"></i>${esc(layerOf(k).label)}<em>${counts[k]}</em></button>`,
    )
    .join('\n        ');

  const run = ledger?.latest ?? null;
  const ledgerLine = run
    ? [
        `run #${ledger.runs}`,
        `${esc((run.observedAt ?? '').slice(0, 16).replace('T', ' '))} UTC`,
        ledger.intact ? 'hash chain intact' : 'hash chain BROKEN',
        `GraphQL ${nfmt(run.graphqlPointsRemaining)} / 5,000 left`,
        `head ${esc(String(run.entryHash ?? '').slice(0, 8))}`,
      ].join('   \u00b7   ')
    : 'no run ledger yet — run <code>collect.mjs</code> to start one';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Agent-Harness — live registry of agent harness projects</title>
<meta name="description" content="A live, versioned registry of the agent-harness ecosystem: runtimes, orchestration, tools, sandboxes, memory, evals, governance and protocols.">
<style>
  :root{
    --bg:#08090C;
    --surface:rgba(255,255,255,0.028);
    --surface-2:rgba(255,255,255,0.055);
    --line:rgba(255,255,255,0.075);
    --line-2:rgba(255,255,255,0.16);
    --title:#F5F2EA;
    --fg:#BEB9AF;
    --muted:#8A8478;
    --dim:#6E695F;
    --gold:${GOLD};
    --gold-deep:${GOLD_DEEP};
    --violet:${VIOLET};
    --radius:15px;
    /* exponential ease-out — natural deceleration, never bounce/elastic */
    --ease:cubic-bezier(.16,1,.3,1);
    --ease-soft:cubic-bezier(.25,1,.5,1);
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth;background:var(--bg)}
  body{
    margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
    min-height:100vh;position:relative;overflow-x:hidden;
  }
  /* aurora wash */
  body::before{
    content:"";position:fixed;inset:-20% -10%;z-index:0;pointer-events:none;
    background:
      radial-gradient(760px 520px at 14% -6%, rgba(124,92,255,.22), transparent 62%),
      radial-gradient(680px 440px at 86% 2%, rgba(227,183,120,.15), transparent 64%),
      radial-gradient(900px 620px at 52% 112%, rgba(52,211,153,.075), transparent 62%);
    animation:drift 24s var(--ease) infinite alternate;
  }
  /* hairline grid, faded out downward */
  body::after{
    content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.5;
    background-image:
      linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
    background-size:58px 58px;
    -webkit-mask-image:radial-gradient(ellipse 95% 62% at 50% 0%,#000 35%,transparent 100%);
    mask-image:radial-gradient(ellipse 95% 62% at 50% 0%,#000 35%,transparent 100%);
  }
  /* film grain — static, painted once */
  .grain{
    position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.05;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  @keyframes drift{
    from{transform:translate3d(0,0,0) scale(1)}
    to{transform:translate3d(-2%,1.5%,0) scale(1.06)}
  }
  ::selection{background:rgba(227,183,120,.28);color:#fff}
  .wrap{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:46px 26px 90px}

  /* ---------- hero ---------- */
  .hero{display:grid;grid-template-columns:minmax(0,1.06fr) minmax(0,0.86fr);gap:30px;align-items:center}
  .brand{display:flex;align-items:center;gap:14px}
  .mark{width:44px;height:44px;flex:none;overflow:visible}
  .mark .hex{stroke:url(#markGrad);stroke-width:1.6;fill:none;
    stroke-dasharray:34 210;animation:spin 9s linear infinite;transform-origin:21px 21px}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.7)}}
  .mark .node{animation:pulse 3.2s var(--ease) infinite;transform-box:fill-box;transform-origin:center}
  h1{
    font-size:clamp(26px,3.4vw,34px);font-weight:600;color:var(--title);margin:0;
    letter-spacing:-.028em;line-height:1.12;
    background:linear-gradient(96deg,#FFF8EC 8%,${GOLD} 58%,#B99BE8 100%);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;
  }
  .live{
    display:inline-flex;align-items:center;gap:7px;padding:4px 11px 4px 9px;
    border:1px solid rgba(227,183,120,.30);border-radius:999px;
    font:600 10.5px/1 var(--mono);letter-spacing:.13em;color:var(--gold);
    background:rgba(227,183,120,.07);
  }
  .live b{width:6px;height:6px;border-radius:50%;background:var(--gold);
    box-shadow:0 0 0 0 rgba(227,183,120,.55);animation:beacon 2.4s var(--ease) infinite}
  @keyframes beacon{
    0%{box-shadow:0 0 0 0 rgba(227,183,120,.5)}
    70%{box-shadow:0 0 0 9px rgba(227,183,120,0)}
    100%{box-shadow:0 0 0 0 rgba(227,183,120,0)}
  }
  .lede{margin:15px 0 0;max-width:62ch;color:var(--muted);font-size:14.5px}
  .lede b{color:var(--fg);font-weight:500}

  /* ---------- mesh ---------- */
  .meshbox{position:relative;min-width:0}
  .mesh{display:block;width:100%;height:auto;overflow:visible}
  .mesh-caption{
    margin:2px 0 0;text-align:center;font:9.5px/1.5 var(--mono);letter-spacing:.14em;
    color:var(--dim);text-transform:uppercase;
  }

  /* ---------- stats ---------- */
  .stats{
    display:flex;flex-wrap:wrap;gap:0;margin:28px 0 20px;
    border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;
    background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.014));
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  }
  .stat{flex:1 1 122px;padding:16px 20px;border-right:1px solid var(--line);position:relative}
  .stat:last-child{border-right:0}
  .stat b{display:block;font:600 21px/1.2 var(--mono);color:var(--title);
    font-variant-numeric:tabular-nums;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis}
  .stat b[size-s]{font-size:14px}
  .stat span{display:block;margin-top:5px;font-size:10px;color:var(--muted);
    text-transform:uppercase;letter-spacing:.11em}

  /* ---------- run strip ---------- */
  .runstrip{margin:0 0 10px;padding:18px 20px 10px;border:1px solid var(--line);
    border-radius:var(--radius);background:rgba(255,255,255,.018)}
  .runstrip svg{display:block;width:100%;height:auto;overflow:visible}
  .pipe-line{stroke:rgba(255,255,255,.14);stroke-width:1.25;fill:none}
  .pipe-flow{stroke:url(#flowGrad);stroke-width:1.6;fill:none;stroke-dasharray:26 240;
    animation:flow 5.5s linear infinite}
  @keyframes flow{to{stroke-dashoffset:-798}}
  .pipe-node{fill:#0B0C10;stroke:rgba(255,255,255,.20);stroke-width:1.1}
  .pipe-dot{fill:var(--gold);animation:pulse 3.2s var(--ease) infinite;transform-box:fill-box;transform-origin:center}
  .pipe-label{fill:#8A8478;font:600 9.5px var(--mono);letter-spacing:.16em;text-anchor:middle}
  .pipe-big{fill:#C6C1B7;font:600 11px var(--mono);text-anchor:middle}
  .pipe-sub{fill:#5F5A51;font:9px var(--mono);text-anchor:middle}
  .ledger{
    margin:0 0 30px;padding:9px 14px;border:1px solid var(--line);border-top:0;
    border-radius:0 0 var(--radius) var(--radius);background:rgba(255,255,255,.01);
    font:10.5px/1.6 var(--mono);color:var(--dim);letter-spacing:.04em;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  .ledger code{color:var(--muted);font-family:var(--mono)}

  /* ---------- controls ---------- */
  .controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;align-items:center}
  .field{position:relative;flex:1 1 260px;display:flex;align-items:center}
  .field svg{position:absolute;left:13px;width:15px;height:15px;opacity:.42;pointer-events:none}
  input[type=search]{
    width:100%;background:rgba(255,255,255,.032);border:1px solid var(--line);
    color:var(--title);border-radius:11px;padding:11px 44px 11px 38px;font:inherit;font-size:14px;
    outline:none;transition:border-color .18s,box-shadow .18s,background .18s;
  }
  input[type=search]::placeholder{color:var(--dim)}
  input[type=search]:focus{border-color:rgba(227,183,120,.45);background:rgba(255,255,255,.05);
    box-shadow:0 0 0 4px rgba(227,183,120,.09)}
  .kbd{position:absolute;right:11px;font:10px var(--mono);color:var(--dim);
    border:1px solid var(--line);border-radius:5px;padding:2px 6px;pointer-events:none}
  select{
    background:rgba(255,255,255,.032);border:1px solid var(--line);color:var(--fg);
    border-radius:11px;padding:11px 14px;font:inherit;font-size:13.5px;outline:none;cursor:pointer;
    transition:border-color .18s;
  }
  select:hover{border-color:var(--line-2)}
  .count{font:11px var(--mono);color:var(--muted);letter-spacing:.06em;white-space:nowrap}

  .chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:22px}
  .chip{
    background:rgba(255,255,255,.028);border:1px solid var(--line);color:var(--muted);
    border-radius:999px;padding:6px 13px 6px 11px;font:inherit;font-size:12.5px;cursor:pointer;
    display:inline-flex;align-items:center;gap:7px;
    transition:color .16s,border-color .16s,background .16s,transform .16s var(--ease);
  }
  .chip i.dot{width:7px;height:7px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 8px var(--accent);opacity:.85;transition:transform .2s var(--ease)}
  .chip em{font-style:normal;color:var(--dim);font:10.5px var(--mono)}
  .chip:hover{color:var(--title);border-color:var(--accent);transform:translateY(-1px)}
  .chip:hover i.dot{transform:scale(1.35)}
  .chip:active{transform:translateY(0) scale(.985)}
  .chip.on{
    color:var(--title);border-color:var(--accent);
    background:color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .chip.on em{color:var(--accent)}
  .chip.all{--accent:${GOLD}}

  /* ---------- grid ---------- */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(346px,1fr));gap:15px}
  .card{
    position:relative;border:1px solid var(--line);border-radius:var(--radius);
    background:linear-gradient(168deg,rgba(255,255,255,.052),rgba(255,255,255,.014));
    padding:18px 19px 15px;overflow:hidden;isolation:isolate;
    transition:transform .32s var(--ease),border-color .32s,box-shadow .32s;
    animation:rise .5s var(--ease) both;animation-delay:calc(var(--i,0) * 16ms);
  }
  @keyframes rise{from{opacity:0;transform:translateY(12px) scale(.994)}to{opacity:1;transform:none}}
  .grid.instant .card{animation:none}
  .grid.instant .rk-bar i{animation:none}
  .card::before{ /* cursor spotlight */
    content:"";position:absolute;inset:0;z-index:-1;opacity:0;transition:opacity .3s;
    background:radial-gradient(380px circle at var(--mx,50%) var(--my,0%),
      color-mix(in srgb, var(--accent) 16%, transparent), transparent 68%);
  }
  .card::after{ /* accent rail, with a signal travelling down it */
    content:"";position:absolute;left:0;top:0;bottom:0;width:2px;
    background:linear-gradient(180deg,transparent 0%,var(--accent) 42%,transparent 84%);
    background-size:100% 260%;background-repeat:no-repeat;
    animation:railscan 4.6s linear infinite;
    opacity:.5;transition:opacity .3s;
  }
  @keyframes railscan{from{background-position:0 -130%}to{background-position:0 130%}}
  .card:hover{transform:translateY(-4px);border-color:color-mix(in srgb, var(--accent) 42%, transparent);
    box-shadow:0 18px 44px -22px rgba(0,0,0,.85), 0 0 0 1px color-mix(in srgb, var(--accent) 14%, transparent)}
  .card:hover::before{opacity:1}
  .card:hover::after{opacity:1}
  .gloss{ /* sheen sweep, revealed on hover only */
    position:absolute;inset:0;z-index:-1;pointer-events:none;overflow:hidden;
    opacity:0;transition:opacity .25s;
  }
  .gloss::before{
    content:"";position:absolute;top:-40%;bottom:-40%;width:130px;
    background:linear-gradient(100deg,transparent,rgba(255,255,255,.055),transparent);
    transform:translateX(-160px);
  }
  .card:hover .gloss{opacity:1}
  .card:hover .gloss::before{animation:sweep .9s var(--ease-soft) 1}
  @keyframes sweep{to{transform:translateX(520px)}}
  .owner{font:9.5px var(--mono);letter-spacing:.12em;color:var(--dim);text-transform:uppercase}
  .card h3{margin:5px 0 9px;font-size:16.5px;font-weight:600;letter-spacing:-.012em;line-height:1.3}
  .card h3 a{color:var(--title);text-decoration:none;
    background-image:linear-gradient(var(--accent),var(--accent));
    background-size:0% 1px;background-repeat:no-repeat;background-position:0 100%;
    transition:background-size .3s var(--ease)}
  .card h3 a:hover{background-size:100% 1px}
  /* Fixed 3-line block so every card in a row shares one internal rhythm.
     Without the clamp the rank bar, tags and footer drift by up to 40px
     between neighbours and the grid reads as broken. */
  .card p{margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.5;height:58.5px;
    display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

  /* stars rank */
  .rank{display:flex;align-items:center;gap:9px;margin:0 0 12px}
  .rk-label{font:8.6px/1 var(--mono);letter-spacing:.14em;color:var(--dim);white-space:nowrap}
  .rk-bar{flex:1 1 auto;min-width:34px;height:4px;border-radius:2px;
    background:rgba(255,255,255,.07);overflow:hidden}
  .rk-bar i{display:block;height:100%;border-radius:2px;width:var(--rankw,0%);
    background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 55%,transparent),var(--accent) 58%,var(--gold));
    animation:fill 1s var(--ease) both;animation-delay:calc(var(--i,0) * 16ms + 110ms)}
  @keyframes fill{from{width:0}to{width:var(--rankw,0%)}}
  .rk-val{font:8.6px/1 var(--mono);letter-spacing:.14em;color:var(--accent);white-space:nowrap}

  .row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;min-height:22px}
  .tag{font:10px var(--mono);padding:3px 9px;border-radius:999px;white-space:nowrap;
    background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:#A9A49A}
  .tag.layer{background:color-mix(in srgb, var(--accent) 16%, transparent);
    border-color:color-mix(in srgb, var(--accent) 38%, transparent);
    color:var(--accent);font-weight:600}
  .tag.more{color:var(--dim)}
  /* Two fixed footer rows, so the pushed/sha line sits on the same baseline in
     every card instead of wrapping wherever the meta happens to run long. */
  .foot{font:11px var(--mono);color:var(--dim)}
  .foot-a,.foot-b{display:flex;align-items:center;gap:11px;min-width:0}
  .foot-a{margin-bottom:5px}
  .foot-a span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .foot-b .sha{margin-left:auto}
  .lang{display:inline-flex;align-items:center;gap:5px;color:var(--fg);position:relative}
  .lang i{width:8px;height:8px;border-radius:50%;display:inline-block;
    box-shadow:0 0 7px currentColor;transition:transform .25s var(--ease)}
  .card:hover .lang i{transform:scale(1.25)}
  .sha{margin-left:auto;font-size:10px;opacity:.6;letter-spacing:.04em}
  .empty{padding:70px 0;text-align:center;color:var(--muted)}
  .archived{color:#FB7185}

  footer{margin-top:46px;padding-top:22px;border-top:1px solid var(--line);
    font-size:12px;color:var(--dim);line-height:1.7}
  footer code{font-family:var(--mono);color:var(--muted)}
  footer strong{color:var(--fg);font-weight:500}

  /* filter/sort cross-fade where the browser supports it */
  .grid{view-transition-name:registry-grid}
  ::view-transition-old(registry-grid){animation:vt-out .16s var(--ease) both}
  ::view-transition-new(registry-grid){animation:vt-in .26s var(--ease) both}
  @keyframes vt-out{to{opacity:0}}
  @keyframes vt-in{from{opacity:0}}

  @media (max-width:900px){
    .hero{grid-template-columns:1fr;gap:8px}
    .meshbox{order:2;max-width:520px;margin:0 auto}
  }
  @media (max-width:640px){
    .wrap{padding:32px 16px 64px}
    .stat{flex:1 1 50%;border-bottom:1px solid var(--line)}
  }
  @media (prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;
      transition-duration:.001ms!important}
    html{scroll-behavior:auto}
    .grid{view-transition-name:none}
  }
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<div class="wrap">
  <header class="hero">
    <div class="hero-copy">
      <div class="brand">
        <svg class="mark" viewBox="0 0 42 42" aria-hidden="true">
          <defs>
            <linearGradient id="markGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="${GOLD}"/><stop offset="1" stop-color="${VIOLET}"/>
            </linearGradient>
          </defs>
          <path class="hex" d="M21 3.4 35.6 11.7v16.6L21 38.6 6.4 28.3V11.7z"/>
          <circle class="node" cx="21" cy="13" r="2.4" fill="${GOLD}"/>
          <circle class="node" cx="29.5" cy="24" r="2.4" fill="${VIOLET}" style="animation-delay:.5s"/>
          <circle class="node" cx="12.5" cy="24" r="2.4" fill="#38BDF8" style="animation-delay:1s"/>
          <path d="M21 15.4v6.2M21 21.6 29.5 24M21 21.6 12.5 24" stroke="rgba(255,255,255,.22)" stroke-width="1.1" fill="none"/>
        </svg>
        <h1>Agent-Harness</h1>
        <span class="live"><b></b>LIVE</span>
      </div>
      <p class="lede">A live, versioned registry of the agent-harness ecosystem — <b>runtimes, orchestration, tools, sandboxes, memory, evals, governance and protocols</b>. Discovered from GitHub, enriched from real manifests, classified into layers, and committed every six hours. Every change is a diff.</p>
    </div>

    <div class="meshbox">
      ${renderMesh(counts)}
      <p class="mesh-caption">layer constellation · ${projects.length} projects across ${presentLayers} layers</p>
    </div>
  </header>

  <div class="stats">
    <div class="stat"><b data-count="${projects.length}">0</b><span>projects</span></div>
    <div class="stat"><b data-count="${totalStars}">0</b><span>stars</span></div>
    <div class="stat"><b data-count="${presentLayers}">0</b><span>layers</span></div>
    <div class="stat"><b data-count="${ledger?.runs ?? 0}">0</b><span>runs logged</span></div>
    <div class="stat"><b style="font-size:15px">${esc(state.stateChangedAt ? state.stateChangedAt.slice(0, 10) : '—')}</b><span>state as of</span></div>
    <div class="stat"><b style="font-size:15px">v${esc(state.classifierVersion)}</b><span>classifier</span></div>
  </div>

  <div class="runstrip" aria-hidden="true">
    ${renderRunStrip(ledger, presentLayers, projects.length)}
  </div>
  <div class="ledger">${ledgerLine}</div>

  <div class="controls">
    <label class="field">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4 14 14"/>
      </svg>
      <input type="search" id="q" placeholder="Search name, description, stack, language…" autocomplete="off" aria-label="Search projects">
      <span class="kbd">/</span>
    </label>
    <select id="sort" aria-label="Sort projects">
      <option value="stars">Most stars</option>
      <option value="recent">Recently pushed</option>
      <option value="new">Newest</option>
      <option value="name">Name A–Z</option>
    </select>
    <span class="count" id="count"></span>
  </div>

  <div class="chips" id="chips">
        <button class="chip all on" type="button" data-layer=""><i class="dot"></i>All<em>${projects.length}</em></button>
        ${layerChips}
  </div>

  <div class="grid" id="grid"></div>
  <div class="empty" id="empty" hidden>Nothing matches that filter.</div>

  <footer>
    <div><strong>Agent-Harness</strong> · regenerated on a schedule · every card records the commit and classifier version it was derived from.</div>
    <div>State: <code>data/projects.json</code> · History: <code>history/</code> · Cards: <code>assets/cards/</code>. Nothing here is authoritative; GitHub is.</div>
    <div style="margin-top:6px">${esc(
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${layerOf(k).label} ${v}`)
        .join(' \u00b7 '),
    )}</div>
  </footer>
</div>

<script id="data" type="application/json">${payload}</script>
<script>
(function () {
  var state = JSON.parse(document.getElementById('data').textContent);
  var projects = state.projects;
  var activeLayer = '';

  var LAYERS = ${JSON.stringify(
    Object.fromEntries(Object.entries(LAYERS).map(([k, v]) => [k, { label: v.label, accent: v.accent }])),
  ).replace(/</g, '\\u003c')};

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // SMIL ignores prefers-reduced-motion, so the decorative motion layer is
  // removed outright for anyone who asks for less movement. The static mesh,
  // the numbers and the labels all remain.
  if (reduce) {
    document.querySelectorAll('.mo').forEach(function (el) { el.remove(); });
  }

  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var q = document.getElementById('q');
  var sort = document.getElementById('sort');
  var count = document.getElementById('count');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function rel(iso) {
    if (!iso) return 'unknown';
    var d = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (d < 1) return 'today';
    if (d < 2) return 'yesterday';
    if (d < 30) return Math.round(d) + 'd ago';
    if (d < 365) return Math.round(d / 30) + 'mo ago';
    return Math.round(d / 365) + 'y ago';
  }

  function matches(p, term) {
    if (!term) return true;
    var hay = [p.fullName, p.description, p.language, p.layer]
      .concat(p.stack || [])
      .join(' ')
      .toLowerCase();
    return term.split(/\\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  function sortFn(a, b) {
    switch (sort.value) {
      case 'recent': return new Date(b.pushedAt) - new Date(a.pushedAt);
      case 'new': return new Date(b.createdAt) - new Date(a.createdAt);
      case 'name': return a.fullName.localeCompare(b.fullName);
      default: return b.stars - a.stars;
    }
  }

  function card(p, i) {
    var l = LAYERS[p.layer] || LAYERS.other;
    var stack = p.stack || [];
    var tags = stack.slice(0, 3).map(function (s) {
      return '<span class="tag">' + esc(s) + '</span>';
    }).join('');
    if (stack.length > 3) tags += '<span class="tag more">+' + (stack.length - 3) + '</span>';
    var meta = ['&#9733; ' + p.stars.toLocaleString('en-US')];
    if (p.forks) meta.push('&#10562; ' + p.forks.toLocaleString('en-US'));
    if (p.license) meta.push(esc(p.license));
    if (p.archived) meta.push('<span class="archived">archived</span>');

    // cap the stagger: at 90 cards an uncapped delay would leave the last card
    // waiting well over a second for its entrance
    var step = Math.min(i, 22);
    var desc = p.description || 'No description';

    return '<article class="card" style="--accent:' + l.accent + ';--i:' + step + ';--rankw:' + p.rankPct + '%">' +
      '<span class="gloss" aria-hidden="true"></span>' +
      '<div class="owner">' + esc(p.owner) + '</div>' +
      '<h3><a href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a></h3>' +
      '<p title="' + esc(desc) + '">' + esc(desc) + '</p>' +
      '<div class="rank" title="Stars rank within this corpus: top ' + p.topPct + '%">' +
        '<span class="rk-label">STARS RANK</span>' +
        '<span class="rk-bar"><i></i></span>' +
        '<span class="rk-val">TOP ' + p.topPct + '%</span>' +
      '</div>' +
      '<div class="row"><span class="tag layer">' + esc(l.label) + '</span>' + tags + '</div>' +
      '<div class="foot">' +
        '<div class="foot-a">' +
          '<span class="lang"><i style="background:' + (p.languageColor || l.accent) + ';color:' + (p.languageColor || l.accent) + '"></i>' + esc(p.language || 'unknown') + '</span>' +
          '<span>' + meta.join(' \u00b7 ') + '</span>' +
        '</div>' +
        '<div class="foot-b">' +
          '<span>pushed ' + rel(p.pushedAt) + '</span>' +
          '<span class="sha">' + esc((p.commit || '').slice(0, 7)) + '</span>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function paint(noStagger) {
    var term = q.value.trim().toLowerCase();
    var rows = projects.filter(function (p) {
      if (activeLayer && p.layer !== activeLayer) return false;
      return matches(p, term);
    }).sort(sortFn);

    // The entrance stagger and a view transition would fight each other — the
    // transition snapshots frame 0 of the animation, which is an invisible
    // card. So the cross-fade owns the transition and the stagger stands down.
    grid.classList.toggle('instant', noStagger || rows.length > 150);
    grid.innerHTML = rows.map(card).join('');
    empty.hidden = rows.length > 0;
    count.textContent = rows.length + ' / ' + projects.length;
  }

  // Cross-fade the grid on filter/sort where the browser can do it, so the
  // swap reads as a state change rather than a flash.
  function render() {
    if (!reduce && document.startViewTransition) {
      document.startViewTransition(function () { paint(true); });
    } else {
      paint(false);
    }
  }

  document.getElementById('chips').addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    activeLayer = btn.dataset.layer;
    document.querySelectorAll('.chip').forEach(function (c) {
      c.classList.toggle('on', c.dataset.layer === activeLayer);
    });
    render();
  });

  // cursor spotlight — drives both the radial highlight and a slight tilt
  grid.addEventListener('mousemove', function (e) {
    var c = e.target.closest('.card');
    if (!c) return;
    var r = c.getBoundingClientRect();
    var px = (e.clientX - r.left) / r.width;
    var py = (e.clientY - r.top) / r.height;
    c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    c.style.setProperty('--my', (e.clientY - r.top) + 'px');
    if (reduce) return;
    c.style.transform =
      'translateY(-4px) perspective(760px) rotateX(' + ((0.5 - py) * 3.4).toFixed(2) + 'deg)' +
      ' rotateY(' + ((px - 0.5) * 3.8).toFixed(2) + 'deg)';
  });
  grid.addEventListener('mouseleave', function () {
    grid.querySelectorAll('.card').forEach(function (c) { c.style.transform = ''; });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; render(); q.blur(); }
  });

  var debounce = null;
  q.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(render, 90);
  });
  sort.addEventListener('change', render);
  paint(false);

  // count-up on the stats
  document.querySelectorAll('[data-count]').forEach(function (el) {
    var to = Number(el.dataset.count) || 0;
    if (reduce || !to) { el.textContent = to.toLocaleString('en-US'); return; }
    var t0 = performance.now(), dur = 900;
    (function step(now) {
      var k = Math.min(1, (now - t0) / dur);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(to * eased).toLocaleString('en-US');
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  });
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const changed = [];
const ledger = readLedger();
const rank = buildRank(projects);

const cardsDir = join(ROOT, 'assets', 'cards');
const wanted = new Set();

for (const p of projects) {
  const rel = `assets/cards/${slug(p.fullName)}.svg`;
  wanted.add(slug(p.fullName) + '.svg');
  if (writeFile(rel, renderCard(p, rank.get(p.fullName) ?? 0))) changed.push(rel);
}

// Sweep cards for projects that have left the corpus. This used to be done by
// deleting the whole directory up front, which made every card look modified on
// every run and quietly turned the "changed" count into a constant 90.
if (!DRY_RUN && existsSync(cardsDir)) {
  for (const f of readdirSync(cardsDir)) {
    if (!f.endsWith('.svg') || wanted.has(f)) continue;
    rmSync(join(cardsDir, f), { force: true });
    changed.push(`assets/cards/${f} (removed)`);
  }
}

// README assets. These exist as files because a README cannot carry markup —
// see the note above renderBanner. Referenced by the root README, regenerated
// on every run so the numbers in them cannot go stale.
const counts = state.layerCounts ?? {};
const readmeAssets = [
  ['assets/banner.svg', renderBanner(projects, counts, ledger)],
  ['assets/mesh.svg', renderMesh(counts, { standalone: true })],
  ['assets/stats.svg', renderStatsAsset(projects, counts, ledger)],
  ['assets/featured.svg', renderFeatured(projects, rank)],
  ['assets/divider.svg', renderDivider()],
];
for (const [rel, svg] of readmeAssets) {
  if (writeFile(rel, svg)) changed.push(rel);
}

// The compact endpoint the README's live badges fetch — see renderSummary.
if (writeFile('data/summary.json', renderSummary(projects, counts, ledger))) {
  changed.push('data/summary.json');
}

if (writeFile('site/index.html', renderSite(projects, ledger, rank))) changed.push('site/index.html');
if (writeFile('data/index.md', renderMarkdown(projects))) changed.push('data/index.md');

console.log(`projects   ${projects.length}`);
console.log(`cards      ${projects.length} svg`);
console.log(`ledger     ${ledger ? `${ledger.runs} runs, chain ${ledger.intact ? 'intact' : 'BROKEN'}` : 'absent'}`);
console.log(`changed    ${changed.length}`);
if (DRY_RUN) console.log('dry run \u2014 nothing written');
