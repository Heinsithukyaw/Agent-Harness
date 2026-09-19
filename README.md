# Agent-Harness

A live, versioned registry of the agent-harness ecosystem.

Every six hours a scheduled collector discovers the projects that help you build,
run, evaluate, sandbox, observe or govern an agent harness, enriches each one with
real metadata and its **actual** tech stack parsed from manifests, classifies it
into a harness layer, and commits whatever changed. Cards, a markdown directory
and a browsable site are rendered from committed state — so the entire surface can
be rebuilt from scratch at any time.

Nothing in this repository is authoritative. GitHub is.

---

## What it produces

| Surface | Path | Use |
|---|---|---|
| Machine-readable state | `data/projects.json` | the API |
| Embeddable cards | `assets/cards/<owner>-<repo>.svg` | one SVG per project |
| Browsable registry | `site/index.html` | self-contained, no CDN, no build step |
| Markdown directory | `data/index.md` | grouped by layer |
| Append-only history | `history/` | per-project timelines, event stream, hash-chained runs |

Every card and every row records the commit SHA and classifier version it was
derived from, so any render can be reproduced byte for byte.

---

## Why a registry, not a list

A hand-curated list rots, carries no history, and cannot be verified. An entry
from three years ago tells you a project was interesting once; it cannot tell you
when it was last pushed, whether it is archived, or what its stack looked like
last month.

This registry is regenerated four times a day. Every change is a commit you can
diff, every observation is appended rather than overwritten, and the corpus is
re-derived from a public index instead of from someone's memory.

---

## How it works

```
discover ──▶ diff ──▶ enrich ──▶ classify ──▶ record ──▶ render ──▶ commit
  │           │         │           │           │
  │           │         │           │           └─ append-only JSONL + hash chain
  │           │         │           └─ 9-layer taxonomy, deterministic
  │           │         └─ GraphQL nodes(ids:) + object(expression:"HEAD:…")
  │           └─ skip anything whose search row is unchanged
  └─ 12 overlapping search queries, unioned and de-duplicated by node id
```

### The numbers that shaped the design

The corpus is real and it was measured before anything was built:

| Query | Repositories |
|---|---:|
| `topic:agent-harness` | **1,222** |
| `topic:agent-framework` | 2,664 |
| `"agent harness"` in name/description | **7,978** |
| `topic:agent-runtime` | 909 |
| `topic:ai-agents` | 94,547 *(too broad to use directly)* |

The binding constraint is not the one you would guess:

| API | Limit | Verdict |
|---|---|---|
| **Search** | **30 requests / minute** | **the scarce resource** |
| GraphQL | 5,000 points / hour | plentiful |
| REST core | 5,000 requests / hour | unused |

Search also caps at **1,000 results per query**, so no single topic can cover the
corpus. Queries are overlapping and unioned by node id instead.

Measured enrichment cost from a real run: **153 repositories for 120 GraphQL
points — about 0.78 points each.** A full 1,500-project sweep costs roughly 1,200
points, a quarter of one hour's budget. Manifests ride along in the same GraphQL
call as the metadata via `object(expression: "HEAD:package.json")`, so stack
detection needs no clone and no extra request.

### The optimisation that makes "real time" a non-question

**The search index is the change detector; GraphQL is the expensive enrichment.**

Search rows already carry stars, push time and archived status, so a repository
whose row is unchanged is skipped entirely. Steady-state cost becomes proportional
to **churn, not corpus size**.

That retires the original "real time" question rather than answering it. Webhooks
look like the obvious design and are the wrong one: a ~10 second delivery timeout,
no guaranteed retry, and a three-day redelivery window mean webhooks still need an
always-on endpoint plus a reconciler. Once enrichment is incremental, moving from
twice a day to every six hours is a cron expression, not a rewrite.

The workflow ships at every six hours, with a weekly full re-enrichment to catch
stack drift the search index cannot see.

---

## Repository layout

```
agent-harness/
  collect.mjs              discovery → diff → enrichment → classification → history
  render.mjs               SVG cards, markdown directory, the registry site
  config/sources.json      corpus definition, thresholds, tuning knobs
  workflows/registry.yml   Actions workflow: 6-hourly, weekly full, allowlist + chain checks
  data/                    derived state — the API
  assets/cards/            one embeddable SVG per project
  site/index.html          the browsable registry
  history/                 append-only timelines, event stream, hash-chained runs
  README.md                full design notes
```

`profile-cards/` sits alongside it: the same technique extracted and applied to a
single account, where the collector pattern was proven first.

---

## The layer taxonomy

| Layer | What lands here |
|---|---|
| Runtime | execution loops, agent loops, durable execution |
| Orchestration | multi-agent coordination, workflow and state machines |
| Tools & MCP | tool servers, function calling, protocol adapters |
| Sandboxing | microVMs, gVisor, containers, isolation boundaries |
| Memory & Context | vector stores, context windows, retrieval, state |
| Eval & Tracing | benchmarks, observability, tracing, replay |
| Governance | policy, guardrails, permissioning, audit |
| Protocols | MCP, A2A, agent-to-agent wire formats |
| Model Gateway | routing, provider abstraction, rate limiting |

Classification is weighted pattern matching over topics, description, README,
manifests and workflow files — not a model call.

---

## Where this is genuinely hard

### 1. Relevance cannot be solved with keywords

Topics are self-applied and unreliable. A project can carry `topic:agent-harness`
and still be a chat-with-your-docs app. Star count is not relevance either — the
highest-starred repository in the raw corpus is a document-QA tool.

The weighted harness-vocabulary gate works, but it is the weakest part of the
system and should not be treated as the definition of the corpus. Across the 153
repositories from one query the score spreads 8–54, and a document-QA tool still
scores 23, because the vocabulary overlaps almost completely: both kinds of
project say *agent*, *tool*, *context*, *memory*.

The real fix is **seed-based expansion**: curate roughly 40 unambiguous seed
projects, then expand using signals that are hard to game — shared contributors,
dependency edges, co-mention in seed READMEs. The keyword gate stays as a cheap
pre-filter, not as the definition.

### 2. A deterministic agent is not achievable; deterministic controls are

There is no model in this pipeline, and that is deliberate. Classification is
pattern matching, so `card = f(commit_sha, classifier_version)` reproduces
exactly, and every card records both.

Guaranteed: bounded writes enforced twice and failing closed, canonical
serialisation, change-gated commits, a hash-chained run log, deterministic
ordering. Not guaranteed, and not claimed: that a scheduled run fires on time, or
that a registry with a language model in the loop would be reproducible.

---

## Governance

Proportionate to the scale — this is a public read-only registry, not a
production control plane.

| Control | Implementation |
|---|---|
| Bounded writes | `WRITE_ALLOWLIST` in the collector, re-checked in CI before commit |
| Fail closed | an unexpected path aborts the run; no partial commits |
| Change gating | byte comparison; timestamps stamped only on real change |
| Rate-limit safety | search budget paced and enforced; fails loudly rather than throttling |
| Tamper evidence | hash-chained run log, verified on every run |
| Reproducibility | commit SHA + classifier version recorded per card |

**Branch protection on `main` — no force-push, no deletion — is required for the
append-only claim to hold.** Without it, "append-only history" describes git's
defaults rather than a guarantee. Git history is the tamper-evident log; branch
protection is what makes it one.

---

## Compliance

A registry like this is **minimal risk** under the EU AI Act — not an Annex III
system — so it should not be built to the high-risk bar. Annex III obligations
moved to 2 December 2027 under the Digital Omnibus (Reg (EU) 2026/1744); Annex I
to 2 August 2028.

The deadline that has actually passed is the **Cyber Resilience Act's reporting
duty, live since 11 September 2026**. The SBOM it expects is the same manifest
data the collector already fetches, which makes that roadmap item close to free.

---

## Cost

| | |
|---|---|
| Search requests | ≤ 34 per run, paced against a 30/min ceiling |
| GraphQL points | ≈ 0.78 per enriched repository |
| Steady state | proportional to churn |
| Runner minutes | ~4 min × 4/day ≈ 500/month |
| Free tier | 2,000 minutes/month — fits comfortably |

There is no database, no server and no third-party card service. The repository is
the store; `raw.githubusercontent.com` or jsDelivr is the CDN.

---

## Using the data

```
https://raw.githubusercontent.com/<owner>/<repo>/main/data/projects.json
https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/data/projects.json
```

Embedding a card, which stays current because the SVG is regenerated:

```markdown
[![owner/repo](https://raw.githubusercontent.com/<owner>/<repo>/main/assets/cards/owner-repo.svg)](https://github.com/owner/repo)
```

Fields in `data/projects.json`: identity and URL, stars, forks, open issues,
license, created/pushed/updated timestamps, default branch and HEAD commit,
latest release, languages with colours, detected stack, harness signals, assigned
layer and layer scores, relevance score, discovered-via provenance.

---

## Running it locally

```bash
export GITHUB_TOKEN=...          # fine-grained PAT, public read is enough
cd agent-harness
node collect.mjs                 # discover, enrich, classify, record
node render.mjs                  # cards, markdown, site
open site/index.html
```

Tuning lives in `config/sources.json`: `qualityFloor` (minimum stars),
`minRelevance` (harness-vocabulary gate), `maxProjects`, and the refresh tiers.
`--only-query <label>` runs a single discovery query while iterating.

---

## Roadmap

1. **Seed-based corpus expansion** — the relevance fix described above.
2. **Branch protection on `main`** — makes the history claim true.
3. **Star velocity leaderboards** — the deltas are already in
   `history/events.jsonl`; a render change, not a collection change.
4. **Trend detection** — flag projects crossing a velocity threshold. The signal a
   static list structurally cannot produce.
5. **CycloneDX SBOMs** — reuses manifests already fetched; serves CRA reporting.
6. **GitHub Pages** — publish `site/` for a real URL.

---

## License

Code: MIT. Data in `data/` and `history/` is derived from public GitHub metadata;
each project remains under its own licence, recorded per row as `license`.
