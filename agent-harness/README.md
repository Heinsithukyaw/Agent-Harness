# Agent-Harness

A live, versioned registry of the agent-harness ecosystem.

Every project that helps you build, run, evaluate, sandbox, observe or govern an
agent harness — discovered automatically, enriched with its real tech stack,
classified by layer, rendered as live cards, and recorded in an append-only
history so you can see **how the ecosystem moved**, not just where it stands.

Runs entirely on GitHub Actions. No server, no database, no third-party service.

---

## The gap this fills

A hand-maintained directory of agent projects is a markdown file someone edits by
hand. Those share three failure modes:

1. **They rot.** A list updated in March still recommends the project that was
   archived in June.
2. **They carry no history.** You cannot tell whether a project is accelerating
   or dying, because only the current row exists.
3. **They are unverifiable.** Nobody knows what the list looked like last month,
   or who changed it, or why.

The corpus is real and large — `topic:agent-harness` alone returns **1,222
repositories**, and roughly 8,000 repos mention "agent harness" in their name or
description. That is far past what a hand-maintained list can track.

Agent-Harness replaces the hand-maintained list with a scheduled collector plus
git as the ledger. The output is a registry where every card records the commit
and classifier version it was derived from, and every change is a commit you can
diff.

---

## Architecture

```
config/sources.json
        │
        ▼
   ┌─────────────────────────────────────────────┐
   │  SEARCH  (the scarce resource)              │
   │  12 queries × up to 3 pages                 │
   │  union → de-duplicate by node id            │
   │  quality floor: 25 stars                    │
   └───────────────────┬─────────────────────────┘
                       │  search rows carry stars + pushedAt
                       ▼
   ┌─────────────────────────────────────────────┐
   │  DIFF  — what actually moved?               │
   │  unchanged row → skip entirely              │
   └───────────────────┬─────────────────────────┘
                       │  only changed repos
                       ▼
   ┌─────────────────────────────────────────────┐
   │  GRAPHQL ENRICHMENT  (batched by node id)   │
   │  metadata + manifests in one request        │
   │  adaptive batch size, retry on 5xx          │
   └───────────────────┬─────────────────────────┘
                       ▼
   ┌─────────────────────────────────────────────┐
   │  CLASSIFY  — layer + relevance + signals    │
   └───────────────────┬─────────────────────────┘
                       ▼
   data/projects.json   data/index.md   data/state-hashes.json
   assets/cards/*.svg   site/index.html
   history/projects/<owner>.jsonl   history/events.jsonl   history/runs.jsonl
```

### The rate-limit economics

This is the constraint that shapes the whole design, and it is not the one you
would guess:

| API | Limit | Role |
|---|---|---|
| **Search** | **30 requests / minute** | the scarce resource |
| GraphQL | 5,000 points / hour | plentiful |
| REST core | 5,000 requests / hour | unused |

Search is capped at **1,000 results per query**, so one topic can never cover the
corpus — overlapping queries on different axes (topic, phrase, star band) are
unioned and de-duplicated. Twelve queries at up to three pages each is at most
34 search requests, which fits inside 30/minute only because the collector paces
itself and fails closed rather than getting throttled.

GraphQL is where the depth comes from, and it is cheap:

| Measurement | Value |
|---|---|
| Repositories enriched in one run | 153 |
| GraphQL points consumed | **120** |
| Points per repository | **≈ 0.78** |
| Manifest files per repository | 7 files + 3 directory probes |
| Cost of a 1,500-project full sweep | ≈ 1,200 points (24% of one hour's budget) |

The key trick is unchanged from the technique it was extracted from:
`object(expression: "HEAD:package.json")` returns file contents **in the same
GraphQL call** as the repository metadata. Stack detection needs no clone and no
extra HTTP request.

### The central optimisation

**The search index is the change detector; GraphQL is the expensive
enrichment.**

Search results already carry `stargazers_count`, `pushed_at` and `archived`. So a
repository whose search row is identical to what we last recorded is skipped
entirely — no GraphQL spent on it. Steady-state cost is therefore proportional
to **churn**, not to corpus size. A 1,500-project registry with 30 projects
moving per day costs roughly the same per run as a 100-project registry with 30
moving.

That is what makes four runs a day affordable, and it is why "real time" stops
being an architectural question. Once enrichment is incremental, refresh
frequency is a cron expression, not a rewrite.

### Refresh tiers

| Tier | Scope | Cadence | Trigger |
|---|---|---|---|
| Incremental | repos whose search row changed | every 6 hours | cron |
| Full | every repository | weekly (Sunday 03:17 UTC) | cron |
| Manual | everything | on demand | `workflow_dispatch` |

The weekly full pass exists to catch what the search index does not reflect:
stack drift, new manifests, renames, classification changes.

---

## Classification

Every project is assigned a primary layer, scored from topics (weight 3), name
and owner (weight 2), and description (weight 2).

| Layer | What it covers |
|---|---|
| `runtime` | durable execution, replay, checkpointing, sagas |
| `orchestration` | multi-agent graphs, planners, crews, agent SDKs |
| `tools` | tool calling, MCP servers, tool gateways, plugins |
| `sandbox` | isolation, microVMs, code execution, interpreters |
| `memory` | retrieval, state stores, context curation |
| `eval` | evals, benchmarks, tracing, observability, replay debugging |
| `governance` | policy, guardrails, approvals, audit, permissions |
| `protocol` | A2A, MCP, interop standards, specifications |
| `gateway` | routing, proxying, cost control, rate limiting |

A project can belong to several layers; `layers` carries the full scored list and
`layer` carries the winner. The taxonomy and its patterns are versioned
(`CLASSIFIER_VERSION`), and every card records the version that produced it, so
a classification is always reproducible.

### Relevance, and where this approach breaks down

Topics are **self-applied and unreliable**. A project can carry
`topic:agent-harness` and still be a chat-with-your-docs app. Star count is not
relevance either — the highest-starred repo in the raw corpus is a document-QA
tool.

So the corpus is gated on a weighted harness-vocabulary score before ranking.
Measured across the 153 repositories discovered from one query, that score
spreads 8–54 with this distribution:

```
 5- 9  ##        2
10-14  ######    6
15-19  ######    6
20-24  ######### 9
25-29  #######   7
30-34  ####     4
35-39  #####    5
50-54  #         1
```

**This gate is necessary but not sufficient, and it is the weakest part of the
system.** Keyword relevance cannot separate "chat with docs" from "agent
harness", because the vocabulary overlaps almost completely — both descriptions
say *agent*, *tool*, *context*, *memory*. A document-QA tool scores 23.

The honest fix, and the next thing worth building, is **seed-based expansion**:

1. Curate ~40 unambiguous seed projects by hand.
2. Expand outward using signals that are hard to game: shared contributors,
   dependency relationships, co-mention in seed READMEs.
3. Keep the keyword gate as a cheap pre-filter, not as the definition of the
   corpus.

Until then, treat the corpus as a good starting point that needs a curated
allowlist on top. `config/sources.json` is where you tighten it.

---

## History

The reason to build this instead of another list.

| File | Written when | Contains |
|---|---|---|
| `history/projects/<owner>.jsonl` | a project's state changes | per-project timeline |
| `history/events.jsonl` | a transition occurs | global event stream |
| `history/runs.jsonl` | every run | heartbeat, hash-chained |

Each project timeline row records stars, forks, open issues, push time, commit
SHA, archived flag, language, stack, layer, license and latest release. Because
rows are only appended when the state hash changes, the log is a record of
**transitions**, not of our schedule.

The global event stream is what makes the history queryable:

```jsonl
{"type":"added","at":"...","fullName":"org/repo","stars":120,"layer":"runtime"}
{"type":"stars","at":"...","fullName":"org/repo","delta":47,"total":167}
{"type":"archived","at":"...","fullName":"org/repo"}
{"type":"language-changed","at":"...","fullName":"org/repo","from":"Python","to":"Rust"}
{"type":"reclassified","at":"...","fullName":"org/repo","from":"tools","to":"runtime"}
```

Which answers questions no static list can: *which projects gained the most
stars this month? Which ones were archived? Which migrated off Python? Which got
reclassified as the taxonomy evolved?*

### Tamper evidence

`history/runs.jsonl` is a hash chain — each entry carries `prevHash`, so
retroactively editing an earlier line breaks every subsequent `entryHash`. The
workflow verifies the chain on every run and fails if it is broken.

Combined with branch protection (no force-push, no deletion on `main`), that
gives append-only as a *guarantee* rather than a description. Verify it locally:

```bash
node -e '
const fs=require("fs");
const rows=fs.readFileSync("history/runs.jsonl","utf8").trim().split("\n")
  .filter(Boolean).map(JSON.parse);
let prev="genesis", ok=true;
for (const r of rows) {
  if (r.prevHash!==prev) { ok=false; console.log("chain break at", r.runId); }
  prev=r.entryHash;
}
console.log(ok ? `chain intact across ${rows.length} runs` : "CHAIN BROKEN");
'
```

---

## Outputs and serving

| Path | What it is |
|---|---|
| `data/projects.json` | the API — full state, every field |
| `data/index.md` | markdown directory, grouped by layer |
| `assets/cards/<slug>.svg` | one embeddable card per project |
| `site/index.html` | the browsable registry, self-contained |
| `data/state-hashes.json` | per-project state hashes driving history |

Nothing here is authoritative. GitHub is the source of truth;
`data/projects.json` is a projection that can be rebuilt from scratch by running
`collect.mjs && render.mjs`. Preserve that property and most failure modes
disappear.

### The site

`site/index.html` is a single file with no external requests. Its identity is
graphite and gold with a violet counterpoint — deliberately not the navy/blue of
a GitHub profile theme — and its signature element is a live **layer
constellation**: one satellite per harness layer, sized by population, with
packets running the spokes, so the shape of the mesh is the shape of the corpus.
Below it the run strip carries the pipeline's own numbers back out of
`history/runs.jsonl`, including a hash-chain check performed at render time.

Motion is treated as a layer, not a decoration:

- Every animated element sits on top of a static equivalent. Nothing carries
  meaning that motion is responsible for delivering.
- SMIL cannot honour `prefers-reduced-motion`, so the decorative motion groups
  are removed from the DOM outright when that preference is set. The mesh, its
  counts, its labels and every card remain complete.
- The card entrance stagger is capped, so filtering 90 cards does not leave the
  last one waiting well over a second.
- Where the browser supports it, filter and sort go through a view transition and
  the entrance stagger stands down, so the two do not fight.

Three properties are worth preserving when editing `render.mjs`:

1. **Card rhythm.** Descriptions are clamped to a fixed three-line block. Without
   the clamp the rank bar, tags and footer drift by up to 40px between
   neighbours in the same row, and the grid reads as broken.
2. **Change gating.** A no-op run must report `changed 0`. Anything that rewrites
   files unconditionally — deleting the card directory up front, for instance —
   turns the change-gated commit into a commit on every single run.
3. **XML safety.** The font stacks are interpolated into XML attributes delimited
   by double quotes, so they must use single quotes internally. A nested double
   quote terminates the attribute, every card fails to parse, and each one
   renders as an empty box while every other signal stays green. The workflow's
   validation step exists to catch exactly this.

**Serving options**, cheapest first:

- **Repo as API** — `raw.githubusercontent.com/<owner>/<repo>/main/data/projects.json`
- **CDN** — `cdn.jsdelivr.net/gh/<owner>/<repo>@main/data/projects.json`, with
  `@<sha>` for immutable pinning
- **GitHub Pages** — publish `site/`; requires enabling Pages in repository
  settings, which is why no deploy workflow ships enabled by default

---

## Governance

Since the audience is agent-harness developers, the registry holds itself to the
standard it documents.

| Control | Implementation |
|---|---|
| Bounded writes | `WRITE_ALLOWLIST` in the collector; re-checked in CI before commit |
| Fail closed | Any unexpected path aborts the run; no partial commits |
| Change gating | Outputs compared byte-for-byte; `stateChangedAt` stamped only on real change |
| Rate-limit safety | Search budget paced and enforced; fails loudly instead of throttling |
| Reproducibility | `card = f(commit_sha, classifier_version)`; both recorded per card |
| Canonical output | Objects and arrays sorted before hashing, so key order cannot cause a diff |
| Deterministic ordering | Stars, then name — never the order the API returned |
| Tamper evidence | Hash-chained run log, verified on every run |
| Provenance | Every card links to its source repository and records its derivation |

**No model is in this pipeline.** Classification is deterministic pattern
matching. That is a deliberate choice: it makes the output reproducible, keeps
the cost at zero, and avoids turning a registry into an AI system with
transparency obligations attached.

---

## Cost

| | |
|---|---|
| Search requests | ≤ 34 per run, paced against a 30/min ceiling |
| GraphQL points | ≈ 0.78 per enriched repository |
| Steady state | proportional to churn, not corpus size |
| Runner minutes | ~3–5 min per run, 4×/day ≈ 600/month |
| Free tier | 2,000 minutes/month — fits with room to spare |
| Storage | ~5 KB per card; JSONL grows only on real change |

One free-tier quirk: **scheduled workflows are disabled after 60 days without
repository activity.** Because this job commits whenever something changes, it
keeps its own clock alive — but a two-month quiet period stops the schedule.
`workflow_dispatch` still works, and any push restarts it.

---

## Setup

```bash
mkdir -p .github/workflows config
cp collect.mjs render.mjs ./
cp config/sources.json config/
cp workflows/registry.yml .github/workflows/

# first run locally
GITHUB_TOKEN=$(gh auth token) node collect.mjs
node render.mjs
open site/index.html
```

`GITHUB_TOKEN` needs no special scopes for public repositories — search and
GraphQL reads work with the default token. If you want to include your own
private repositories in the corpus, use a fine-grained PAT with `Metadata: read`
and `Contents: read`.

Then commit. The workflow runs every 6 hours, on push, and on demand.

### Tuning the corpus

| Knob | Where | Effect |
|---|---|---|
| `queries[]` | `config/sources.json` | add axes to widen; each page costs one search request |
| `qualityFloor` | `config/sources.json` | star floor for entry |
| `minRelevance` | `config/sources.json` | raise to tighten, lower to widen |
| `maxProjects` | `config/sources.json` | cap on the rendered corpus |
| `MAX_PROJECTS` | env | overrides the cap for a single run |
| `ENRICH_CAP` | env | max repositories one run pays to enrich (default `MAX_PROJECTS × 4`, taken by stars) |
| `FULL=1` | env | ignore the change diff, re-enrich everything |
| `--only-query <substr>` | CLI | run a single query while tuning |

---

## Files

```
collect.mjs              discovery, diff, enrichment, classification, history
render.mjs               SVG cards, markdown directory, the registry site
config/sources.json      corpus definition, thresholds, tiers
workflows/registry.yml   the GitHub Actions workflow
data/                    derived state (the API)
assets/cards/            one embeddable SVG per project
site/index.html          the browsable registry
history/                 append-only timelines, events, hash-chained runs
```

---

## Roadmap

1. **Seed-based corpus expansion** — replace keyword relevance with graph
   expansion from a curated seed set. This is the highest-value next step.
2. **Star velocity ranking** — `history/events.jsonl` already contains the deltas;
   a 7-day and 30-day leaderboard is a render change, not a collection change.
3. **Trend detection** — flag projects crossing a velocity threshold. This is the
   signal a static list structurally cannot produce.
4. **CycloneDX SBOM per project** — reuses the manifests already fetched, and
   serves CRA reporting for anyone shipping these dependencies.
5. **Dependency edges** — parse lockfiles to build the dependency graph, which
   both improves relevance and makes the graph expansion in (1) possible.
6. **GitHub Pages deploy** — enable deliberately, once the corpus is trusted.
