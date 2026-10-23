import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx } from './context.ts';
import { snapshot } from './report.ts';
import type { Job } from './types.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Read-only operational page (Linear stays the Kanban board). Binds to 127.0.0.1 by default;
 * expose it over Tailscale/SSH tunnel. Requires AUTODEV_DASHBOARD_TOKEN (?token= or Bearer).
 */
export function startDashboard(ctx: Ctx): Server | null {
  const token = process.env.AUTODEV_DASHBOARD_TOKEN;
  if (!ctx.cfg.dashboard.enabled) return null;
  if (!token) { console.warn('dashboard disabled: set AUTODEV_DASHBOARD_TOKEN'); return null; }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const given = url.searchParams.get('token') ?? (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const a = Buffer.from(given); const b = Buffer.from(token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) { res.writeHead(401).end('unauthorized'); return; }
      if (url.pathname === '/api/status') {
        const s = await snapshot(ctx, Date.now() - 24 * 3600_000);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...s, urls: Object.fromEntries(s.urls) }));
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
          .end(await page(ctx, url.searchParams.get('job')));
        return;
      }
      res.writeHead(404).end('not found');
    } catch (e) {
      res.writeHead(500).end(esc(e));
    }
  });
  server.listen(ctx.cfg.dashboard.port, ctx.cfg.dashboard.host);
  return server;
}

async function page(ctx: Ctx, jobId: string | null): Promise<string> {
  const s = await snapshot(ctx, Date.now() - 24 * 3600_000);
  const tl = (j: Job) => (s.urls.get(j.ticket_id) ? `<a href="${esc(s.urls.get(j.ticket_id))}">${esc(j.ticket_identifier)}</a>` : esc(j.ticket_identifier));
  const pr = (j: Job) => (j.pr_url ? ` · <a href="${esc(j.pr_url)}">PR #${j.pr_number}</a>` : '');
  const card = (j: Job, extra = '') => `<li>${tl(j)}${pr(j)} <span class="m">${esc(j.status)} · ${esc(j.stage)} · $${j.cost_usd.toFixed(2)}</span> <a class="m" href="?job=${esc(j.id)}&token=${esc(process.env.AUTODEV_DASHBOARD_TOKEN)}">log</a>${extra}</li>`;
  const blocked = s.blocked.map((j) => { const b = JSON.parse(j.blocked_reason ?? '{}'); return card(j, `<div class="q"><b>${esc(b.reason)}</b><br>${esc(b.question)}${b.recommendation ? `<br><i>Recommended: ${esc(b.recommendation)}</i>` : ''}</div>`); }).join('');
  const review = s.readyForReview.map((j) => { const p = JSON.parse(j.summary_json ?? '{}').preview; return card(j, p ? ` · <a href="${esc(p)}">preview</a>` : ''); }).join('');
  let log = '';
  if (jobId) {
    const ev = ctx.db.prepare('SELECT ts, level, type, message FROM events WHERE job_id = ? ORDER BY ts DESC LIMIT 200').all(jobId) as { ts: number; level: string; type: string; message: string }[];
    log = `<h2>Job log</h2><pre>${ev.map((e) => `${new Date(e.ts).toLocaleString()} ${e.level} ${e.type}: ${esc(e.message)}`).join('\n')}</pre>`;
  }
  const recent = ctx.db.prepare('SELECT ts, level, type, message FROM events ORDER BY ts DESC LIMIT 40').all() as { ts: number; level: string; type: string; message: string }[];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>autodev</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--mut:#6e6e73;--card:#f5f5f7;--warn:#b42318;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f5f5f7;--mut:#a1a1a6;--card:#1c1c1e;--warn:#ff6b5e;--ok:#4cd681}}
body{background:var(--bg);color:var(--fg);font:15px/1.45 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:860px;padding:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 6px}ul{list-style:none;padding:0;margin:0}
li{background:var(--card);border-radius:10px;padding:10px 12px;margin:6px 0;overflow-wrap:anywhere}
a{color:inherit}.m{color:var(--mut);font-size:13px}.q{margin-top:6px;font-size:14px}.warn{color:var(--warn)}
pre{white-space:pre-wrap;font-size:12px;background:var(--card);padding:10px;border-radius:10px;overflow-x:auto}
.stats{display:flex;gap:8px;flex-wrap:wrap}.stats div{background:var(--card);border-radius:10px;padding:8px 12px}
</style></head><body>
<h1>autodev</h1><div class="m">updated ${esc(new Date().toLocaleString())}</div>
${s.pauses.map((p) => `<p class="warn">⚠️ ${esc(p)}</p>`).join('')}
<div class="stats"><div>Today $${s.costs.today.toFixed(2)} / $${ctx.cfg.budget.dailyUsd}</div><div>Month $${s.costs.month.toFixed(2)} / $${ctx.cfg.budget.monthlyUsd}</div><div>${s.running.length} running · ${s.queued.length} queued</div></div>
<h2>Needs my attention</h2>
<h2 class="m">Ready to review (${s.readyForReview.length})</h2><ul>${review || '<li class="m">none</li>'}</ul>
<h2 class="m">Blocked (${s.blocked.length})</h2><ul>${blocked || '<li class="m">none</li>'}</ul>
<h2 class="m">Failed in last 24h (${s.failed.length})</h2><ul>${s.failed.map((j) => card(j, `<div class="q">${esc(String(j.error).slice(0, 300))}</div>`)).join('') || '<li class="m">none</li>'}</ul>
<h2>Running</h2><ul>${[...s.running, ...s.queued].map((j) => card(j)).join('') || '<li class="m">idle</li>'}</ul>
<h2>Done in last 24h (${s.completed.length})</h2><ul>${s.completed.map((j) => card(j)).join('') || '<li class="m">none</li>'}</ul>
<h2>Projects</h2><ul>${ctx.cfg.projects.map((p) => `<li>${esc(p.key)} <span class="m">${esc(p.repo)} · max ${p.maxConcurrent}</span></li>`).join('')}</ul>
${log}
<h2>Recent events</h2><pre>${recent.map((e) => `${new Date(e.ts).toLocaleTimeString()} ${e.level === 'info' ? '' : e.level.toUpperCase() + ' '}${e.type}: ${esc(e.message)}`).join('\n')}</pre>
</body></html>`;
}
