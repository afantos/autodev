import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Config } from './config.ts';
import { secret } from './config.ts';
import type { Db } from './db.ts';
import { getJob, logEvent, openDb, recordUsage, tx } from './db.ts';
import type { Tracker } from './tracker/types.ts';
import { LinearTracker } from './tracker/linear.ts';
import { LocalTracker } from './tracker/local.ts';
import type { Scm } from './scm/types.ts';
import { GitHubScm } from './scm/github.ts';
import { LocalScm } from './scm/local.ts';
import { Workspaces } from './scm/git.ts';
import type { AgentRunner, AgentRunResult, AgentRunSpec } from './agents/runner.ts';
import { ClaudeRunner } from './agents/runner.ts';
import { reserveBudget, clearApiErrorStreak, clearUsageLimitStreak, pauseForApiError, pauseForUsageLimit } from './budget.ts';
import { runSandboxed } from './command-sandbox.ts';

export interface Ctx {
  cfg: Config;
  db: Db;
  tracker: Tracker;
  scm: Scm;
  ws: Workspaces;
  runner: AgentRunner;
  /** Lease owner identity for this process. */
  owner: string;
  runCommand: typeof runSandboxed;
}

export function createCtx(cfg: Config, overrides: Partial<Pick<Ctx, 'tracker' | 'scm' | 'runner' | 'db' | 'runCommand'>> = {}): Ctx {
  const db = overrides.db ?? openDb(join(cfg.dataDir, 'autodev.db'));
  const tracker = overrides.tracker ?? (cfg.tracker === 'linear' ? new LinearTracker(cfg, secret('LINEAR_API_KEY')!) : new LocalTracker(db));
  const scm = overrides.scm ?? (cfg.scm === 'github' ? new GitHubScm(secret('GITHUB_TOKEN')!) : new LocalScm(db, cfg.dataDir, cfg.localCi));
  const runner = overrides.runner ?? new ClaudeRunner();
  return { cfg, db, tracker, scm, runner, ws: new Workspaces(cfg.dataDir, cfg.workspaceDir, scm, db), runCommand: overrides.runCommand ?? runSandboxed, owner: `${hostname()}:${process.pid}:${Date.now().toString(36)}` };
}

/** Trees agents may never read: the orchestrator's home (credentials), config (.env) and state. */
export function protectedRoots(cfg: Config): string[] {
  return [...new Set([homedir(), cfg.configDir, cfg.dataDir].filter(Boolean).map(p => canonicalPath(p)))];
}

/** Symlink-resolved absolute path, also for paths that don't exist yet (resolves the nearest existing ancestor). */
export function canonicalPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail.reverse()); } catch { /* not there yet */ }
    const parent = dirname(head);
    if (parent === head) return resolve(p);
    tail.push(basename(head));
    head = parent;
  }
}

/**
 * A worktree under a denied tree cannot resolve its own cwd inside the sandbox (getcwd needs its
 * ancestors), so this layout is refused outright rather than half-working.
 */
export function assertOutsideProtected(cwd: string, roots: string[]) {
  const real = canonicalPath(cwd);
  for (const root of roots) {
    if (real === root || real.startsWith(root + sep)) {
      throw new Error(`agent workspace ${real} is inside protected directory ${root}; set workspaceDir outside HOME, the config directory and dataDir`);
    }
  }
}

export class RunGateClosed extends Error {
  why: string;
  constructor(why: string) { super(why); this.why = why; }
}

/**
 * The only way agents are run: checks the budget/usage gate, clamps the spend cap, records usage,
 * and turns usage-limit / outage errors into global pauses (never into credential or billing switches).
 */
export async function runAgent(ctx: Ctx, spec: Omit<AgentRunSpec, 'maxBudgetUsd'> & { maxBudgetUsd?: number }, meta: { jobId?: string | null; ticketId?: string | null }): Promise<AgentRunResult> {
  spec.signal?.throwIfAborted();
  const job = meta.jobId ? getJob(ctx.db, meta.jobId) : undefined;
  const repository = job?.repo ?? spec.repository;
  const protectedPaths = protectedRoots(ctx.cfg);
  assertOutsideProtected(spec.cwd, protectedPaths);
  const gitReadPaths: string[] = [];
  const guardedWorktree = spec.fileOnly ? job?.worktree : spec.cwd;
  if (repository) {
    if (!ctx.cfg.projects.some(p => p.repo === repository)) throw new Error('agent repository is not configured');
    // Agents may read their worktree's git metadata (git status/diff/log) but never write it: the
    // orchestrator makes all commits with hardened git after verifying these pointers.
    if (!guardedWorktree) throw new Error('file-only agent requires a managed job');
    const rec = ctx.ws.verifiedRecord(guardedWorktree);
    await ctx.ws.verifyAgentWorkspace(guardedWorktree);
    if (spec.fileOnly) await ctx.ws.assertSnapshot(spec.cwd, guardedWorktree, job!.candidate_sha!);
    else gitReadPaths.push(rec.commonDir, rec.gitDir);
  }
  const gate = reserveBudget(ctx.db, ctx.cfg, ctx.owner, meta, spec.maxBudgetUsd ?? ctx.cfg.budget.perRunUsd);
  if (!gate.ok) throw new RunGateClosed(gate.reason!);
  const maxBudgetUsd = Math.min(spec.maxBudgetUsd ?? ctx.cfg.budget.perRunUsd, gate.allowanceUsd);
  logEvent(ctx.db, `agent.${spec.role}.start`, `model=${spec.model} budget=$${maxBudgetUsd.toFixed(2)}${spec.resume ? ' (resume)' : ''}`, { jobId: meta.jobId, ticketId: meta.ticketId });
  // A thrown runner error or process crash leaves the reservation in place;
  // actual spend is unknown and must not be silently made available again.
  let res: AgentRunResult;
  try { res = await ctx.runner.run({ ...spec, maxBudgetUsd, protectedPaths, gitReadPaths }); }
  catch (e) { if (repository) await ctx.ws.verifyAgentWorkspace(guardedWorktree!); throw e; }
  tx(ctx.db, () => {
    recordUsage(ctx.db, {
      jobId: meta.jobId, ticketId: meta.ticketId, role: spec.role, model: spec.model, costUsd: res.costUsd,
      inputTokens: res.inputTokens, outputTokens: res.outputTokens, cacheReadTokens: res.cacheReadTokens, durationMs: res.durationMs,
      outcome: res.usageComplete === false ? 'usage_unknown' : res.ok ? 'ok' : res.errorKind,
    });
    if (res.usageComplete !== false) ctx.db.prepare('DELETE FROM budget_reservations WHERE id = ?').run(gate.reservationId!);
  });
  if (res.usageComplete === false) logEvent(ctx.db, 'budget.unsettled', `No terminal usage result; reservation ${gate.reservationId} remains held`, { jobId: meta.jobId, ticketId: meta.ticketId, level: 'warn' });
  logEvent(ctx.db, `agent.${spec.role}.end`, `${res.ok ? 'ok' : `error=${res.errorKind}: ${String(res.error).slice(0, 300)}`} cost=$${res.costUsd.toFixed(3)} turns=${res.numTurns} ${(res.durationMs / 1000).toFixed(0)}s`,
    { jobId: meta.jobId, ticketId: meta.ticketId, level: res.ok ? 'info' : 'warn' });
  if (res.errorKind === 'rate_limited') pauseForUsageLimit(ctx.db, res.resetsAt);
  else if (res.errorKind === 'api') pauseForApiError(ctx.db);
  else if (res.ok) { clearUsageLimitStreak(ctx.db); clearApiErrorStreak(ctx.db); }
  if (repository) {
    await ctx.ws.verifyAgentWorkspace(guardedWorktree!);
    if (spec.fileOnly) await ctx.ws.assertSnapshot(spec.cwd, guardedWorktree!, job!.candidate_sha!);
  }
  return res;
}
