#!/usr/bin/env node
/**
 * preview.mjs — render the generated cards into a standalone HTML page so the
 * result can be eyeballed before it lands on the profile README.
 *
 * Mirrors the GitHub dark shell used by the profile repo's own
 * preview/build-preview.mjs, and inlines every SVG so the file is portable.
 *
 *   node preview.mjs --root . --out preview/repo-cards-preview.html
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ROOT = resolve(arg('root', '.'));
const OUT = resolve(arg('out', join(ROOT, 'preview', 'repo-cards-preview.html')));

const statePath = join(ROOT, 'data', 'repos.json');
if (!existsSync(statePath)) {
  console.error(`error: ${statePath} not found — run build-cards.mjs first`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));

const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const cards = state.repos
  .map((repo) => {
    const svgPath = join(ROOT, 'assets', 'repos', `${slug(repo.name)}.svg`);
    const svg = existsSync(svgPath)
      ? readFileSync(svgPath, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '')
      : `<div class="missing">no svg for ${repo.name}</div>`;

    const body = repo.url
      ? `<a class="card" href="${repo.url}">${svg}</a>`
      : `<div class="card" title="private repository — no public link">${svg}</div>`;

    const badge = repo.private
      ? '<span class="tag private">private</span>'
      : '<span class="tag public">public</span>';

    return `<figure>${body}<figcaption>${badge}<code>${repo.commit ? repo.commit.slice(0, 7) : '—'}</code></figcaption></figure>`;
  })
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Repository cards preview</title>
<style>
  :root { --bg:#0d1117; --fg:#c3d6e8; --muted:#7a93ab; --border:#1d4f7d; --accent:#5AA8DD; }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .page{max-width:1012px;margin:0 auto;padding:32px 24px 64px}
  h1{font-size:20px;margin:0 0 4px;color:#e6edf3}
  .meta{color:var(--muted);font-size:13px;margin:0 0 24px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
  figure{margin:0}
  .card{display:block;border-radius:10px;transition:transform .12s ease,box-shadow .12s ease}
  .card:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(90,168,221,.18)}
  .card svg{display:block;width:100%;height:auto}
  figcaption{display:flex;justify-content:space-between;align-items:center;
    margin-top:6px;font-size:11px;color:var(--muted)}
  .tag{padding:1px 7px;border-radius:9px;border:1px solid var(--border);color:var(--accent)}
  .tag.private{border-color:#3d3d3d;color:#8b8b8b}
  .missing{padding:20px;border:1px dashed var(--border);border-radius:10px;color:var(--muted)}
  .foot{margin-top:28px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
  <div class="page">
    <h1>Repository cards — generated preview</h1>
    <p class="meta">login=${state.login} · detector=v${state.detectorVersion} · ${state.repoCount}/${state.totalRepos} cards · state changed ${state.stateChangedAt ?? '—'}</p>
    <div class="grid">
${cards}
    </div>
    <p class="foot">Private repositories are rendered unlinked, because the URL would 404 for anyone but you.</p>
  </div>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html, 'utf8');
console.log(`wrote ${OUT} (${state.repos.length} cards)`);
