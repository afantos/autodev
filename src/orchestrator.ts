import { hostname } from 'node:os';
import type { Ctx } from './context.ts';
import { canStartRun } from './budget.ts';
import { acquireInstanceLock, releaseInstanceLock, acquireLease, activeJobForTicket, claimTicket, expiredLeases, jobsByStatus, kvGet, kvSet, logEvent, now, releaseLease, updateJob } from './db.ts';
import { blockJob, markBaseRefreshed, resumeBlocked, runJob } from './pipeline.ts';
import { conflictFeedback } from './automerge.ts';
import { approvePlan } from './planning.ts';
import { autoMergeStep } from './automerge.ts';
import { resumeIfFixesMerged } from './triage.ts';
import { rank } from './scheduler.ts';
import { LABEL_PLAN } from './tracker/types.ts';
import type { Job, Ticket } from './types.ts';
import { ACTIVE_JOB_STATUSES } from './types.ts';
import { sleep } from './exec.ts';
import { maybeSendMorningReport } from './report.ts';

export class Orchestrator {
  ctx: Ctx;
  workers = new Map<string, Promise<void>>();
  stopping = false;
  private lastCiPoll = new Map<string, number>();
  /** Dependency tickets outside the listed statuses (Done/Canceled), fetched one by one: cached so each tick is not N requests. */
  private dependencyCache = new Map<string, { ticket: Ticket | null; at: number }>();
  private wake: (() => void) | null = null;

  constructor(ctx: Ctx) { this.ctx = ctx; }

  /** Main loop. Returns when stop() is called and workers have drained (or the drain timeout passes). */
  async run(opts: { once?: boolean } = {}): Promise<void> {
    const { db, cfg, owner } = this.ctx;
    if (!acquireInstanceLock(db, owner, cfg.loop.leaseSeconds * 1000, ownerDead)) {
      throw new Error('another autodev instance holds the lock on this state file');
    }
    logEvent(db, 'orchestrator.start', `owner=${owner} concurrency=${cfg.concurrency.global} tracker=${cfg.tracker} scm=${cfg.scm} runner=${cfg.runner}`);
    this.recoverDeadOwners();
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        logEvent(db, 'tick.error', String((e as Error)?.stack ?? e).slice(0, 2000), { level: 'error' });
      }
      if (opts.once) break;
      await new Promise<void>((r) => { this.wake = r; setTimeout(r, cfg.loop.tickSeconds * 1000); });
    }
    await this.drain(opts.once ? Infinity : 60_000);
    if (!this.workers.size) releaseInstanceLock(db, owner);
    logEvent(db, 'orchestrator.stop', `workers remaining: ${this.workers.size}`);
  }

  stop() { this.stopping = true; this.wake?.(); }

  async drain(timeoutMs: number) {
    const all = Promise.allSettled([...this.workers.values()]);
    await (timeoutMs === Infinity ? all : Promise.race([all, sleep(timeoutMs)]));
  }

  async tick() {
    const { db, cfg, owner } = this.ctx;
    if (!acquireInstanceLock(db, owner, cfg.loop.leaseSeconds * 1000, ownerDead)) throw new Error('lost instance lock');
    this.recoverExpiredLeases();
    const tickets = await this.reconcile();
    await this.pollCi();
    if (!this.stopping) await this.schedule(tickets);
    await maybeSendMorningReport(this.ctx).catch((e) => logEvent(db, 'report.error', String(e), { level: 'warn' }));
  }

  /** Jobs left "running" by a previous process on this host that is no longer alive are recovered immediately. */
  recoverDeadOwners() {
    const me = hostname();
    for (const j of jobsByStatus(this.ctx.db, 'running')) {
      const [host, pid] = (j.lease_owner ?? '').split(':');
      if (j.lease_owner === this.ctx.owner) continue;
      if (host === me && pid && !pidAlive(Number(pid))) this.requeue(j, `previous orchestrator process ${pid} is gone`);
    }
  }

  recoverExpiredLeases() {
    for (const j of expiredLeases(this.ctx.db)) {
      if (this.workers.has(j.id)) continue;
      this.requeue(j, `lease expired (owner ${j.lease_owner})`);
    }
  }

  private requeue(j: Job, why: string) {
    updateJob(this.ctx.db, j.id, { status: 'queued', lease_owner: null, lease_expires_at: null });
    logEvent(this.ctx.db, 'lease.recovered', `${j.ticket_identifier}: ${why}; resuming after stage "${j.stage}" (worktree preserved)`, { jobId: j.id, ticketId: j.ticket_id, level: 'warn' });
  }

  /**
   * Bring job state in line with Linear and GitHub (the sources of truth): merges, human cancellations,
   * blocker answers, plan approvals. Returns the ticket snapshot used for scheduling.
   */
  async reconcile(): Promise<Map<string, Ticket>> {
    const { ctx } = this;
    const { cfg, db, tracker, scm } = ctx;
    const statuses = ['ready', 'in_progress', 'review', 'blocked', 'failed'] as const;
    let listed = await tracker.listTickets({ statuses: [...statuses] });
    let approvedAny = false;
    // Plan approvals first: a human moved a [Plan] umbrella issue to Ready.
    for (const t of listed.filter((x) => x.status === 'ready' && x.labels.includes(LABEL_PLAN))) {
      const plan = db.prepare('SELECT id FROM plans WHERE parent_ticket_id = ?').get(t.id) as { id: string } | undefined;
      if (plan) await approvePlan(ctx, plan.id, 'human (plan issue moved to Ready in Linear)');
      else await tracker.setStatus(t.id, 'in_progress');
      approvedAny = true;
    }
    if (approvedAny) listed = await tracker.listTickets({ statuses: [...statuses] });
    const byId = new Map(listed.map((t) => [t.id, t]));
    const fetchMissing = async (id: string) => {
      if (byId.has(id)) return byId.get(id)!;
      // A dependency outside the listed statuses is almost always Done or Canceled, which does not change from tick to
      // tick: reuse it for dependencyCacheSeconds instead of one Linear request per link per tick (2,500/h budget).
      const cached = this.dependencyCache.get(id);
      const ttl = cfg.loop.dependencyCacheSeconds * 1000;
      if (cached && now() - cached.at < ttl) { if (cached.ticket) byId.set(id, cached.ticket); return cached.ticket; }
      const t = await tracker.getTicket(id).catch(() => null);
      // Only successful lookups are cached: a failure (e.g. HTTP 429) is retried next tick, not remembered as "missing".
      if (t) this.dependencyCache.set(id, { ticket: t, at: now() });
      if (t) byId.set(id, t);
      return t;
    };
    for (const t of listed) for (const id of [...t.blockedBy, ...t.blocks]) await fetchMissing(id);

    for (const job of jobsByStatus(db, 'awaiting_merge', 'blocked', 'queued', 'waiting_ci')) {
      try {
        await this.reconcileJob(job, byId, fetchMissing);
      } catch (e) {
        // One job's failure must never stop reconciliation of the others (or the scheduler after it).
        const msg = String((e as Error)?.message ?? e).slice(0, 400);
        const key = `reconcile-error:${job.id}`;
        if (kvGet(db, key) !== msg) { kvSet(db, key, msg); logEvent(db, 'reconcile.job_error', `${job.ticket_identifier}: ${msg}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' }); }
      }
    }
    return byId;
  }

  /** Reconcile one job with its ticket and PR. Errors are contained by the caller. */
  private async reconcileJob(job: Job, byId: Map<string, Ticket>, fetchMissing: (id: string) => Promise<Ticket | null>) {
    const { ctx } = this;
    const { db, scm, tracker } = ctx;
    const t = await fetchMissing(job.ticket_id);
    if (!t) return;
    if (job.status !== 'awaiting_merge' && ['canceled', 'backlog', 'ideas'].includes(t.status)) {
      updateJob(db, job.id, { status: 'canceled', error: `ticket moved to ${t.status} by a human` });
      logEvent(db, 'job.canceled', `${job.ticket_identifier}: ticket moved to ${t.status}; branch preserved`, { jobId: job.id, ticketId: t.id });
      return;
    }
    if (job.status === 'blocked' && t.status === 'blocked' && await resumeIfFixesMerged(ctx, job, fetchMissing)) return;
    if (job.status === 'blocked' && t.status === 'ready') { await resumeBlocked(ctx, job); return; }
    if (job.status === 'awaiting_merge' && job.pr_number) {
      const pr = await scm.getPr(job.repo, job.pr_number).catch(() => null);
      if (!pr) return;
      if (pr.state === 'merged') {
        // Done only after GitHub confirms the merge.
        await tracker.setStatus(t.id, 'done');
        updateJob(db, job.id, { status: 'done' });
        await tracker.comment(t.id, `🎉 PR #${pr.number} merged — marked Done by autodev.`).catch(() => {});
        logEvent(db, 'job.done', `${job.ticket_identifier} merged (#${pr.number})`, { jobId: job.id, ticketId: t.id });
        byId.set(t.id, { ...t, status: 'done' });
        if (job.worktree) await ctx.ws.removeWorktreeIfClean(job.repo, job.worktree).catch(() => {});
      } else if (pr.state === 'closed') {
        updateJob(db, job.id, { status: 'closed', error: 'PR closed without merge' });
        await tracker.comment(t.id, `PR #${pr.number} was closed without merging. Branch \`${job.branch}\` is preserved. Move to Ready with a comment to rework.`).catch(() => {});
        logEvent(db, 'job.closed', `${job.ticket_identifier}: PR closed unmerged`, { jobId: job.id, ticketId: t.id, level: 'warn' });
      } else if (t.status === 'review') {
        // Auto-merge only from Review: a ticket a human moved (Canceled, Backlog, Done...) is never merged.
        const project = ctx.cfg.projects.find((p) => p.key === job.project);
        if (project?.autoMerge) {
          const outcome = await autoMergeStep(ctx, job, t, project).catch((e) => {
            logEvent(db, 'automerge.error', `${job.ticket_identifier}: ${(e as Error).message.slice(0, 300)}`, { jobId: job.id, ticketId: t.id, level: 'warn' });
            return 'waiting' as const;
          });
          if (outcome === 'requeued') byId.set(t.id, { ...t, status: 'in_progress' });
        }
      } else if (t.status === 'ready') {
        // Human sent it back from Review with feedback → rework on the same branch/PR.
        const comments = await tracker.listComments(t.id);
        const human = comments.filter((c) => !c.byAutomation).pop();
        updateJob(db, job.id, { status: 'queued', stage: 'workspace', fix_attempts: 0, review_cycles: 0, pending_feedback: `Human reviewer requested rework:\n${human?.body ?? '(no comment given — re-check the acceptance criteria and PR review comments)'}` });
        await tracker.setStatus(t.id, 'in_progress');
        logEvent(db, 'job.rework', `${job.ticket_identifier}: human requested rework`, { jobId: job.id, ticketId: t.id });
      }
    }
  }

  async pollCi() {
    const { ctx } = this;
    const { cfg, db, scm } = ctx;
    for (const job of jobsByStatus(db, 'waiting_ci')) {
      if (now() - (this.lastCiPoll.get(job.id) ?? 0) < cfg.loop.ciPollSeconds * 1000) continue;
      this.lastCiPoll.set(job.id, now());
      const project = cfg.projects.find((p) => p.key === job.project)!;
      try {
        const pr = await scm.getPr(job.repo, job.pr_number!);
        const checks = await scm.checks(job.repo, pr, project.requiredChecks);
        if (checks.state !== 'pending') {
          db.prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'waiting_ci'`).run(now(), job.id);
          logEvent(db, 'ci.done', `${job.ticket_identifier}: CI ${checks.state}`, { jobId: job.id, ticketId: job.ticket_id });
        } else if (pr.mergeable === 'conflicting' && job.worktree && job.base_branch) {
          // GitHub runs no pull_request workflow on a PR that conflicts with its base, so CI would never report. Merge the
          // base now and send the job back through coding (as auto-merge does) instead of waiting ciTimeoutMinutes for a human.
          if (acquireLease(db, job.id, ctx.owner, cfg.loop.leaseSeconds * 1000, ['waiting_ci'])) await this.refreshConflictingPr({ ...job, lease_owner: ctx.owner });
        } else if (now() - (job.heartbeat_at ?? job.updated_at) > cfg.limits.ciTimeoutMinutes * 60_000) {
          if (acquireLease(db, job.id, ctx.owner, cfg.loop.leaseSeconds * 1000, ['waiting_ci'])) {
            await blockJob(ctx, { ...job, lease_owner: ctx.owner }, { reason: `CI did not finish within ${cfg.limits.ciTimeoutMinutes} minutes`, question: 'CI appears stuck. Check the workflow runs, then move this ticket back to Ready.', options: [], recommendation: null, decisionId: null });
          }
        }
      } catch (e) {
        logEvent(db, 'ci.poll.error', String(e).slice(0, 500), { jobId: job.id, level: 'warn' });
      }
    }
  }

  /** A waiting_ci job whose PR conflicts with its base (lease held): merge the base and revalidate, or resolve through coding. */
  private async refreshConflictingPr(job: Job) {
    const { ctx } = this;
    const { cfg, db, ws, tracker } = ctx;
    const base = job.base_branch!;
    const requeue = async (patch: Partial<Job>, event: string, note: string) => {
      updateJob(db, job.id, { status: 'queued', lease_owner: null, lease_expires_at: null, validated_sha: null, reviewed_sha: null, candidate_worktree: null, ...patch });
      await tracker.setStatus(job.ticket_id, 'in_progress').catch(() => {});
      await tracker.comment(job.ticket_id, note).catch(() => {});
      logEvent(db, event, `${job.ticket_identifier}: ${note.split('\n')[0]}`, { jobId: job.id, ticketId: job.ticket_id });
    };
    if (job.fix_attempts >= cfg.limits.maxFixAttempts) {
      return blockJob(ctx, job, {
        reason: `PR #${job.pr_number} conflicts with ${base}, so CI cannot run, and the fix-attempt limit (${cfg.limits.maxFixAttempts}) is used up`,
        question: `Resolve the conflict with ${base} on the PR branch (or raise the limit), then move the ticket back to Ready.`,
        options: [], recommendation: null, decisionId: null,
      });
    }
    try {
      const r = await ws.refreshBase(job.worktree!, base);
      if (r.status === 'current') {
        // GitHub reports a conflict but the base has not moved past what the branch contains: nothing to merge; keep waiting.
        releaseLease(db, job.id, ctx.owner, 'waiting_ci', {});
        return;
      }
      markBaseRefreshed(ctx, job, r.baseSha);
      if (r.status === 'merged') {
        return requeue({ stage: 'implement', candidate_sha: r.headSha, base_sha: r.baseSha },
          'ci.refresh', `🔄 PR #${job.pr_number} conflicted with ${base}, so GitHub ran no CI. autodev merged the latest ${base} into the branch cleanly and is revalidating (checks, CI, review).`);
      }
      return requeue({ stage: 'workspace', base_sha: r.baseSha, fix_attempts: job.fix_attempts + 1, pending_feedback: conflictFeedback(base, r.files) },
        'ci.conflict', `🔀 PR #${job.pr_number} conflicts with ${base} in ${r.files.map((f) => `\`${f}\``).join(', ')}, so GitHub runs no CI. The coding agent will resolve it, then everything is revalidated.`);
    } catch (e) {
      releaseLease(db, job.id, ctx.owner, 'waiting_ci', {});
      logEvent(db, 'ci.refresh.error', `${job.ticket_identifier}: ${String((e as Error)?.message ?? e).slice(0, 400)}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
    }
  }

  async schedule(byId: Map<string, Ticket>) {
    const { ctx } = this;
    const { cfg, db, owner } = ctx;
    const leaseMs = cfg.loop.leaseSeconds * 1000;
    const gate = canStartRun(db, cfg);
    if (!gate.ok) {
      if (kvGet(db, 'last_gate_reason') !== gate.reason) { kvSet(db, 'last_gate_reason', gate.reason!); logEvent(db, 'scheduler.paused', gate.reason!, { level: 'warn' }); }
      return;
    }
    kvSet(db, 'last_gate_reason', null);
    const capacity = () => cfg.concurrency.global - this.workers.size;
    const runningPerProject = () => {
      const m = new Map<string, number>();
      for (const j of jobsByStatus(db, 'running')) m.set(j.project, (m.get(j.project) ?? 0) + 1);
      return m;
    };

    // 1. Resume queued work first (finishing beats starting).
    for (const job of jobsByStatus(db, 'queued')) {
      if (capacity() <= 0) return;
      const p = cfg.projects.find((x) => x.key === job.project);
      if (!p || (runningPerProject().get(p.key) ?? 0) >= p.maxConcurrent) continue;
      const ticket = byId.get(job.ticket_id);
      if (!ticket || !rank({ ready: [ticket], byId, cfg, activeJobs: jobsByStatus(db, ...ACTIVE_JOB_STATUSES).filter(j => j.id !== job.id && j.status !== 'queued') }).eligible.length) continue;
      if (acquireLease(db, job.id, owner, leaseMs, ['queued'])) this.startWorker(job.id);
    }

    // 2. Claim new Ready tickets, best first.
    if (capacity() <= 0) return;
    const active = jobsByStatus(db, ...ACTIVE_JOB_STATUSES);
    const ready = [...byId.values()].filter((t) => t.status === 'ready');
    const recent = new Set((db.prepare(`SELECT DISTINCT project FROM jobs WHERE updated_at > ?`).all(now() - 6 * 3600_000) as { project: string }[]).map((r) => r.project));
    const cpp = db.prepare(`SELECT AVG(cost_usd) c FROM jobs WHERE status = 'done' AND cost_usd > 0`).get() as { c: number | null };
    const { eligible, skipped } = rank({ ready, byId, activeJobs: active, cfg, recentProjects: recent, costPerPoint: cpp.c ? cpp.c / 3 : undefined });
    const skipKey = skipped.map((s) => `${s.ticket.identifier}:${s.reason}`).join('|');
    if (skipped.length && kvGet(db, 'last_skip') !== skipKey) { kvSet(db, 'last_skip', skipKey); for (const s of skipped) logEvent(db, 'scheduler.skip', `${s.ticket.identifier}: ${s.reason}`); }

    const claimedProjects = runningPerProject();
    const batchClaims: Job[] = [];
    for (const c of eligible) {
      if (capacity() <= 0) break;
      const p = cfg.projects.find((x) => x.key === c.ticket.projectKey)!;
      if ((claimedProjects.get(p.key) ?? 0) >= p.maxConcurrent) continue;
      // Re-check the ticket right before claiming: it must still be Ready (approved) and unclaimed.
      const fresh = await ctx.tracker.getTicket(c.ticket.id);
      if (!fresh || fresh.status !== 'ready' || activeJobForTicket(db, c.ticket.id)) continue;
      byId.set(fresh.id, fresh);
      const current = new Map(jobsByStatus(db, ...ACTIVE_JOB_STATUSES).map(j => [j.id, j]));
      for (const j of batchClaims) current.set(j.id, j);
      if (!rank({ ready: [fresh], byId, cfg, activeJobs: [...current.values()] }).eligible.length) continue;
      const job = claimTicket(db, { ticketId: fresh.id, identifier: fresh.identifier, project: p.key, repo: p.repo }, owner, leaseMs);
      if (!job) continue;
      batchClaims.push(job);
      if (c.baseBranchOverride) updateJob(db, job.id, { base_branch: c.baseBranchOverride });
      logEvent(db, 'job.claimed', `${fresh.identifier} "${fresh.title}" score=${c.score.toFixed(1)} (${c.reasons.join(', ')})`, { jobId: job.id, ticketId: fresh.id });
      claimedProjects.set(p.key, (claimedProjects.get(p.key) ?? 0) + 1);
      this.startWorker(job.id);
    }
  }

  private startWorker(jobId: string) {
    const p = runJob(this.ctx, jobId)
      .catch((e) => logEvent(this.ctx.db, 'worker.crash', String((e as Error)?.stack ?? e).slice(0, 2000), { jobId, level: 'error' }))
      .finally(() => { this.workers.delete(jobId); this.wake?.(); });
    this.workers.set(jobId, p);
  }
}

/** An owner string "host:pid:boot" on this host whose process no longer exists. */
function ownerDead(owner: string): boolean {
  const [host, pid] = owner.split(':');
  return host === hostname() && !!pid && !pidAlive(Number(pid));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
