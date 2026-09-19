#!/usr/bin/env node
/**
 * build-cards.mjs — live repository cards for a GitHub profile README.
 *
 * Runs entirely inside GitHub Actions. No server, no database, no webhook
 * receiver. The repository *is* the store; git history *is* the audit log.
 *
 *   GitHub GraphQL API  ->  normalize  ->  detect stack  ->  SVG cards
 *                       ->  data/repos.json + history/*.jsonl
 *                       ->  README block between markers
 *
 * Determinism contract (see ../README.md):
 *   1. Output is a pure function of (observed commit SHA, DETECTOR_VERSION).
 *   2. Writes are confined to a path allowlist. Anything else -> exit 1.
 *   3. Outputs are canonicalised (sorted keys/arrays) before hashing.
 *   4. Files are only written when their bytes actually change, so git history
 *      records real state transitions instead of daily noise.
 *
 * Env:
 *   GITHUB_TOKEN     required in CI (secrets.GITHUB_TOKEN or a fine-grained PAT)
 *   PROFILE_LOGIN    the login whose repositories to collect
 *   MAX_REPOS        optional, default 12
 *   OUTPUT_ROOT      optional, default the git root
 *   DRY_RUN=1        optional, print a summary and write nothing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';

const DETECTOR_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LOGIN = process.env.PROFILE_LOGIN;
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_REPOS = Number(process.env.MAX_REPOS ?? 12);
const DRY_RUN = process.env.DRY_RUN === '1';

if (!LOGIN) fail('PROFILE_LOGIN is not set');
if (!TOKEN) fail('GITHUB_TOKEN is not set');

const OUTPUT_ROOT = resolve(
  process.env.OUTPUT_ROOT ?? git(['rev-parse', '--show-toplevel']).trim(),
);

/** Everything the agent is permitted to create or modify. Nothing else. */
const WRITE_ALLOWLIST = [
  'data/repos.json',
  'data/cards.md',
  'history/observations.jsonl',
  'history/runs.jsonl',
  'assets/repos',
];

/**
 * Languages that dominate a repository by bytes without describing it. A repo
 * with 400KB of bundled HTML and 40KB of TypeScript is a TypeScript repo; the
 * GitHub `languages` field is byte-weighted and says HTML. These are demoted to
 * the tail unless nothing else is present.
 */
const LANGUAGE_NOISE = new Set([
  'HTML', 'CSS', 'SCSS', 'Less', 'Markdown', 'JSON', 'YAML', 'TOML',
  'Shell', 'Batchfile', 'Dockerfile', 'Makefile', 'Jupyter Notebook',
]);

/**
 * Optional human overrides, committed alongside the code so they are versioned
 * and reviewable. Shape:
 *   { "Ominibridge": { "language": "TypeScript", "stack": ["MCP","A2A"],
 *                      "description": "...", "hide": false, "pin": 1 } }
 * Anything set here wins over detection — this is the escape hatch for the
 * cases where a byte count cannot know what a project actually is.
 */
const OVERRIDES_PATH = join(OUTPUT_ROOT, 'scripts', 'repo-cards.config.json');
let OVERRIDES = {};
if (existsSync(OVERRIDES_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    if (raw && typeof raw === 'object') {
      // Keyed case-insensitively: GitHub preserves the case a repository was
      // created with, which rarely matches how you write it by hand.
      for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith('_')) continue;
        OVERRIDES[key.toLowerCase()] = value;
      }
    }
  } catch (err) {
    fail(`could not parse ${OVERRIDES_PATH}: ${err.message}`);
  }
}

const overrideFor = (name) => OVERRIDES[String(name).toLowerCase()] ?? {};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** Recursively sort object keys so equal data always hashes identically. */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canon(value[k])]),
    );
  }
  return value;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hashOf = (value) => sha256(JSON.stringify(canon(value)));

/** Resolve a path and refuse anything outside the allowlist. Fail-closed. */
function guard(relPath) {
  const abs = resolve(OUTPUT_ROOT, relPath);
  const rel = relative(OUTPUT_ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`write outside repo: ${relPath}`);

  const allowed = WRITE_ALLOWLIST.some(
    (a) => rel === a || rel.startsWith(a + sep),
  );
  if (!allowed) fail(`path not in WRITE_ALLOWLIST: ${rel}`);
  return abs;
}

/** Write only when the bytes differ. Returns true if the file changed. */
function writeIfChanged(relPath, contents) {
  const abs = guard(relPath);
  if (existsSync(abs) && readFileSync(abs, 'utf8') === contents) return false;
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return true;
}

function appendJsonl(relPath, rows) {
  if (rows.length === 0) return false;
  const abs = guard(relPath);
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, text, 'utf8');
  }
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL: one request per 100 repos, manifests fetched inline
// ---------------------------------------------------------------------------

/**
 * Manifest and marker files we probe for. GitHub's `object(expression:)` lets
 * us pull file contents in the *same* GraphQL call as the repo metadata, so
 * stack detection costs zero extra HTTP requests and needs no clone.
 */
const PROBE_FILES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Makefile',
];

const PROBE_TREES = ['.github/workflows', 'terraform', 'prisma', 'k8s', 'deploy'];

function aliasOf(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '_');
}

function buildQuery() {
  const fileAliases = PROBE_FILES.map(
    (f) => `${aliasOf(f)}: object(expression: "HEAD:${f}") { ... on Blob { text } }`,
  ).join('\n          ');

  const treeAliases = PROBE_TREES.map(
    (t) => `${aliasOf(t)}: object(expression: "HEAD:${t}") { ... on Tree { entries { name } } }`,
  ).join('\n          ');

  return `
query ($login: String!, $cursor: String) {
  rateLimit { limit cost remaining resetAt }
  user(login: $login) {
    repositories(
      first: 100
      after: $cursor
      ownerAffiliations: OWNER
      isFork: false
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        description
        url
        homepageUrl
        isPrivate
        isArchived
        isTemplate
        stargazerCount
        forkCount
        createdAt
        pushedAt
        primaryLanguage { name color }
        languages(first: 8, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name color } }
        }
        repositoryTopics(first: 10) { nodes { topic { name } } }
        licenseInfo { spdxId }
        defaultBranchRef {
          name
          target { ... on Commit { oid committedDate } }
        }
        ${fileAliases}
        ${treeAliases}
      }
    }
  }
}`;
}

async function gql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${LOGIN}-profile-cards`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    fail(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const body = await res.json();
  if (body.errors) fail(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 600)}`);
  return body.data;
}

async function fetchRepos() {
  const query = buildQuery();
  const nodes = [];
  let cursor = null;
  let rateLimit = null;

  for (let page = 0; page < 10; page++) {
    const data = await gql(query, { login: LOGIN, cursor });
    rateLimit = data.rateLimit;
    nodes.push(...data.user.repositories.nodes);
    const info = data.user.repositories.pageInfo;
    if (!info.hasNextPage) break;
    cursor = info.endCursor;
  }

  return { nodes, rateLimit };
}

// ---------------------------------------------------------------------------
// Stack detection — pure, versioned, offline
// ---------------------------------------------------------------------------

/** Each rule: [manifest key, regex over the file text, label]. */
const RULES = [
  ['package_json', /"next"\s*:/, 'Next.js'],
  ['package_json', /"react"\s*:/, 'React'],
  ['package_json', /"tailwindcss"\s*:/, 'Tailwind'],
  ['package_json', /"vite"\s*:/, 'Vite'],
  ['package_json', /"prisma"\s*:|"@prisma\/client"\s*:/, 'Prisma'],
  ['package_json', /"@nestjs\/core"\s*:/, 'NestJS'],
  ['package_json', /"fastify"\s*:/, 'Fastify'],
  ['package_json', /"express"\s*:/, 'Express'],
  ['package_json', /"@modelcontextprotocol\/sdk"\s*:/, 'MCP'],
  ['package_json', /"typescript"\s*:/, 'TypeScript'],
  ['package_json', /"playwright"\s*:|"@playwright\/test"\s*:/, 'Playwright'],
  ['package_json', /"zod"\s*:/, 'Zod'],

  ['pyproject_toml', /fastapi/i, 'FastAPI'],
  ['pyproject_toml', /django/i, 'Django'],
  ['pyproject_toml', /flask/i, 'Flask'],
  ['pyproject_toml', /sqlalchemy/i, 'SQLAlchemy'],
  ['pyproject_toml', /pydantic/i, 'Pydantic'],
  ['pyproject_toml', /torch/i, 'PyTorch'],
  ['pyproject_toml', /uv\b/i, 'uv'],

  ['requirements_txt', /fastapi/i, 'FastAPI'],
  ['requirements_txt', /django/i, 'Django'],
  ['requirements_txt', /torch/i, 'PyTorch'],

  ['go_mod', /gin-gonic\/gin/, 'Gin'],
  ['go_mod', /google\.golang\.org\/grpc/, 'gRPC'],

  ['Cargo_toml', /tokio/, 'Tokio'],
  ['Cargo_toml', /axum/, 'Axum'],

  ['composer_json', /"laravel\/framework"/, 'Laravel'],
];

function detectStack(repo) {
  const files = {};
  for (const f of PROBE_FILES) {
    const node = repo[aliasOf(f)];
    if (node && typeof node.text === 'string') files[aliasOf(f)] = node.text;
  }

  const stack = new Set();

  for (const [file, re, label] of RULES) {
    const text = files[file];
    if (text && re.test(text)) stack.add(label);
  }

  if (files.Dockerfile) stack.add('Docker');
  if (files.docker_compose_yml || files.docker_compose_yaml) stack.add('Docker Compose');

  const trees = {};
  for (const t of PROBE_TREES) {
    const node = repo[aliasOf(t)];
    if (node && Array.isArray(node.entries)) {
      trees[t] = node.entries.map((e) => e.name);
    }
  }
  if (trees['.github/workflows']) stack.add('GitHub Actions');
  if (trees.terraform) stack.add('Terraform');
  if (trees.prisma) stack.add('Prisma');
  if (trees.k8s) stack.add('Kubernetes');

  // A language is only worth showing if it is not already implied by a framework.
  const primary = repo.primaryLanguage?.name ?? null;

  return {
    detectorVersion: DETECTOR_VERSION,
    primaryLanguage: primary,
    stack: [...stack].sort(),
    hasCi: Boolean(trees['.github/workflows']),
  };
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function normalize(repo) {
  const detection = detectStack(repo);
  const commit = repo.defaultBranchRef?.target?.oid ?? null;
  const override = overrideFor(repo.name);

  const languages = (repo.languages?.edges ?? [])
    .map((e) => ({ name: e.node.name, color: e.node.color, size: e.size }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

  // Prefer the largest language that actually characterises the project; fall
  // back to the byte-weighted answer only when everything is "noise".
  const significant = languages.find((l) => !LANGUAGE_NOISE.has(l.name));
  const language = override.language ?? significant?.name ?? languages[0]?.name ?? null;
  const languageColor =
    languages.find((l) => l.name === language)?.color ?? null;

  const stack = override.stack
    ? [...override.stack]
    : detection.stack.filter((s) => s !== language).sort();

  return {
    name: repo.name,
    description: (override.description ?? (repo.description ?? '')).trim() || null,
    // Private repositories 404 for visitors, so the card is rendered unlinked.
    url: repo.isPrivate ? null : repo.url,
    homepage: repo.homepageUrl || null,
    private: repo.isPrivate,
    archived: repo.isArchived,
    template: repo.isTemplate,
    hidden: override.hide === true,
    pin: typeof override.pin === 'number' ? override.pin : null,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    license: repo.licenseInfo?.spdxId ?? null,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    commit,
    committedAt: repo.defaultBranchRef?.target?.committedDate ?? null,
    pushedAt: repo.pushedAt,
    createdAt: repo.createdAt,
    language,
    languageColor,
    languages,
    stack,
    hasCi: detection.hasCi,
    detectorVersion: detection.detectorVersion,
  };
}

/**
 * Hash of everything that should be considered *state*. Volatile observation
 * metadata (when we happened to look) is deliberately absent, so the hash
 * answers "did the repository actually change?", not "did we run?".
 */
function stateHash(card) {
  return hashOf(card);
}

/**
 * Write a derived state file, stamping `stateChangedAt` only when the semantic
 * content really changed. Without this the file would differ on every run and
 * the history would be 730 commits a year of nothing.
 */
function writeStateFile(relPath, doc) {
  const abs = guard(relPath);
  const strip = (d) => {
    const { stateChangedAt, ...rest } = d;
    return JSON.stringify(canon(rest));
  };

  let prev = null;
  if (existsSync(abs)) {
    try {
      prev = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      prev = null;
    }
  }

  if (prev && strip(prev) === strip(doc)) return false;

  const next = { ...doc, stateChangedAt: new Date().toISOString() };
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
  return true;
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

const PALETTE = {
  bg: '#0d1117',
  panel: '#101c2e',
  border: '#1d4f7d',
  title: '#e6edf3',
  body: '#7a93ab',
  accent: '#5AA8DD',
  chipBg: '#14345A',
  chipText: '#9FD4F5',
  pill: '#1d5b8f',
};

const W = 420;
const H = 132;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '\u2026';
}

function chips(items, x, y, maxWidth, limit = 4) {
  const out = [];
  let cx = x;
  const shown = items.slice(0, limit);
  const overflow = items.length - shown.length;

  for (const label of shown) {
    const w = label.length * 6.2 + 16;
    if (cx + w > x + maxWidth) break;
    out.push(
      `<rect x="${cx.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="18" rx="9" fill="${PALETTE.chipBg}"/>` +
        `<text x="${(cx + w / 2).toFixed(1)}" y="${y + 12.5}" font-size="10" fill="${PALETTE.chipText}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(label)}</text>`,
    );
    cx += w + 6;
  }

  if (overflow > 0) {
    const w = 34;
    if (cx + w <= x + maxWidth) {
      out.push(
        `<rect x="${cx.toFixed(1)}" y="${y}" width="${w}" height="18" rx="9" fill="${PALETTE.panel}" stroke="${PALETTE.border}" stroke-width="1"/>` +
          `<text x="${(cx + w / 2).toFixed(1)}" y="${y + 12.5}" font-size="10" fill="${PALETTE.body}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">+${overflow}</text>`,
      );
    }
  }
  return out.join('');
}

function renderCard(card) {
  const langColor = card.languageColor || PALETTE.accent;
  const langLabel = card.language ?? 'Unknown';

  const meta = [];
  if (card.stars > 0) meta.push(`\u2605 ${card.stars}`);
  if (card.forks > 0) meta.push(`\u2442 ${card.forks}`);
  if (card.license) meta.push(card.license);
  if (card.private) meta.push('private');
  if (card.archived) meta.push('archived');

  const metaText = meta.join('  \u00b7  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(card.name)}">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${PALETTE.bg}" stroke="${PALETTE.border}" stroke-width="1"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="3" rx="1.5" fill="${PALETTE.accent}" opacity="0.85"/>
  <text x="18" y="34" font-size="16" font-weight="600" fill="${PALETTE.title}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${esc(truncate(card.name, 26))}</text>
  <circle cx="${W - 24}" cy="29" r="5" fill="${langColor}"/>
  <text x="${W - 34}" y="33" font-size="11" fill="${PALETTE.body}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(truncate(langLabel, 14))}</text>
  <text x="18" y="56" font-size="11.5" fill="${PALETTE.body}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${esc(truncate(card.description ?? 'No description', 62))}</text>
  ${chips(card.stack, 18, 68, W - 36, 5)}
  <text x="18" y="${H - 14}" font-size="10.5" fill="${PALETTE.body}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(metaText)}</text>
  <text x="${W - 18}" y="${H - 14}" font-size="10.5" fill="${PALETTE.border}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">${esc(shortSha(card.commit))}</text>
</svg>
`;
}

const shortSha = (sha) => (sha ? sha.slice(0, 7) : '\u2014');

/** Markdown block: a two-column grid of clickable cards. */
function renderMarkdown(cards) {
  const rows = [];
  for (let i = 0; i < cards.length; i += 2) {
    const pair = cards.slice(i, i + 2);
    const cells = pair.map((c) => {
      const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const img = `![${c.name}](assets/repos/${slug}.svg)`;
      // A private repo has no public URL to link to, so the card stays unlinked.
      return c.url ? `[${img}](${c.url})` : img;
    });
    while (cells.length < 2) cells.push('');
    rows.push(`| ${cells.join(' | ')} |`);
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const START = '<!-- repo-cards:start -->';
const END = '<!-- repo-cards:end -->';

function injectReadmeBlock(block) {
  const readmePath = join(OUTPUT_ROOT, 'README.md');
  if (!existsSync(readmePath)) {
    console.warn('warn: README.md not found, skipping injection');
    return false;
  }
  const current = readFileSync(readmePath, 'utf8');
  const s = current.indexOf(START);
  const e = current.indexOf(END);

  if (s === -1 || e === -1 || e < s) {
    console.warn(`warn: markers ${START} / ${END} not found, skipping injection`);
    return false;
  }

  const next = current.slice(0, s + START.length) + '\n' + block + '\n' + current.slice(e);

  if (next === current) return false;
  if (!DRY_RUN) writeFileSync(readmePath, next, 'utf8');
  return true;
}

async function main() {
  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  const observedAt = new Date().toISOString();

  const { nodes, rateLimit } = await fetchRepos();

  const normalized = nodes.map((n) => normalize(n));

  // Deterministic ordering: explicit pins first (ascending), then most recently
  // pushed, then name as the final tiebreak, so the grid never depends on the
  // order the API happened to return.
  const byRecency = (a, b) => {
    const d = new Date(b.pushedAt) - new Date(a.pushedAt);
    return d !== 0 ? d : a.name.localeCompare(b.name);
  };

  const all = normalized
    .filter((r) => !r.hidden)
    .sort((a, b) => {
      if (a.pin !== null && b.pin !== null) return a.pin - b.pin || byRecency(a, b);
      if (a.pin !== null) return -1;
      if (b.pin !== null) return 1;
      return byRecency(a, b);
    });

  const cards = all.slice(0, MAX_REPOS);

  // ---- derived state -------------------------------------------------------
  const state = {
    schemaVersion: 1,
    detectorVersion: DETECTOR_VERSION,
    login: LOGIN,
    repoCount: cards.length,
    totalRepos: all.length,
    repos: cards,
  };

  const changed = [];

  if (writeStateFile('data/repos.json', state)) {
    changed.push('data/repos.json');
  }

  for (const card of cards) {
    const slug = card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (writeIfChanged(`assets/repos/${slug}.svg`, renderCard(card))) {
      changed.push(`assets/repos/${slug}.svg`);
    }
  }

  const md = renderMarkdown(cards);
  if (writeIfChanged('data/cards.md', md + '\n')) changed.push('data/cards.md');
  if (injectReadmeBlock(md)) changed.push('README.md');

  // ---- append-only history -------------------------------------------------
  // Observations are recorded only when the semantic state actually changed,
  // so the log stays a record of transitions rather than of our schedule.
  const previous = new Map();
  const obsPath = guard('history/observations.jsonl');
  if (existsSync(obsPath)) {
    for (const line of readFileSync(obsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        previous.set(row.name, row.stateHash);
      } catch {
        /* ignore a torn final line */
      }
    }
  }

  const observations = [];
  for (const card of cards) {
    const h = stateHash(card);
    if (previous.get(card.name) === h) continue;
    observations.push({ ...card, observedAt, stateHash: h, runId });
  }

  // A hash chain over the run log: each entry commits to the one before it, so
  // any retroactive edit to history/runs.jsonl breaks verification.
  const runsPath = guard('history/runs.jsonl');
  let prevHash = 'genesis';
  if (existsSync(runsPath)) {
    const lines = readFileSync(runsPath, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    if (last) {
      try {
        prevHash = JSON.parse(last).entryHash;
      } catch {
        /* keep genesis */
      }
    }
  }

  const runEntry = {
    runId,
    observedAt,
    detectorVersion: DETECTOR_VERSION,
    reposChecked: cards.length,
    reposChanged: observations.length,
    rateLimitRemaining: rateLimit?.remaining ?? null,
    outputsChanged: changed.length,
    prevHash,
  };
  runEntry.entryHash = sha256(prevHash + JSON.stringify(canon(runEntry)));

  appendJsonl('history/observations.jsonl', observations);
  appendJsonl('history/runs.jsonl', [runEntry]);

  // ---- report --------------------------------------------------------------
  console.log(`login              ${LOGIN}`);
  console.log(`repos seen         ${all.length}`);
  console.log(`cards rendered     ${cards.length}`);
  console.log(`observations added ${observations.length}`);
  console.log(`files changed      ${changed.length}${changed.length ? ': ' + changed.join(', ') : ''}`);
  console.log(`run entry hash     ${runEntry.entryHash.slice(0, 16)}\u2026`);
  if (rateLimit) {
    console.log(`rate limit         ${rateLimit.remaining}/${rateLimit.limit} (cost ${rateLimit.cost})`);
  }
  if (DRY_RUN) console.log('dry run \u2014 nothing written');
}

main().catch((err) => fail(err.stack ?? String(err)));
