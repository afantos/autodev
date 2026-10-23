import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.ts';
import { allJobs, jobsByStatus, kvGet, kvSet, logEvent, spentSince } from './db.ts';
import { startOfDay, startOfMonth } from './budget.ts';
import type { DecisionRow } from './decisions.ts';
import type { Job } from './types.ts';

export interface Snapshot {
  generatedAt: string;
  sinceIso: string;
  completed: Job[];
  readyForReview: Job[];
  blocked: Job[];
  failed: Job[];
  running: Job[];
  queued: Job[];
  autoDecisions: DecisionRow[];
  pendingDecisions: DecisionRow[];
  suggested: { message: string; ts: number }[];
  costs: { since: number; today: number; month: number; byRole: { role: string; model: string; cost: number; runs: number }[] };
  pauses: string[];
  urls: Map<string, string>;
}

export async function snapshot(ctx: Ctx, sinceMs: number): Promise<Snapshot> {
  const { db, cfg } = ctx;
  const jobs = allJobs(db, 1000);
  const ticketUrls = new Map<string, string>();
  const interesting = jobs.filter((j) => j.updated_at >= sinceMs || ['awaiting_merge', 'blocked', 'running', 'queued', 'waiting_ci'].includes(j.status));
  for (const j of interesting.slice(0, 60)) {
    const t = await ctx.tracker.getTicket(j.ticket_id).catch(() => null);
    if (t) ticketUrls.set(j.ticket_id, t.url);
  }
  const pauses: string[] = [];
  const mp = kvGet(db, 'manual_pause'); if (mp) pauses.push(`Paused: ${mp}`);
  const pu = Number(kvGet(db, 'paused_until') ?? 0); if (pu > Date.now()) pauses.push(`Usage-limit pause until ${new Date(pu).toLocaleString()}`);
  const gate = kvGet(db, 'last_gate_reason'); if (gate && !pauses.length) pauses.push(gate);
  return {
    generatedAt: new Date().toISOString(),
    sinceIso: new Date(sinceMs).toISOString(),
    completed: jobs.filter((j) => j.status === 'done' && j.updated_at >= sinceMs),
    readyForReview: jobsByStatus(db, 'awaiting_merge'),
    blocked: jobsByStatus(db, 'blocked'),
    failed: jobs.filter((j) => j.status === 'failed' && j.updated_at >= sinceMs),
    running: jobsByStatus(db, 'running', 'waiting_ci'),
    queued: jobsByStatus(db, 'queued'),
    autoDecisions: db.prepare(`SELECT * FROM decisions WHERE authority = 'auto' AND created_at >= ? ORDER BY created_at`).all(sinceMs) as unknown as DecisionRow[],
    pendingDecisions: db.prepare(`SELECT * FROM decisions WHERE status = 'pending_human' ORDER BY created_at`).all() as unknown as DecisionRow[],
    suggested: (db.prepare(`SELECT message, ts FROM events WHERE type = 'ticket.suggested' AND ts >= ?`).all(sinceMs) as { message: string; ts: number }[]),
    costs: {
      since: spentSince(db, sinceMs), today: spentSince(db, startOfDay()), month: spentSince(db, startOfMonth()),
      byRole: db.prepare(`SELECT role, COALESCE(model,'') model, SUM(cost_usd) cost, COUNT(*) runs FROM usage WHERE ts >= ? GROUP BY role, model ORDER BY cost DESC`).all(sinceMs) as { role: string; model: string; cost: number; runs: number }[],
    },
    pauses,
    urls: ticketUrls,
  };
  void cfg;
}

const link = (s: Snapshot, j: Job) => (s.urls.get(j.ticket_id) ? `[${j.ticket_identifier}](${s.urls.get(j.ticket_id)})` : j.ticket_identifier);
const title = (j: Job) => {
  const sum = JSON.parse(j.summary_json ?? '{}');
  return sum.coding?.summary ? ` — ${String(sum.coding.summary).split('\n')[0].slice(0, 120)}` : '';
};

export function renderReport(s: Snapshot, cfg: Ctx['cfg']): string {
  const preview = (j: Job) => JSON.parse(j.summary_json ?? '{}').preview as string | undefined;
  const blockedLine = (j: Job) => {
    const b = JSON.parse(j.blocked_reason ?? '{}');
    return `- ${link(s, j)}: **${b.reason ?? 'blocked'}**\n  - Q: ${b.question ?? ''}${b.recommendation ? `\n  - Recommended: ${b.recommendation}` : ''}`;
  };
  return `# autodev report — ${new Date(s.generatedAt).toLocaleString()}
_Since ${new Date(s.sinceIso).toLocaleString()}_
${s.pauses.length ? `\n> ⚠️ ${s.pauses.join(' · ')}\n` : ''}
## Needs your attention
${s.readyForReview.length ? `**Ready to review / merge (${s.readyForReview.length})**\n${s.readyForReview.map((j) => `- ${link(s, j)} → [PR #${j.pr_number}](${j.pr_url})${preview(j) ? ` · [preview](${preview(j)})` : ''}${title(j)}`).join('\n')}` : '- No PRs waiting.'}

${s.blocked.length ? `**Blocked — decisions needed (${s.blocked.length})**\n${s.blocked.map(blockedLine).join('\n')}` : '- Nothing blocked.'}

${s.pendingDecisions.length ? `**Pending decisions (${s.pendingDecisions.length})**\n${s.pendingDecisions.map((d) => `- ${d.ticket_identifier ?? ''} ${d.question}${d.decision ? ` (recommended: ${d.decision})` : ''}`).join('\n')}` : ''}

${s.failed.length ? `**Failed (${s.failed.length})**\n${s.failed.map((j) => `- ${link(s, j)}: ${String(j.error).split('\n')[0].slice(0, 200)}`).join('\n')}` : ''}

## Completed (merged & verified): ${s.completed.length}
${s.completed.map((j) => `- ${link(s, j)} [PR #${j.pr_number}](${j.pr_url})`).join('\n') || '- none'}

## Decisions made automatically: ${s.autoDecisions.length}
${s.autoDecisions.map((d) => `- ${d.ticket_identifier ?? ''}: ${d.question} → ${d.decision}`).join('\n') || '- none'}

## Suggested tickets (in Backlog, need approval): ${s.suggested.length}
${s.suggested.map((x) => `- ${x.message}`).join('\n') || '- none'}

## Currently working
${[...s.running, ...s.queued].map((j) => `- ${link(s, j)} — ${j.status}, after stage "${j.stage}"${j.pr_url ? ` ([PR](${j.pr_url}))` : ''}`).join('\n') || '- idle'}

## Usage (estimated)
- This period: $${s.costs.since.toFixed(2)} · today: $${s.costs.today.toFixed(2)} / $${cfg.budget.dailyUsd} · month: $${s.costs.month.toFixed(2)} / $${cfg.budget.monthlyUsd}
${s.costs.byRole.map((r) => `- ${r.role} (${r.model}): ${r.runs} runs, $${r.cost.toFixed(2)}`).join('\n')}
`.replace(/\n{3,}/g, '\n\n');
}

export async function buildReport(ctx: Ctx, sinceMs: number): Promise<string> {
  return renderReport(await snapshot(ctx, sinceMs), ctx.cfg);
}

/** Once per day at cfg.report.hour (local time): write the report and optionally POST it to a webhook. */
export async function maybeSendMorningReport(ctx: Ctx, force = false) {
  const { cfg, db } = ctx;
  if (cfg.report.hour < 0 && !force) return;
  const d = new Date();
  const today = d.toISOString().slice(0, 10);
  if (!force && (d.getHours() < cfg.report.hour || kvGet(db, 'last_report_day') === today)) return;
  const since = Number(kvGet(db, 'last_report_at') ?? Date.now() - 24 * 3600_000);
  const md = await buildReport(ctx, since);
  const dir = join(cfg.dataDir, 'reports');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${today}.md`);
  writeFileSync(path, md);
  kvSet(db, 'last_report_day', today);
  kvSet(db, 'last_report_at', String(Date.now()));
  const hook = process.env.AUTODEV_REPORT_WEBHOOK;
  if (hook) {
    const isNtfy = /ntfy/.test(hook);
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': isNtfy ? 'text/markdown' : 'application/json', ...(isNtfy ? { Title: 'autodev morning report', Markdown: 'yes' } : {}) },
      body: isNtfy ? md : JSON.stringify({ text: md }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  logEvent(db, 'report.sent', `morning report written to ${path}${hook ? ' and posted to webhook' : ''}`);
  return path;
}
