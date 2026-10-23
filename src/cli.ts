import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createCtx } from './context.ts';
import type { Ctx } from './context.ts';
import { allJobs, jobsByStatus, kvSet, logEvent } from './db.ts';
import { FakeRunner } from './agents/fake.ts';
import { Orchestrator } from './orchestrator.ts';
import { approvePlan, draftPlan, getPlan, publishPlan } from './planning.ts';
import { buildReport, maybeSendMorningReport } from './report.ts';
import { startDashboard } from './dashboard.ts';
import { LinearTracker } from './tracker/linear.ts';
import { LocalTracker } from './tracker/local.ts';
import { LocalScm } from './scm/local.ts';
import { answerBlocked } from './pipeline.ts';
import { spentSince } from './db.ts';
import { startOfDay, startOfMonth } from './budget.ts';
import type { Priority, Status } from './types.ts';

const HELP = `autodev — autonomous Linear → GitHub development orchestrator

Usage: autodev [--config autodev.config.yaml] <command> [args]

Orchestrator
  run                         Run continuously (systemd runs this)
  tick                        Run one scheduling tick and wait for started jobs to finish
  status                      Jobs, pauses and spend
  pause [reason] | resume     Stop/allow starting new agent runs (running work continues)

Planning
  plan "<idea>" [--project k] [--publish]   Research the repo and draft a plan (optionally create Backlog tickets)
  plan-publish <planId>       Create the drafted plan's tickets in Linear (Backlog)
  plan-approve <planId>       Approve: move the plan's tickets to Ready (human action)
  plans                       List plans

Humans in the loop
  answer <TICKET-ID> "<text>" Answer a blocked ticket's question and resume it
  decisions [--pending]       Decision log

Reporting
  report [--hours 24] [--send]  Print (or write+post) the activity report
  usage                       Spend by role/model (benchmark model routing)

Setup
  linear-check                Verify Linear workflow states exist
  linear-setup --apply        Create missing workflow states (changes your Linear workspace)
  ticket-add --project k --title T [--desc D] [--status ready] [--priority 2] [--estimate 2] [--blocked-by ID]
                              (local tracker only) create a simulated ticket
  sim-merge <prNumber>        (local SCM only) simulate a human merging a PR
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' }, project: { type: 'string' }, publish: { type: 'boolean' }, hours: { type: 'string' },
      send: { type: 'boolean' }, pending: { type: 'boolean' }, apply: { type: 'boolean' }, title: { type: 'string' }, desc: { type: 'string' },
      status: { type: 'string' }, priority: { type: 'string' }, estimate: { type: 'string' }, 'blocked-by': { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) { console.log(HELP); return; }
  const cfgPath = resolve(values.config ?? process.env.AUTODEV_CONFIG ?? 'autodev.config.yaml');
  if (!existsSync(cfgPath)) throw new Error(`config not found: ${cfgPath} (copy config/autodev.example.yaml)`);
  const envFile = resolve(dirname(cfgPath), '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const cfg: Config = loadConfig(cfgPath);
  const ctx = createCtx(cfg, cfg.runner === 'fake' ? { runner: new FakeRunner() } : {});

  switch (cmd) {
    case 'run': {
      const orch = new Orchestrator(ctx);
      const dash = startDashboard(ctx);
      if (dash) console.log(`dashboard on http://${cfg.dashboard.host}:${cfg.dashboard.port}/?token=…`);
      const stop = () => { console.log('stopping: no new work; waiting up to 60s for running stages (leases make the rest resumable)'); orch.stop(); };
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      await orch.run();
      dash?.close();
      return;
    }
    case 'tick': {
      const orch = new Orchestrator(ctx);
      await orch.run({ once: true });
      return printStatus(ctx);
    }
    case 'status': return printStatus(ctx);
    case 'pause': kvSet(ctx.db, 'manual_pause', rest.join(' ') || 'paused by user'); logEvent(ctx.db, 'pause', rest.join(' ') || 'manual'); return console.log('paused');
    case 'resume': kvSet(ctx.db, 'manual_pause', null); kvSet(ctx.db, 'paused_until', null); logEvent(ctx.db, 'resume', 'manual resume'); return console.log('resumed');

    case 'plan': {
      const idea = rest.join(' ');
      if (!idea) throw new Error('usage: autodev plan "<idea>"');
      const p = await draftPlan(ctx, idea, values.project);
      console.log(p.markdown);
      console.log(`\nDraft saved: ${p.path}\nPlan id: ${p.id.slice(0, 8)}`);
      if (values.publish) {
        const r = await publishPlan(ctx, p.id);
        console.log(`Published: ${r.parent.url} (${r.created.length} tickets in Backlog${r.skipped.length ? `, skipped duplicates: ${r.skipped.join('; ')}` : ''})`);
      } else console.log(`Next: autodev plan-publish ${p.id.slice(0, 8)}`);
      return;
    }
    case 'plan-publish': {
      const r = await publishPlan(ctx, need(rest[0], 'planId'));
      return console.log(`Published: ${r.parent.url}\nCreated: ${r.created.map((t) => t.identifier).join(', ')}${r.skipped.length ? `\nSkipped duplicates: ${r.skipped.join('; ')}` : ''}`);
    }
    case 'plan-approve': {
      const moved = await approvePlan(ctx, need(rest[0], 'planId'), `${process.env.USER ?? 'human'} via CLI`);
      return console.log(`Approved. Ready: ${moved.join(', ') || '(none — were tickets already moved?)'}`);
    }
    case 'plans': {
      const rows = ctx.db.prepare('SELECT * FROM plans ORDER BY created_at DESC LIMIT 30').all() as { id: string; project: string; status: string; idea: string }[];
      for (const r of rows) console.log(`${r.id.slice(0, 8)}  ${r.status.padEnd(9)} ${r.project.padEnd(12)} ${r.idea.split('\n')[0].slice(0, 80)}`);
      if (rest[0]) console.log(getPlan(ctx, rest[0])?.plan_json);
      return;
    }

    case 'answer': {
      const ident = need(rest[0], 'TICKET-ID');
      const job = jobsByStatus(ctx.db, 'blocked').find((j) => j.ticket_identifier.toLowerCase() === ident.toLowerCase());
      if (!job) throw new Error(`no blocked job for ${ident}`);
      await answerBlocked(ctx, job, need(rest.slice(1).join(' '), 'answer'));
      return console.log(`${ident} answered and re-queued.`);
    }
    case 'decisions': {
      const rows = ctx.db.prepare(`SELECT * FROM decisions ${values.pending ? "WHERE status = 'pending_human'" : ''} ORDER BY created_at DESC LIMIT 50`).all() as { id: string; ticket_identifier: string; status: string; authority: string; question: string; decision: string }[];
      for (const r of rows) console.log(`${r.id.slice(0, 8)} ${String(r.ticket_identifier ?? '').padEnd(9)} ${r.status.padEnd(13)} ${r.authority.padEnd(7)} ${r.question.slice(0, 70)}\n         → ${String(r.decision ?? '').slice(0, 110)}`);
      return;
    }

    case 'report': {
      if (values.send) return console.log(`written: ${await maybeSendMorningReport(ctx, true)}`);
      return console.log(await buildReport(ctx, Date.now() - Number(values.hours ?? 24) * 3600_000));
    }
    case 'usage': {
      const reservations = ctx.db.prepare('SELECT id, owner, amount_usd, created_at FROM budget_reservations ORDER BY created_at').all() as { id: string; owner: string; amount_usd: number; created_at: number }[];
      for (const r of reservations) console.log(`reserved ${r.id} $${r.amount_usd.toFixed(2)} owner=${r.owner} since=${new Date(r.created_at).toISOString()} (active or unsettled; never expires automatically)`);
      const rows = ctx.db.prepare(`SELECT role, model, COUNT(*) runs, SUM(cost_usd) cost, AVG(cost_usd) avg, SUM(CASE WHEN outcome='ok' THEN 1 ELSE 0 END) ok, AVG(duration_ms)/1000 secs FROM usage WHERE ts >= ? GROUP BY role, model ORDER BY cost DESC`).all(startOfMonth()) as { role: string; model: string; runs: number; cost: number; avg: number; ok: number; secs: number }[];
      console.log(`today $${spentSince(ctx.db, startOfDay()).toFixed(2)} / $${cfg.budget.dailyUsd}   month $${spentSince(ctx.db, startOfMonth()).toFixed(2)} / $${cfg.budget.monthlyUsd}`);
      for (const r of rows) console.log(`${r.role.padEnd(9)} ${String(r.model).padEnd(8)} runs=${r.runs} ok=${r.ok} cost=$${r.cost.toFixed(2)} avg=$${r.avg.toFixed(3)} avg=${r.secs.toFixed(0)}s`);
      const done = ctx.db.prepare(`SELECT AVG(cost_usd) c, COUNT(*) n FROM jobs WHERE status IN ('done','awaiting_merge')`).get() as { c: number; n: number };
      return console.log(`avg cost per delivered ticket: $${(done.c ?? 0).toFixed(2)} over ${done.n}`);
    }

    case 'linear-check':
    case 'linear-setup': {
      if (!(ctx.tracker instanceof LinearTracker)) throw new Error('tracker is not linear');
      const res = await ctx.tracker.checkSetup();
      for (const r of res) console.log(`${r.team}: ${r.missing.length ? `missing states: ${r.missing.join(', ')}` : 'all workflow states present'}`);
      if (cmd === 'linear-setup') {
        if (!values.apply) return console.log('Dry run. Re-run with --apply to create the missing states.');
        console.log(`created: ${(await ctx.tracker.createMissingStates()).join(', ') || 'nothing'}`);
      }
      return;
    }
    case 'ticket-add': {
      if (!(ctx.tracker instanceof LocalTracker)) throw new Error('ticket-add is for the local tracker; use Linear directly');
      const t = await ctx.tracker.createTicket({
        projectKey: need(values.project, '--project'), title: need(values.title, '--title'), description: values.desc ?? '',
        status: (values.status ?? 'backlog') as Status, priority: Number(values.priority ?? 3) as Priority, estimate: values.estimate ? Number(values.estimate) : null,
      });
      for (const b of values['blocked-by'] ?? []) await ctx.tracker.addBlockedBy(t.id, b);
      return console.log(`${t.identifier} (${t.status})`);
    }
    case 'sim-merge': {
      if (!(ctx.scm instanceof LocalScm)) throw new Error('sim-merge is for the local SCM backend; merge real PRs on GitHub');
      const n = Number(need(rest[0], 'PR number'));
      const pr = await ctx.scm.getPr('', n);
      const project = cfg.projects.find((p) => ctx.db.prepare('SELECT 1 FROM local_prs WHERE number = ? AND repo = ?').get(n, p.repo));
      await ctx.scm.merge(project!.repo, n);
      return console.log(`merged PR #${n} (${pr.headBranch} → ${pr.baseBranch})`);
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === '') throw new Error(`missing ${name}`);
  return v;
}

function printStatus(ctx: Ctx) {
  const jobs = allJobs(ctx.db, 50);
  const pause = ctx.db.prepare("SELECT k, v FROM kv WHERE k IN ('manual_pause','paused_until','last_gate_reason')").all() as { k: string; v: string }[];
  for (const p of pause) console.log(`! ${p.k}: ${p.k === 'paused_until' ? new Date(Number(p.v)).toISOString() : p.v}`);
  console.log(`today $${spentSince(ctx.db, startOfDay()).toFixed(2)} · month $${spentSince(ctx.db, startOfMonth()).toFixed(2)}`);
  for (const j of jobs) console.log(`${j.ticket_identifier.padEnd(10)} ${j.status.padEnd(15)} stage=${j.stage.padEnd(9)} pr=${j.pr_url ?? '-'} $${j.cost_usd.toFixed(2)}${j.error && j.status !== 'done' ? `  err=${j.error.split('\n')[0].slice(0, 80)}` : ''}`);
  if (!jobs.length) console.log('no jobs yet');
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
