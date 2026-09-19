# profile-cards

Live repository cards for a GitHub profile README — built entirely inside GitHub
Actions. No server, no database, no webhook receiver, no third-party card
service. The repository is the store; git history is the audit log.

This is a drop-in companion to the existing `stats.yml` workflow in
`Heinsithukyaw/Heinsithukyaw`: same author identity, same palette, same
"commit only if something changed" discipline.

---

## Why this shape

**Batch beats real time here.** GitHub webhooks have a ~10 second timeout, no
guaranteed automatic retry, and only a 3-day manual redelivery window. Being
trustworthy in real time would therefore mean running a public endpoint *and* a
reconciliation loop to catch what the endpoint missed. A scheduled sweep of a
few dozen repositories costs **one GraphQL request** and is correct by
construction. Twice a day is what you asked for, and it is also the right
answer.

**Manifests ride along with the metadata.** GitHub's `object(expression:)` field
lets the collector pull `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`
and friends *in the same query* as the repository metadata. Stack detection
therefore costs zero extra requests and never clones anything.

**Only real changes are committed.** Outputs are compared byte-for-byte before
writing, and the observation log only grows when a repository's semantic state
actually changes. Without that, a twice-daily job would produce ~730 commits a
year of identical files and the history would be worthless.

---

## Install

```bash
# 1. from the profile repo root
mkdir -p scripts .github/workflows data assets/repos

cp <this-dir>/build-cards.mjs   scripts/build-cards.mjs
cp <this-dir>/preview.mjs       scripts/preview-cards.mjs
cp <this-dir>/workflows/repo-cards.yml .github/workflows/repo-cards.yml
cp <this-dir>/scripts/repo-cards.config.json scripts/repo-cards.config.json

# 2. add the markers to README.md where the grid should appear
#    <!-- repo-cards:start -->
#    <!-- repo-cards:end -->

# 3. dry run locally
GITHUB_TOKEN=$(gh auth token) PROFILE_LOGIN=Heinsithukyaw \
  node scripts/build-cards.mjs
```

Then commit and push. The workflow runs on push, on `workflow_dispatch`, and
twice daily at 04:17 and 16:17 UTC.

### Seeing the result before it ships

```bash
node scripts/preview-cards.mjs --root . --out preview/repo-cards-preview.html
open preview/repo-cards-preview.html
```

The preview inlines every SVG, so it is a single portable file. Add
`preview/repo-cards-preview.html` to `.gitignore` alongside the existing
`preview/readme-preview.html`.

---

## Configuration

### Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GITHUB_TOKEN` | yes | — | `secrets.GITHUB_TOKEN` works for public repos only |
| `PROFILE_LOGIN` | yes | — | the login whose repositories to collect |
| `MAX_REPOS` | no | `12` | how many cards to render |
| `OUTPUT_ROOT` | no | git root | useful for local testing |
| `DRY_RUN` | no | — | `1` prints a summary and writes nothing |

### `scripts/repo-cards.config.json`

Human overrides. Anything set here wins over detection, and the file is
committed, so every override is versioned and reviewable.

```json
{
  "Ominibridge": {
    "language": "TypeScript",
    "stack": ["MCP", "A2A", "OpenAPI", "REST"],
    "description": "One API configuration becomes four governed integration surfaces",
    "pin": 1
  },
  "some-scratch-repo": { "hide": true }
}
```

Keys are matched **case-insensitively**, because GitHub preserves whatever case
a repository was created with.

This matters more than it looks. GitHub's `languages` field is weighted by
**bytes**, so a project with a large bundled `index.html` reports as HTML even
when it is overwhelmingly TypeScript. The collector demotes a known set of
noise languages (`HTML`, `CSS`, `Markdown`, `JSON`, `Shell`, …) to the tail, and
the override file is the escape hatch for whatever that still gets wrong.

---

## Outputs

| Path | Written when | Purpose |
|---|---|---|
| `data/repos.json` | semantic state changes | the derived state, for any consumer |
| `data/cards.md` | state changes | the markdown grid, standalone |
| `assets/repos/<slug>.svg` | that card changes | one self-contained SVG per repository |
| `README.md` | the block changes | only between the two markers |
| `history/observations.jsonl` | a repo's state changes | append-only record of transitions |
| `history/runs.jsonl` | every run | heartbeat, hash-chained |

`history/runs.jsonl` is a hash chain: each entry carries `prevHash`, so
retroactively editing an earlier line breaks every subsequent `entryHash`. That
is cheap tamper-evidence without any extra infrastructure.

Verify it at any time:

```bash
node -e '
const fs=require("fs");
const rows=fs.readFileSync("history/runs.jsonl","utf8").trim().split("\n").map(JSON.parse);
let prev="genesis", ok=true;
for (const r of rows) {
  const {entryHash,...rest}=r;
  if (r.prevHash!==prev) { ok=false; console.log("chain break at", r.runId); }
  prev=entryHash;
}
console.log(ok ? `chain intact across ${rows.length} runs` : "CHAIN BROKEN");
'
```

---

## The private-repository question

This is the one decision that actually needs your input.

Your account has **1 public repository**. Everything else is private, which has
two consequences:

1. **`secrets.GITHUB_TOKEN` cannot see them.** The automatic token is scoped to
   the repository the workflow runs in. To enumerate your own private repos you
   need a **fine-grained PAT** with `Metadata: read` and `Contents: read`,
   stored as `secrets.PROFILE_TOKEN`. The workflow already prefers that secret
   and falls back to `GITHUB_TOKEN`.

2. **A link to a private repository 404s for every visitor.** So cards for
   private repos are rendered **unlinked** — the card still shows the name,
   description, language and stack, but there is no href to click. That is why
   the grid currently shows one clickable card and ten inert ones.

Your options:

- **Accept it.** Private repos advertise the stack without a link. Honest, and
  it still looks good.
- **Make a few repos public.** Then their cards become clickable with no code
  change.
- **Point cards at a case study instead.** Add `"homepage": "https://..."` to an
  override and the card links there rather than to the repository.

Security notes for whichever you pick: use a **fine-grained** token, never a
classic PAT with `repo` scope; grant only `Metadata: read` and `Contents: read`;
set an expiry and rotate it; and never `echo` it — GitHub masks secrets in logs,
but a token interpolated into a shell string can still leak.

---

## Determinism guarantees

The word "deterministic" gets used loosely. Here is precisely what this system
guarantees, and what it does not.

**Guaranteed:**

1. **Pure derivation.** `card = f(commit_sha, detector_version)`. Every card
   records the commit it was derived from and the detector version that
   produced it, so any past output can be reproduced exactly.
2. **Canonical serialisation.** All objects and arrays are sorted before hashing
   or writing, so key order can never cause a spurious diff.
3. **Bounded writes.** Writes outside the allowlist are refused by the script
   *and* re-checked by the workflow before commit. Both fail closed.
4. **Change-gated commits.** A run with no semantic change writes nothing.
5. **Hash-chained history.** Each run entry commits to its predecessor.
6. **Deterministic ordering.** Pins first, then recency, then name — never the
   order the API happened to return.

**Not guaranteed, and not claimable:**

- The collector is not deterministic in the "same input, byte-identical output"
  sense across *different* commits — by design, that is the point.
- Scheduled workflows can be delayed under load; `cron` is a target, not a
  contract.
- Nothing here makes the *model* deterministic. There is no model in this
  pipeline, which is precisely why the pipeline is deterministic.

---

## Cost

| | |
|---|---|
| GraphQL cost per run | **2 points** (measured), against a 5,000/hr budget |
| Requests per run | 1 (2 if you have >100 repos) |
| Runner minutes | ~20 s on `ubuntu-latest` |
| Monthly minutes at 2×/day | ~60 — well inside the 2,000 free minutes |
| Storage | ~4 KB per card SVG; JSONL grows only on real change |

One free-tier quirk worth knowing: **scheduled workflows are disabled after 60
days without repository activity.** Because this job commits whenever something
changes, it keeps its own clock alive — but if your repos go quiet for two
months the schedule stops. `workflow_dispatch` still works, and any push
restarts it.

---

## Files

```
build-cards.mjs                 collect, detect, render, write
preview.mjs                     standalone HTML preview of the generated cards
workflows/repo-cards.yml        the GitHub Actions workflow
scripts/repo-cards.config.json  human overrides
```
