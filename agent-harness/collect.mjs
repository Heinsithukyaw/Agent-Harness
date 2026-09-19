#!/usr/bin/env node
/**
 * collect.mjs — Agent-Harness corpus collector.
 *
 * Builds and maintains a live, versioned registry of the agent-harness
 * ecosystem: every project that helps you build, run, evaluate, sandbox,
 * observe or govern an agent harness.
 *
 *   search API  ->  candidate set        (cheap, but capped at 30 req/min)
 *   diff        ->  what actually moved  (search results carry stars + pushedAt)
 *   GraphQL     ->  deep enrichment      (only for repositories that moved)
 *   classify    ->  harness layer        (versioned, deterministic rules)
 *   history     ->  append-only timeline (only when state changes)
 *
 * The central efficiency idea: **the search index is the change detector and
 * GraphQL is the expensive enrichment.** Search results already tell us stars
 * and pushedAt, so a repository whose search row is unchanged is skipped
 * entirely. Steady-state cost is therefore proportional to churn, not to
 * corpus size.
 *
 * Env:
 *   GITHUB_TOKEN    required (fine-grained PAT or GITHUB_TOKEN)
 *   CORPUS_ROOT     optional, default the git root
 *   MAX_PROJECTS    optional, overrides config
 *   FULL=1          re-enrich every repository, ignoring the diff
 *   DRY_RUN=1       write nothing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';

const CLASSIFIER_VERSION = '1.0.0';
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) fail('GITHUB_TOKEN is not set');

// The traffic endpoints need push access, and GITHUB_TOKEN does not have it:
// `administration` is not a grantable workflow permission, so /traffic/* answers
// 403 on every CI run. A fine-grained PAT with Administration: read, stored as the
// TRAFFIC_TOKEN secret, is the only way in. Falls back to GITHUB_TOKEN so the
// collector still runs — and reports the 403 honestly — before that secret exists.
const TRAFFIC_TOKEN = process.env.TRAFFIC_TOKEN || TOKEN;

const CORPUS_ROOT = resolve(
  process.env.CORPUS_ROOT ?? git(['rev-parse', '--show-toplevel']).trim(),
);

const CONFIG_PATH = join(CORPUS_ROOT, 'config', 'sources.json');
if (!existsSync(CONFIG_PATH)) fail(`config not found: ${CONFIG_PATH}`);
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const QUALITY_FLOOR = CONFIG.qualityFloor ?? 0;
const MIN_RELEVANCE = CONFIG.minRelevance ?? 0;
const MAX_PROJECTS = Number(process.env.MAX_PROJECTS ?? CONFIG.maxProjects ?? 1000);
/**
 * Discovery is cheap and over-fetches; enrichment is the expensive stage. On a
 * cold start there is nothing to diff against, so this bounds how much of the
 * discovered set one run will pay to enrich. The slice is taken by stars, so it
 * is deterministic, and it is a multiple of MAX_PROJECTS because the relevance
 * gate drops a large share of what it sees.
 */
const ENRICH_CAP = Number(process.env.ENRICH_CAP ?? MAX_PROJECTS * 4);
const FULL = process.env.FULL === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY_QUERY = argValue('--only-query');
/** Run only the traffic step. Cheap, and the only way to test it without a full collect. */
const ONLY_TRAFFIC = process.argv.includes('--only-traffic');

/** Everything this job may create or modify. Nothing else. */
const WRITE_ALLOWLIST = ['data', 'history', 'assets'];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, canon(value[k])]),
    );
  }
  return value;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hashOf = (v) => sha256(JSON.stringify(canon(v)));

function guard(relPath) {
  const abs = resolve(CORPUS_ROOT, relPath);
  const rel = relative(CORPUS_ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`write outside corpus: ${relPath}`);
  const ok = WRITE_ALLOWLIST.some((a) => rel === a || rel.startsWith(a + sep));
  if (!ok) fail(`path not in WRITE_ALLOWLIST: ${rel}`);
  return abs;
}

function writeIfChanged(relPath, contents) {
  const abs = guard(relPath);
  if (existsSync(abs) && readFileSync(abs, 'utf8') === contents) return false;
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return true;
}

function readJson(relPath, fallback = null) {
  const abs = guard(relPath);
  if (!existsSync(abs)) return fallback;
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonl(relPath, rows) {
  if (rows.length === 0) return false;
  const abs = guard(relPath);
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    appendFileSync(abs, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Search — the scarce resource
// ---------------------------------------------------------------------------

/**
 * GitHub search allows 30 requests/minute for an authenticated caller. Rather
 * than discovering throttling at the end of a long run, we pace every call and
 * keep a running budget, failing closed if we would exceed it.
 */
class SearchBudget {
  constructor(limitPerMinute = 30) {
    this.limit = limitPerMinute;
    this.timestamps = [];
  }

  async take() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    if (this.timestamps.length >= this.limit) {
      const wait = 60_000 - (now - this.timestamps[0]) + 250;
      console.log(`  search budget exhausted, waiting ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
      return this.take();
    }
    this.timestamps.push(now);
    await sleep(2200); // stay comfortably under the ceiling
  }
}

async function searchPage(query, page, budget) {
  await budget.take();
  const url =
    'https://api.github.com/search/repositories?per_page=100&page=' +
    page +
    '&sort=stars&order=desc&q=' +
    encodeURIComponent(query);

  const res = await fetch(url, {
    headers: {
      Authorization: `bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agent-harness-collector',
    },
  });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    fail(`search throttled (HTTP ${res.status}). resets at ${reset ?? 'unknown'}`);
  }
  if (!res.ok) fail(`search HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  return res.json();
}

async function discover() {
  const budget = new SearchBudget(30);
  const byId = new Map();
  const queries = ONLY_QUERY
    ? CONFIG.queries.filter((q) => q.q.includes(ONLY_QUERY))
    : CONFIG.queries;

  for (const spec of queries) {
    const pages = spec.pages ?? 1;
    let collected = 0;

    for (let page = 1; page <= pages; page++) {
      const data = await searchPage(spec.q, page, budget);
      const items = data.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        if (item.stargazers_count < QUALITY_FLOOR) continue;
        if (item.fork) continue;

        const existing = byId.get(item.node_id);
        if (existing) {
          if (!existing.sources.includes(spec.label)) existing.sources.push(spec.label);
          continue;
        }

        byId.set(item.node_id, {
          nodeId: item.node_id,
          fullName: item.full_name,
          owner: item.owner?.login ?? null,
          name: item.name,
          description: item.description ?? null,
          url: item.html_url,
          homepage: item.homepage || null,
          stars: item.stargazers_count,
          forks: item.forks_count,
          openIssues: item.open_issues_count,
          language: item.language,
          topics: item.topics ?? [],
          license: item.license?.spdx_id ?? null,
          archived: item.archived,
          pushedAt: item.pushed_at,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
          defaultBranch: item.default_branch,
          sources: [spec.label],
        });
        collected++;
      }

      if (items.length < 100) break;
    }

    console.log(`  ${String(spec.label).padEnd(34)} +${String(collected).padStart(4)}  (total ${byId.size})`);
  }

  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// GraphQL enrichment — bulk, by node id
// ---------------------------------------------------------------------------

const PROBE_FILES = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod',
  'Cargo.toml', 'Dockerfile', 'docker-compose.yml',
];
const PROBE_TREES = ['.github/workflows', 'k8s', 'terraform'];

const alias = (p) => p.replace(/[^a-zA-Z0-9]/g, '_');

function buildNodesQuery() {
  const files = PROBE_FILES.map(
    (f) => `${alias(f)}: object(expression: "HEAD:${f}") { ... on Blob { text } }`,
  ).join('\n        ');
  const trees = PROBE_TREES.map(
    (t) => `${alias(t)}: object(expression: "HEAD:${t}") { ... on Tree { entries { name } } }`,
  ).join('\n        ');

  return `
query ($ids: [ID!]!) {
  rateLimit { limit cost remaining resetAt }
  nodes(ids: $ids) {
    ... on Repository {
      id
      nameWithOwner
      name
      description
      url
      homepageUrl
      isArchived
      isFork
      isTemplate
      stargazerCount
      forkCount
      openIssues: issues(states: OPEN) { totalCount }
      createdAt
      pushedAt
      updatedAt
      licenseInfo { spdxId }
      repositoryTopics(first: 20) { nodes { topic { name } } }
      primaryLanguage { name color }
      languages(first: 8, orderBy: { field: SIZE, direction: DESC }) {
        edges { size node { name color } }
      }
      defaultBranchRef { name target { ... on Commit { oid committedDate } } }
      releases(last: 1) { totalCount nodes { tagName publishedAt } }
      ${files}
      ${trees}
    }
  }
}`;
}

async function gql(query, variables, { retries = 4 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'agent-harness-collector',
      },
      body: JSON.stringify({ query, variables }),
    });

    // 5xx from the GraphQL edge usually means the query was too expensive for
    // the node that picked it up, not that anything is actually wrong.
    if (res.status >= 500) {
      lastErr = `HTTP ${res.status}`;
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) fail(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const body = await res.json();
    if (body.errors) {
      // A timeout on a heavy node also surfaces here.
      const timedOut = JSON.stringify(body.errors).includes('timeout');
      if (timedOut && attempt < retries - 1) {
        lastErr = 'GraphQL timeout';
        await sleep(1500 * (attempt + 1));
        continue;
      }
      fail(`GraphQL errors: ${JSON.stringify(body.errors).slice(0, 500)}`);
    }
    return body.data;
  }
  throw new Error(`GraphQL failed after ${retries} attempts: ${lastErr}`);
}

/**
 * Bulk-enrich by node id. Batches shrink on failure: a batch size that works
 * for shallow repositories can 502 on repositories with large manifests, so the
 * collector adapts rather than giving up.
 */
async function enrich(nodeIds, startBatchSize = 25) {
  const query = buildNodesQuery();
  const out = new Map();
  let rateLimit = null;
  let batchSize = startBatchSize;

  let i = 0;
  while (i < nodeIds.length) {
    const batch = nodeIds.slice(i, i + batchSize);
    let data = null;

    try {
      data = await gql(query, { ids: batch });
    } catch (err) {
      if (batchSize > 5) {
        batchSize = Math.max(5, Math.floor(batchSize / 2));
        console.log(`  batch failed (${err.message.slice(0, 60)}) \u2014 shrinking to ${batchSize}`);
        continue;
      }
      console.log(`  skipping ${batch.length} repositories that could not be enriched`);
      i += batch.length;
      continue;
    }

    rateLimit = data.rateLimit;
    for (const node of data.nodes ?? []) {
      if (node && node.id) out.set(node.id, node);
    }

    i += batch.length;
    process.stdout.write(
      `  enriched ${Math.min(i, nodeIds.length)}/${nodeIds.length}  (points left ${data.rateLimit?.remaining ?? '?'})\n`,
    );
  }

  return { repos: out, rateLimit };
}

// ---------------------------------------------------------------------------
// Classification — deterministic, versioned
// ---------------------------------------------------------------------------

const LAYERS = [
  { id: 'runtime', label: 'Runtime', hint: 'durable execution, replay, checkpointing' },
  { id: 'orchestration', label: 'Orchestration', hint: 'multi-agent graphs and planners' },
  { id: 'tools', label: 'Tools & MCP', hint: 'tool calling, MCP servers, gateways' },
  { id: 'sandbox', label: 'Sandboxing', hint: 'isolation and code execution' },
  { id: 'memory', label: 'Memory & Context', hint: 'retrieval, state, context curation' },
  { id: 'eval', label: 'Eval & Tracing', hint: 'evals, observability, replay debugging' },
  { id: 'governance', label: 'Governance', hint: 'policy, guardrails, approvals, audit' },
  { id: 'protocol', label: 'Protocols', hint: 'A2A, MCP, interop standards' },
  { id: 'gateway', label: 'Model Gateway', hint: 'routing, proxying, cost control' },
];

const LAYER_PATTERNS = {
  runtime: [/\bdurable\b/, /\breplay\b/, /checkpoint/, /temporal/, /restate/, /dbos/, /inngest/, /workflow engine/, /\bsaga\b/, /long-running/],
  orchestration: [/langgraph/, /crewai/, /autogen/, /agent sdk/, /swarm/, /orchestrat/, /multi-?agent/, /planner/, /agent framework/, /graph of agents/],
  tools: [/\bmcp\b/, /model context protocol/, /tool call/, /function call/, /tool use/, /toolkit/, /plugin/, /tool gateway/],
  sandbox: [/sandbox/, /firecracker/, /gvisor/, /microvm/, /isolation/, /code execution/, /container runtime/, /\be2b\b/, /code interpreter/],
  memory: [/memory/, /\brag\b/, /vector/, /retrieval/, /context engineering/, /embedding/, /knowledge base/, /context window/],
  eval: [/\beval/, /benchmark/, /tracing/, /observability/, /opentelemetry/, /telemetry/, /replay debug/, /test harness/, /llmops/],
  governance: [/guardrail/, /\bpolicy\b/, /\bopa\b/, /\bcedar\b/, /governance/, /compliance/, /approval/, /audit/, /safety/, /permission/, /access control/],
  protocol: [/a2a/, /agent2agent/, /interop/, /agntcy/, /protocol/, /specification/],
  gateway: [/gateway/, /router/, /proxy/, /\bllm gateway\b/, /cost control/, /rate limit/],
};

/**
 * Vocabulary that indicates a project is actually about harness engineering.
 * Topic tags are self-applied and therefore unreliable — a project can carry
 * `topic:agent-harness` and still be a chat-with-your-docs app. Star count is
 * not relevance either, so the corpus is gated on this score before ranking.
 */
const HARNESS_VOCAB = [
  'harness', 'agent', 'agentic', 'llm', 'tool', 'mcp', 'runtime', 'orchestrat',
  'sandbox', 'eval', 'memory', 'context', 'policy', 'guardrail', 'protocol',
  'framework', 'sdk', 'gateway', 'workflow', 'durable', 'replay', 'tracing',
  'autonomous', 'multi-agent', 'prompt', 'inference', 'swarm', 'planner',
];

/**
 * Weighted relevance. Topics count for most because they are deliberate, names
 * next because they are chosen, descriptions least because they are marketing.
 */
function relevanceOf(name, owner, desc, topics) {
  const topicText = topics.join(' ');
  let score = 0;
  for (const word of HARNESS_VOCAB) {
    if (topicText.includes(word)) score += 3;
    if (name.includes(word)) score += 2;
    if (desc.includes(word)) score += 2;
  }
  return score;
}

/** Signals that a project is harness-shaped rather than a model or a demo. */
function harnessSignals(repo, stack) {
  const signals = [];
  const trees = {};
  for (const t of PROBE_TREES) {
    const node = repo[alias(t)];
    if (node && Array.isArray(node.entries)) trees[t] = node.entries.map((e) => e.name);
  }
  if (trees['.github/workflows']) signals.push('ci');
  if (trees.k8s) signals.push('k8s');
  if (trees.terraform) signals.push('terraform');
  if (stack.includes('Docker')) signals.push('docker');
  if ((repo.releases?.totalCount ?? 0) > 0) signals.push('released');
  if (repo.licenseInfo?.spdxId) signals.push('licensed');
  return signals.sort();
}

function classify(repo, topics, stack) {
  const name = (repo.name ?? '').toLowerCase();
  const owner = (repo.nameWithOwner ?? '').split('/')[0].toLowerCase();
  const desc = (repo.description ?? '').toLowerCase();
  const topicText = topics.join(' ');

  const scores = {};
  for (const layer of LAYERS) {
    let score = 0;
    for (const re of LAYER_PATTERNS[layer.id]) {
      if (re.test(topicText)) score += 3;
      if (re.test(name) || re.test(owner)) score += 2;
      if (re.test(desc)) score += 1;
    }
    if (score > 0) scores[layer.id] = score;
  }

  const ranked = LAYERS
    .filter((l) => scores[l.id])
    .sort((a, b) => scores[b.id] - scores[a.id] || LAYERS.indexOf(a) - LAYERS.indexOf(b));

  return {
    classifierVersion: CLASSIFIER_VERSION,
    primaryLayer: ranked[0]?.id ?? 'other',
    layers: ranked.map((l) => ({ id: l.id, label: l.label, score: scores[l.id] })),
  };
}

// ---------------------------------------------------------------------------
// Normalise
// ---------------------------------------------------------------------------

function stackOf(repo) {
  const files = {};
  for (const f of PROBE_FILES) {
    const node = repo[alias(f)];
    if (node && typeof node.text === 'string') files[alias(f)] = node.text;
  }
  const stack = new Set();

  const push = (file, re, label) => {
    if (files[file] && re.test(files[file])) stack.add(label);
  };

  push('package_json', /"next"\s*:/, 'Next.js');
  push('package_json', /"react"\s*:/, 'React');
  push('package_json', /"@modelcontextprotocol\/sdk"\s*:/, 'MCP SDK');
  push('package_json', /"typescript"\s*:/, 'TypeScript');
  push('package_json', /"@nestjs\/core"\s*:/, 'NestJS');
  push('package_json', /"fastify"\s*:/, 'Fastify');
  push('package_json', /"express"\s*:/, 'Express');
  push('pyproject_toml', /fastapi/i, 'FastAPI');
  push('pyproject_toml', /pydantic/i, 'Pydantic');
  push('pyproject_toml', /langchain/i, 'LangChain');
  push('pyproject_toml', /langgraph/i, 'LangGraph');
  push('pyproject_toml', /torch/i, 'PyTorch');
  push('requirements_txt', /fastapi/i, 'FastAPI');
  push('requirements_txt', /langchain/i, 'LangChain');
  push('requirements_txt', /langgraph/i, 'LangGraph');
  push('go_mod', /gin-gonic\/gin/, 'Gin');
  push('go_mod', /google\.golang\.org\/grpc/, 'gRPC');
  push('Cargo_toml', /tokio/, 'Tokio');

  if (files.Dockerfile) stack.add('Docker');
  if (files.docker_compose_yml) stack.add('Docker Compose');

  for (const t of PROBE_TREES) {
    const node = repo[alias(t)];
    if (node && Array.isArray(node.entries)) {
      if (t === '.github/workflows') stack.add('GitHub Actions');
      if (t === 'k8s') stack.add('Kubernetes');
      if (t === 'terraform') stack.add('Terraform');
    }
  }

  return [...stack].sort();
}

const LANGUAGE_NOISE = new Set([
  'HTML', 'CSS', 'SCSS', 'Markdown', 'JSON', 'YAML', 'TOML', 'Shell',
  'Batchfile', 'Dockerfile', 'Makefile', 'Jupyter Notebook',
]);

function normalize(repo, candidate) {
  const topics = (repo.repositoryTopics?.nodes ?? [])
    .map((n) => n.topic.name)
    .sort();

  const languages = (repo.languages?.edges ?? [])
    .map((e) => ({ name: e.node.name, color: e.node.color, size: e.size }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

  const significant = languages.find((l) => !LANGUAGE_NOISE.has(l.name));
  const language = significant?.name ?? languages[0]?.name ?? null;

  const stack = stackOf(repo).filter((s) => s !== language);
  const classification = classify(repo, topics, stack);
  const signals = harnessSignals(repo, stack);
  const relevance = relevanceOf(
    (repo.name ?? '').toLowerCase(),
    repo.nameWithOwner.split('/')[0].toLowerCase(),
    (repo.description ?? '').toLowerCase(),
    topics,
  );

  return {
    fullName: repo.nameWithOwner,
    owner: repo.nameWithOwner.split('/')[0],
    name: repo.name,
    description: (repo.description ?? '').trim() || null,
    relevance,
    url: repo.url,
    homepage: repo.homepageUrl || null,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    openIssues: repo.openIssues?.totalCount ?? 0,
    archived: repo.isArchived,
    template: repo.isTemplate,
    license: repo.licenseInfo?.spdxId ?? null,
    createdAt: repo.createdAt,
    pushedAt: repo.pushedAt,
    updatedAt: repo.updatedAt,
    commit: repo.defaultBranchRef?.target?.oid ?? null,
    committedAt: repo.defaultBranchRef?.target?.committedDate ?? null,
    defaultBranch: repo.defaultBranchRef?.name ?? null,
    latestRelease: repo.releases?.nodes?.[0]
      ? { tag: repo.releases.nodes[0].tagName, publishedAt: repo.releases.nodes[0].publishedAt }
      : null,
    releaseCount: repo.releases?.totalCount ?? 0,
    language,
    languageColor: languages.find((l) => l.name === language)?.color ?? null,
    languages,
    stack,
    signals,
    layer: classification.primaryLayer,
    layers: classification.layers,
    classifierVersion: classification.classifierVersion,
    discoveredVia: candidate.sources.slice().sort(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Repository traffic — GitHub's own view and clone counts
// ---------------------------------------------------------------------------

/**
 * Views and clones for this repository, from GitHub's traffic API.
 *
 * GitHub retains only 14 days and exposes no all-time figure, so a cumulative
 * count has to be accumulated across runs: each run merges the window it can see
 * into a per-day map, and the totals are the sum over every day ever recorded.
 * Keying by date is what makes the overlap harmless — re-reading a day replaces
 * that day instead of double-counting it.
 *
 * Quiet days are not stored and there is deliberately no wall-clock stamp of our
 * own, so an idle repository produces a byte-identical file and no commit. That
 * is the same property every other output here has.
 *
 * The limit worth stating rather than hiding: if the workflow stops for longer
 * than 14 days, the days in the gap are gone. GitHub will not serve them again,
 * and the cumulative total will simply be missing them.
 *
 * Traffic requires push access. A read-only token gets a 403, which is not a
 * reason to fail an otherwise good run — the recorded days are kept and the step
 * reports what it could not read.
 *
 * On the two kinds of total, which are not the same kind of number:
 *
 *   views and clones   sums, so a cumulative total is meaningful
 *   uniques            a per-day distinct count, and NOT summable — someone who
 *                      visits on three days is counted three times. The field is
 *                      therefore named `visitorDays`, not `visitors`, because a
 *                      name that reads like a headcount would be a lie. There is
 *                      no way to recover the true distinct-visitor count from
 *                      daily windows, and no field here pretends otherwise.
 */
async function collectTraffic() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.log('traffic            skipped (GITHUB_REPOSITORY is not set)');
    return false;
  }

  const abs = guard('data/traffic.json');
  let prev = { days: {} };
  if (existsSync(abs)) {
    try {
      prev = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      prev = { days: {} };
    }
  }

  const days = { ...(prev.days ?? {}) };

  const status = {};
  for (const metric of ['views', 'clones']) {
    const res = await fetch(`https://api.github.com/repos/${repo}/traffic/${metric}`, {
      headers: {
        Authorization: `bearer ${TRAFFIC_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agent-harness-collector',
      },
    });
    status[metric] = res.status;
    if (!res.ok) {
      console.log(`  traffic/${metric} unavailable (HTTP ${res.status}) \u2014 keeping recorded days`);
      continue;
    }
    const body = await res.json();
    for (const row of body[metric] ?? []) {
      const day = String(row.timestamp).slice(0, 10);
      const count = row.count ?? 0;
      const uniques = row.uniques ?? 0;
      if (count === 0 && uniques === 0) {
        delete days[day];
        continue;
      }
      days[day] = {
        ...(days[day] ?? {}),
        [metric]: count,
        [metric === 'views' ? 'uniques' : 'uniqueClones']: uniques,
      };
    }
  }

  // A 403 and a genuine zero are different facts, and only one of them is data.
  // Every CI run since this was added has answered 403, so `views: 0` in this file
  // has never meant "nobody looked" — it has meant "we cannot see". Downstream
  // cannot tell the two apart unless the file records which one happened, and a
  // badge that reads 0 when the truth is unknown is a lie of the same shape as
  // calling summed `uniques` a headcount.
  const available = status.views === 200 && status.clones === 200;

  const dates = Object.keys(days).sort();
  const sum = (k) => dates.reduce((a, d) => a + (days[d][k] ?? 0), 0);
  const views = sum('views');
  const visitorDays = sum('uniques');
  const clones = sum('clones');
  const uniqueClonerDays = sum('uniqueClones');

  const wrote = writeStateFile(
    'data/traffic.json',
    {
      schemaVersion: 1,
      windowDays: 14,
      firstDay: dates[0] ?? null,
      lastDay: dates[dates.length - 1] ?? null,
      recordedDays: dates.length,
      available,
      httpStatus: status,
      days,
      views,
      visitorDays,
      clones,
      uniqueClonerDays,
    },
    true,
  );

  console.log(
    'traffic            ' +
      (available
        ? `${views} views / ${visitorDays} visitor-days / ${clones} clones over ${dates.length} recorded day(s)`
        : `UNAVAILABLE (HTTP ${status.views ?? '?'}) \u2014 set the TRAFFIC_TOKEN secret to a PAT with administration: read`) +
      (wrote ? '' : ' (unchanged)'),
  );
  return wrote;
}

async function main() {
  if (ONLY_TRAFFIC) {
    await collectTraffic();
    return;
  }

  const runId = process.env.GITHUB_RUN_ID ?? 'local';
  const observedAt = new Date().toISOString();

  console.log('discovering corpus');
  const candidates = await discover();
  console.log(`  ${candidates.length} unique repositories above the ${QUALITY_FLOOR}-star floor`);

  const previous = readJson('data/projects.json', { projects: [] });
  const prevByName = new Map((previous.projects ?? []).map((p) => [p.fullName, p]));

  // The search row is the cheap change signal. Anything whose stars or push
  // time matches what we already recorded does not need GraphQL at all.
  const needsEnrichment = candidates.filter((c) => {
    if (FULL) return true;
    const prev = prevByName.get(c.fullName);
    if (!prev) return true;
    if (prev.commit === null) return true;
    return prev.stars !== c.stars || prev.pushedAt !== c.pushedAt || prev.archived !== c.archived;
  });

  // Deterministic order, then bound the paid work. Candidates outside the cap
  // are carried forward from previous state if we have it, and simply not part
  // of the corpus this run if we do not.
  const ranked = [...needsEnrichment].sort(
    (a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName),
  );
  const toEnrich = ranked.slice(0, ENRICH_CAP);
  const deferred = ranked.length - toEnrich.length;

  console.log(
    `\nenriching ${toEnrich.length} of ${candidates.length}` +
      ` (${candidates.length - needsEnrichment.length} unchanged, skipped)` +
      (deferred ? ` · ${deferred} deferred by ENRICH_CAP=${ENRICH_CAP}` : ''),
  );

  const { repos, rateLimit } = toEnrich.length
    ? await enrich(toEnrich.map((c) => c.nodeId))
    : { repos: new Map(), rateLimit: null };

  const byNodeId = new Map(candidates.map((c) => [c.nodeId, c]));

  // Rebuild the corpus: fresh data where we enriched, cached data otherwise.
  const merged = [];
  for (const candidate of candidates) {
    const fresh = repos.get(candidate.nodeId);
    if (fresh) {
      merged.push(normalize(fresh, candidate));
      continue;
    }
    const prev = prevByName.get(candidate.fullName);
    if (prev) {
      // Carry forward, but refresh the fields the search index owns.
      merged.push({
        ...prev,
        stars: candidate.stars,
        forks: candidate.forks,
        openIssues: candidate.openIssues,
        pushedAt: candidate.pushedAt,
        archived: candidate.archived,
      });
    }
  }

  const relevant = merged.filter((p) => (p.relevance ?? 0) >= MIN_RELEVANCE);
  const dropped = merged.length - relevant.length;

  const sorted = relevant
    .sort((a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName))
    .slice(0, MAX_PROJECTS);

  const layerCounts = {};
  for (const p of sorted) layerCounts[p.layer] = (layerCounts[p.layer] ?? 0) + 1;

  const state = {
    schemaVersion: SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    projectCount: sorted.length,
    layerCounts,
    projects: sorted,
  };

  const changed = [];
  if (writeStateFile('data/projects.json', state)) changed.push('data/projects.json');

  // ---- append-only history ------------------------------------------------
  // Per-project timelines and a global event stream, both only written when
  // something actually changed, so the history records transitions rather than
  // our schedule.
  const prevHashes = readJson('data/state-hashes.json', { hashes: {} }).hashes ?? {};
  const nextHashes = {};
  const perProject = new Map();
  const events = [];

  for (const project of sorted) {
    const h = hashOf({ ...project });
    nextHashes[project.fullName] = h;

    const prev = prevByName.get(project.fullName);
    if (prev && prevHashes[project.fullName] === h) continue;

    const row = {
      fullName: project.fullName,
      observedAt,
      runId,
      stars: project.stars,
      forks: project.forks,
      openIssues: project.openIssues,
      pushedAt: project.pushedAt,
      commit: project.commit,
      archived: project.archived,
      language: project.language,
      stack: project.stack,
      layer: project.layer,
      license: project.license,
      latestRelease: project.latestRelease,
      stateHash: h,
    };

    if (!perProject.has(project.owner)) perProject.set(project.owner, []);
    perProject.get(project.owner).push(row);

    if (!prev) {
      events.push({ type: 'added', at: observedAt, fullName: project.fullName, stars: project.stars, layer: project.layer });
    } else {
      if (prev.archived !== project.archived) {
        events.push({ type: project.archived ? 'archived' : 'unarchived', at: observedAt, fullName: project.fullName });
      }
      if (prev.language !== project.language) {
        events.push({ type: 'language-changed', at: observedAt, fullName: project.fullName, from: prev.language, to: project.language });
      }
      if (prev.layer !== project.layer) {
        events.push({ type: 'reclassified', at: observedAt, fullName: project.fullName, from: prev.layer, to: project.layer });
      }
      const delta = project.stars - (prev.stars ?? 0);
      if (delta !== 0) {
        events.push({ type: 'stars', at: observedAt, fullName: project.fullName, delta, total: project.stars });
      }
    }
  }

  for (const [owner, rows] of perProject) {
    if (appendJsonl(`history/projects/${owner.toLowerCase()}.jsonl`, rows)) {
      changed.push(`history/projects/${owner.toLowerCase()}.jsonl`);
    }
  }
  if (appendJsonl('history/events.jsonl', events)) changed.push('history/events.jsonl');

  writeStateFile('data/state-hashes.json', { hashes: nextHashes }, true);

  // ---- hash-chained run log ----------------------------------------------
  let prevHash = 'genesis';
  const runsPath = guard('history/runs.jsonl');
  if (existsSync(runsPath)) {
    const lines = readFileSync(runsPath, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    if (last) {
      try { prevHash = JSON.parse(last).entryHash; } catch { /* keep genesis */ }
    }
  }

  const runEntry = {
    runId,
    observedAt,
    classifierVersion: CLASSIFIER_VERSION,
    candidates: candidates.length,
    enriched: needsEnrichment.length,
    projects: sorted.length,
    transitions: events.length,
    searchCalls: 0,
    graphqlPointsRemaining: rateLimit?.remaining ?? null,
    prevHash,
  };
  runEntry.entryHash = sha256(prevHash + JSON.stringify(canon(runEntry)));
  appendJsonl('history/runs.jsonl', [runEntry]);

  // Last, and independent of the corpus: traffic is about this repository, not
  // about the projects it catalogues.
  await collectTraffic();

  console.log(`\nprojects           ${sorted.length}`);
  console.log(`filtered out       ${dropped} below relevance ${MIN_RELEVANCE}`);
  console.log(`enriched           ${needsEnrichment.length}`);
  console.log(`transitions        ${events.length}`);
  console.log(`files changed      ${changed.length}`);
  console.log('layers             ' + Object.entries(layerCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));
  console.log(`run entry hash     ${runEntry.entryHash.slice(0, 16)}\u2026`);
  if (rateLimit) console.log(`graphql remaining  ${rateLimit.remaining}/${rateLimit.limit}`);
  if (DRY_RUN) console.log('dry run \u2014 nothing written');
}

/** Like the profile collector: stamp the write time only when content differs. */
function writeStateFile(relPath, doc, quiet = false) {
  const abs = guard(relPath);
  const strip = (d) => {
    const { stateChangedAt, ...rest } = d;
    return JSON.stringify(canon(rest));
  };

  let prev = null;
  if (existsSync(abs)) {
    try { prev = JSON.parse(readFileSync(abs, 'utf8')); } catch { prev = null; }
  }
  if (prev && strip(prev) === strip(doc)) return false;

  const next = { ...doc, stateChangedAt: new Date().toISOString() };
  if (!DRY_RUN) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(next, null, 2) + '\n', 'utf8');
  }
  if (!quiet) process.stdout.write('');
  return true;
}

main().catch((err) => fail(err.stack ?? String(err)));
