import { z } from 'zod';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { runAgent, RunGateClosed } from './context.ts';
import { perTicketLimit } from './budget.ts';
import { getJob, heartbeat, LeaseLostError, logEvent, releaseLease, setStage, updateJob, now, kvGet, kvSet } from './db.ts';
import { CODING_SYSTEM, REVIEW_SYSTEM, docsHint, ticketBlock, untrusted } from './agents/prompts.ts';
import type { AgentRunResult, AgentTool } from './agents/runner.ts';
import { CodingResultSchema, ReviewSchema, jsonSchema } from './agents/schemas.ts';
import type { CodingResult, Review } from './agents/schemas.ts';
import { decisionsForTicket, recordHumanDecision, resolveQuestion } from './decisions.ts';
import { shellQuote, slugify, tail } from './exec.ts';
import { similarity } from './planning.ts';
import { LABEL_SUGGESTED } from './tracker/types.ts';
import type { CheckResult, Job, PullRequest, Stage, Ticket } from './types.ts';
import { STAGES } from './types.ts';
import { scanSecrets, UnsafePushError } from './secrets.ts';
import { WorktreeTamperedError } from './scm/git.ts';
import { inspectChanges, onlyKeywordFindings, onlyNarrowTestUpdates } from './policy.ts';
import { aiApprovalEligible, clearKeywordFlags, isCleared, triageBlocker, triageEnabled } from './triage.ts';
import { conflictFeedback } from './automerge.ts';
import { baseFailsNote, failingTestFilesOfChecks, inDiff, outsideDiffNote } from './ci-flake.ts';
import { looksLikeOfflineMiss, planPrime, readBaseLockfile, readLockfileSafely } from './npm-cache-prime.ts';
export { scanSecrets } from './secrets.ts';

const nextStage = (s: Stage): Stage | null => STAGES[STAGES.indexOf(s) + 1] ?? null;

export interface Blocker {
  reason: string; question: string; options: string[]; recommendation: string | null; decisionId: string | null; policyHash?: string;
  /** For diff-policy blockers: the change's fingerprint and findings, so a human approval can carry over to the same change on a moved base. */
  policyFingerprint?: string; policyReasons?: string[];
  /** A question (from the coding or review agent) that triage may try to resolve before it reaches a human. */
  triage?: boolean;
}

/** Thrown inside a stage to divert the job; handled centrally in runJob. */
class Divert extends Error {
  kind: 'blocked' | 'failed' | 'requeue' | 'wait_ci' | 'canceled';
  blocker?: Blocker;
  constructor(kind: Divert['kind'], message: string, blocker?: Blocker) { super(message); this.kind = kind; this.blocker = blocker; }
}

async function activeTicket(ctx: Ctx, id: string): Promise<Ticket> {
  const ticket = await ctx.tracker.getTicket(id);
  if (!ticket || ['canceled', 'backlog', 'ideas', 'done'].includes(ticket.status)) {
    throw new Divert('canceled', `ticket is ${ticket?.status ?? 'missing'}; stopping (work preserved locally)`);
  }
  return ticket;
}

async function mayContinue(ctx: Ctx, job: Job, signal: AbortSignal) {
  signal.throwIfAborted();
  const ticket = await activeTicket(ctx, job.ticket_id);
  signal.throwIfAborted();
  return ticket;
}

function portFor(job: Job): number {
  // Stable per-job port block so concurrent agents don't collide (10 ports each).
  let h = 0; for (const c of job.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 4100 + (h % 500) * 10;
}

export function projectEnv(project: ProjectConfig, job: Job): Record<string, string> {
  const port = portFor(job);
  const env: Record<string, string> = { PORT: String(port), AUTODEV_PORT_BASE: String(port), AUTODEV_JOB_ID: job.id.slice(0, 8) };
  for (const [k, v] of Object.entries(project.env)) env[k] = v.replaceAll('{{jobId}}', job.id.slice(0, 8)).replaceAll('{{port}}', String(port));
  return env;
}

/**
 * Execute a job from its last completed stage until it finishes, blocks, fails or waits for CI.
 * Caller must hold the job lease. Every stage is idempotent so a crash re-runs at most one stage.
 */
export async function runJob(ctx: Ctx, jobId: string): Promise<void> {
  const { db, owner, cfg } = ctx;
  const leaseMs = cfg.loop.leaseSeconds * 1000;
  const abort = new AbortController();
  const hb = setInterval(() => {
    if (!heartbeat(db, jobId, owner, leaseMs)) { abort.abort(new LeaseLostError(jobId)); clearInterval(hb); }
  }, cfg.loop.heartbeatSeconds * 1000);
  let job = getJob(db, jobId)!;
  const project = cfg.projects.find((p) => p.key === job.project)!;
  const checkTicket = () => activeTicket(ctx, job.ticket_id);
  let checking = false;
  const poll = setInterval(async () => {
    if (checking || abort.signal.aborted) return;
    checking = true;
    try { await checkTicket(); } catch (e) { abort.abort(e); } finally { checking = false; }
  }, cfg.loop.cancellationPollSeconds * 1000);
  try {
    let ticket = await checkTicket();
    if (ticket.status !== 'in_progress') { await ctx.tracker.setStatus(ticket.id, 'in_progress'); ticket = { ...ticket, status: 'in_progress' }; }

    for (let next = nextStage(job.stage); next; next = nextStage(job.stage)) {
      abort.signal.throwIfAborted();
      ticket = await checkTicket();
      await runStage(ctx, job, ticket, project, next, abort.signal);
      abort.signal.throwIfAborted();
      await checkTicket();
      setStage(db, jobId, next, owner);
      job = getJob(db, jobId)!;
    }
    // All stages complete → awaiting human merge.
    releaseLease(db, jobId, owner, 'awaiting_merge', { error: null });
    logEvent(db, 'job.review', `${job.ticket_identifier} ready for human review: ${job.pr_url}`, { jobId, ticketId: job.ticket_id });
  } catch (e) {
    let failure = abort.signal.aborted ? abort.signal.reason : e;
    if (!(failure instanceof LeaseLostError)) {
      try { await checkTicket(); } catch (latest) { failure = latest; }
    }
    await handleDivert(ctx, getJob(db, jobId)!, project, failure);
  } finally {
    clearInterval(hb);
    clearInterval(poll);
  }
}

async function runStage(ctx: Ctx, job: Job, ticket: Ticket, project: ProjectConfig, stage: Stage, signal: AbortSignal) {
  const { db, owner, ws, scm, tracker } = ctx;
  switch (stage) {
    case 'claimed':
      return;

    case 'workspace': {
      const base = job.base_branch ?? project.baseBranch ?? (await scm.defaultBranch(job.repo));
      const branch = job.branch ?? `autodev/${job.ticket_identifier.toLowerCase()}-${slugify(ticket.title, 32)}`;
      const { path, reused } = await ws.ensureWorktree(job.repo, job.ticket_identifier, branch, base);
      const state = ws.trustedState(path);
      const pinned = { base_branch: base, branch, worktree: path, base_sha: state.base_sha, candidate_sha: state.head_sha };
      updateJob(db, job.id, pinned, owner);
      Object.assign(job, pinned);
      if (!reused) {
        for (const cmd of project.setup) {
          const r = await projectCommand(ctx, job, project, cmd, 20 * 60_000, signal);
          if (r.code !== 0) throw new Divert('failed', `setup command failed: ${cmd}\n${tail(r.stderr || r.stdout, 2000)}`);
        }
      }
      if (job.attempts === 0 && job.fix_attempts === 0 && job.review_cycles === 0 && !reused) {
        await tracker.comment(ticket.id, `🤖 autodev started work on branch \`${branch}\` (base \`${base}\`).`);
      }
      return;
    }

    case 'implement':
      // Check the host command runtime before paying for another coding attempt,
      // including jobs requeued by an earlier validation-sandbox failure.
      await commandPreflight(ctx, job, project, signal);
      await implement(ctx, job, ticket, project, signal);
      signal.throwIfAborted();
      {
        // A base merge left conflicts for the agent: never commit leftover conflict markers.
        const unmerged = await ws.unmergedPaths(job.worktree!);
        const left = unmerged.length ? ws.conflictMarkers(job.worktree!, unmerged) : [];
        if (left.length) return feedbackLoop(ctx, job, 'merge-conflict', `Conflict markers (<<<<<<< ======= >>>>>>>) remain in: ${left.join(', ')}. Resolve them, keeping both sides' intent.`);
      }
      await ws.commitAll(job.worktree!, `${job.ticket_identifier}: preserve implementation before policy checks`);
      const captured = { candidate_sha: await ws.headSha(job.worktree!), validated_sha: null, reviewed_sha: null, candidate_worktree: null };
      updateJob(db, job.id, captured, owner);
      Object.assign(job, captured);
      return requireChangeApproval(ctx, job, project);

    case 'validate': {
      await ws.assertCandidate(job.worktree!, candidate(job));
      await requireChangeApproval(ctx, job, project);
      const view = await ws.candidateSnapshot(job.worktree!, candidate(job));
      updateJob(db, job.id, { candidate_worktree: view }, owner);
      job.candidate_worktree = view;
      const validationJob = { ...job, worktree: view };
      for (const cmd of project.setup) {
        let r = await projectCommand(ctx, validationJob, project, cmd, 20 * 60_000, signal);
        let primeNote = '';
        if (r.code !== 0 && project.npmCachePrime && project.npmCacheDir && looksLikeOfflineMiss(r.stderr + '\n' + r.stdout)) {
          // The candidate's lockfile adds packages the offline cache lacks: prime the cache once per candidate, then retry.
          const prime = await primeCacheForCandidate(ctx, job, project, view, signal);
          if (prime.primed) r = await projectCommand(ctx, validationJob, project, cmd, 20 * 60_000, signal);
          else if (prime.note) primeNote = `\n\nAutomatic npm cache priming did not run: ${prime.note}\nOnly registry packages that are approved for this project (or dependencies of approved/existing ones) can be primed automatically; anything else needs the operator.`;
        }
        if (r.code !== 0) return feedbackLoop(ctx, job, 'validation setup', tail(r.stderr || r.stdout, 2000) + primeNote);
        await ws.assertSnapshot(view, job.worktree!, candidate(job));
      }
      const failures: string[] = [];
      for (const cmd of project.validate) {
        const r = await projectCommand(ctx, validationJob, project, cmd, 30 * 60_000, signal);
        logEvent(db, 'validate', `${cmd} → exit ${r.code}`, { jobId: job.id, ticketId: job.ticket_id, level: r.code ? 'warn' : 'info' });
        if (r.code !== 0) failures.push(`$ ${cmd}\n(exit ${r.code}${r.timedOut ? ', timed out' : ''})\n${tail(r.stdout + '\n' + r.stderr, 4000)}`);
        await ws.assertCandidate(job.worktree!, candidate(job));
        await ws.assertSnapshot(view, job.worktree!, candidate(job));
      }
      if (failures.length) return feedbackLoop(ctx, job, 'validation', `The orchestrator ran the project's validation and it failed:\n\n${failures.join('\n\n')}`);
      updateJob(db, job.id, { validated_sha: candidate(job) }, owner);
      return;
    }

    case 'commit': {
      await ws.assertCandidate(job.worktree!, candidate(job));
      if (job.validated_sha !== candidate(job)) throw new WorktreeTamperedError(job.worktree!, 'candidate was not validated');
      await requireChangeApproval(ctx, job, project);
      const ahead = await ws.aheadOf(job.worktree!, job.base_branch!);
      if (ahead === 0) throw new Divert('blocked', 'the coding agent produced no changes', { reason: 'no changes were produced', question: 'The agent finished without changing anything. Is this ticket already done, or does it need clarification?', options: ['Close as already done', 'Clarify the ticket and move back to Ready'], recommendation: null, decisionId: null });
      const diff = await ws.diff(job.worktree!, job.base_branch!);
      const secrets = scanSecrets(diff);
      if (secrets.length) {
        throw new Divert('blocked', 'possible secrets in diff', { reason: `possible secrets detected in the diff (${secrets.join(', ')}); not pushing`, question: 'The diff appears to contain credentials. Review the worktree and confirm they are test values or remove them.', options: ['They are test values; continue', 'Remove them and retry'], recommendation: 'Remove them and retry', decisionId: null });
      }
      return;
    }

    case 'push':
      if (job.validated_sha !== candidate(job)) throw new WorktreeTamperedError(job.worktree!, 'push candidate was not validated');
      await ws.assertCandidate(job.worktree!, candidate(job));
      await requireChangeApproval(ctx, job, project);
      await ws.push(job.worktree!, job.branch!, job.repo, { signal, expectedSha: candidate(job), beforePush: () => mayContinue(ctx, job, signal) });
      return;

    case 'pr': {
      let pr = job.pr_number ? await scm.getPr(job.repo, job.pr_number) : await scm.findPr(job.repo, job.branch!);
      if (pr && pr.state === 'closed') throw new Divert('canceled', `PR #${pr.number} was closed without merging`);
      if (!pr) {
        const body = await prBody(ctx, job, ticket, null, 'in progress');
        await mayContinue(ctx, job, signal);
        pr = await scm.createPr(job.repo, { head: job.branch!, base: job.base_branch!, title: `${job.ticket_identifier}: ${ticket.title}`, body, draft: true });
        logEvent(db, 'pr.created', `#${pr.number} ${pr.url}`, { jobId: job.id, ticketId: job.ticket_id });
      }
      pr = await awaitPrHead(ctx, job, pr, signal);
      assertPrCandidate(job, pr);
      updateJob(db, job.id, { pr_number: pr.number, pr_url: pr.url }, owner);
      Object.assign(job, { pr_number: pr.number, pr_url: pr.url });
      await tracker.attachLink(ticket.id, pr.url, `PR #${pr.number}`).catch(() => {});
      return;
    }

    case 'ci': {
      const pr = await scm.getPr(job.repo, job.pr_number!);
      assertPrCandidate(job, pr);
      const checks = await scm.checks(job.repo, pr, project.requiredChecks);
      if (checks.state === 'pending') throw new Divert('wait_ci', 'waiting for CI');
      if (checks.state === 'failure') {
        const note = await flakyCi(ctx, job, project, pr, checks);
        return feedbackLoop(ctx, job, 'ci', `GitHub CI failed on ${pr.headSha.slice(0, 8)}:\n${checks.failures.map((f) => `- ${f.name}: ${f.summary}`).join('\n')}\n\nLogs:\n${checks.logExcerpt || '(no logs available)'}${note ? `\n\n${note}` : ''}`);
      }
      updateJob(db, job.id, { summary_json: mergeSummary(job, { ci: checks.state === 'none' ? 'no CI checks reported' : 'all checks passed' }) }, owner);
      return;
    }

    case 'review':
      return review(ctx, job, ticket, project, signal);

    case 'handoff': {
      await ws.assertCandidate(job.worktree!, candidate(job));
      await ws.assertSnapshot(job.candidate_worktree!, job.worktree!, candidate(job));
      if (job.reviewed_sha !== candidate(job) || job.validated_sha !== candidate(job)) throw new WorktreeTamperedError(job.worktree!, 'handoff candidate lacks validation or review');
      const pr = await scm.getPr(job.repo, job.pr_number!);
      assertPrCandidate(job, pr);
      const preview = await scm.previewUrl(job.repo, pr).catch(() => null);
      if (preview) updateJob(db, job.id, { summary_json: mergeSummary(getJob(db, job.id)!, { preview }) }, owner);
      await mayContinue(ctx, job, signal);
      await scm.updatePr(job.repo, pr.number, { body: await prBody(ctx, getJob(db, job.id)!, ticket, preview, 'ready for review') });
      await mayContinue(ctx, job, signal);
      await tracker.setStatus(ticket.id, 'review');
      const s = JSON.parse(job.summary_json ?? '{}');
      const lead = project.autoMerge ? `✅ Ready: ${pr.url}\nautodev merges it automatically once the second review and every merge gate pass; otherwise it asks for your review.` : `✅ Ready for your review: ${pr.url}`;
      await tracker.comment(ticket.id, `${lead}${preview ? `\nPreview: ${preview}` : ''}\n\n${s.coding?.summary ?? ''}\n\nAI review: ${s.review?.outcome ?? 'n/a'} — ${s.review?.summary ?? ''}`);
      return;
    }
  }
}

function candidate(job: Job): string {
  if (!job.candidate_sha || !job.base_sha) throw new WorktreeTamperedError(job.worktree ?? job.id, 'job has no trusted candidate/base hashes');
  return job.candidate_sha;
}

/**
 * The push stage just pushed the validated candidate, but the PR API can briefly report the previous head. Re-read the
 * PR for a bounded window and return as soon as it reports exactly the candidate. Nothing else is accepted: if the head
 * still differs when the window ends, the caller's assertPrCandidate blocks the job as tampering, as before.
 */
export async function awaitPrHead(ctx: Ctx, job: Job, pr: PullRequest, signal: AbortSignal): Promise<PullRequest> {
  const want = candidate(job);
  if (pr.headSha === want) return pr;
  const windowMs = ctx.cfg.loop.prHeadConvergeSeconds * 1000;
  const intervalMs = Math.min(2_000, Math.max(50, windowMs / 10));
  const started = Date.now();
  const firstSeen = pr.headSha;
  while (Date.now() - started < windowMs) {
    signal.throwIfAborted(); // a cancellation that fired during the previous read stops here, not after the window
    await abortableSleep(intervalMs, signal);
    pr = await ctx.scm.getPr(job.repo, pr.number);
    signal.throwIfAborted(); // never act on a read that finished after cancellation
    if (pr.headSha === want) {
      logEvent(ctx.db, 'pr.head_converged', `#${pr.number}: API reported ${firstSeen.slice(0, 12)} after the push; converged to the candidate ${want.slice(0, 12)} after ${Date.now() - started} ms`, { jobId: job.id, ticketId: job.ticket_id });
      return pr;
    }
  }
  logEvent(ctx.db, 'pr.head_mismatch', `#${pr.number}: head still ${pr.headSha.slice(0, 12)} (candidate ${want.slice(0, 12)}) after ${windowMs} ms`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
  return pr;
}

/** Sleep that rejects on abort, checks an already-aborted signal first, and always removes its listener. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertPrCandidate(job: Job, pr: PullRequest) {
  if (pr.headSha !== candidate(job)) throw new WorktreeTamperedError(job.worktree!, 'remote PR HEAD differs from the validated candidate');
}

/**
 * A closed run gate: global limits (daily/monthly budget, pauses) clear by waiting, so requeue. The ticket's own
 * budget never clears by waiting; requeueing it would retry forever and hold the project's slot, so block for a human.
 */
function gateDivert(ctx: Ctx, job: Job, e: RunGateClosed): Divert {
  if (!e.ticketBudget) return new Divert('requeue', e.why);
  return new Divert('blocked', e.why, ticketBudgetBlocker(ctx, job));
}

function ticketBudgetBlocker(ctx: Ctx, job: Job): Blocker {
  const spent = (ctx.db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE ticket_id = ?').get(job.ticket_id) as { s: number }).s;
  const limit = perTicketLimit(ctx.db, ctx.cfg, job.ticket_id);
  return { reason: `ticket budget $${limit} exhausted ($${spent.toFixed(2)} spent)`, question: 'Continue spending on this ticket?', options: ['Raise the per-ticket budget and move back to Ready', 'Split the ticket', 'Cancel'], recommendation: 'Split the ticket', decisionId: null };
}

async function requireChangeApproval(ctx: Ctx, job: Job, project: ProjectConfig) {
  const state = ctx.ws.trustedState(job.worktree!);
  if (state.base_sha !== job.base_sha || state.head_sha !== candidate(job)) throw new WorktreeTamperedError(job.worktree!, 'policy hashes differ from the job candidate');
  const result = await inspectChanges(ctx.ws, job.worktree!, job.base_branch!, project, ctx.cfg);
  if (!result.reasons.length || kvGet(ctx.db, `policy-approved:${job.id}:${result.hash}`)) return;
  // A human approved this same change (same fingerprint) with the same or more findings; only the base moved since.
  const carried = result.fingerprint ? kvGet(ctx.db, `policy-approved-change:${job.id}:${result.fingerprint}`) : null;
  if (carried && result.reasons.every((r) => (JSON.parse(carried) as string[]).includes(r))) {
    kvSet(ctx.db, `policy-approved:${job.id}:${result.hash}`, 'human (carried over: same change, moved base)');
    logEvent(ctx.db, 'policy.approval_carried', `${job.ticket_identifier}: human approval carried over to diff ${result.hash.slice(0, 12)} (same change ${result.fingerprint!.slice(0, 12)}, base moved)`, { jobId: job.id, ticketId: job.ticket_id });
    return;
  }
  if (isCleared(ctx, job, result)) return;
  // Option B: when the ONLY findings are eligible narrow existing-test updates and auto-merge with a second reviewer is
  // on, don't stop for a human here. The merge gate then requires a recorded superseding requirement and a dedicated
  // test-integrity review of the exact candidate, and holds for a human otherwise. Nothing merges on this path alone.
  if (project.autoMerge && ctx.cfg.secondReview.enabled && onlyNarrowTestUpdates(result)) {
    const key = `policy-deferred:${job.id}:${result.hash}`;
    if (!kvGet(ctx.db, key)) {
      kvSet(ctx.db, key, '1');
      logEvent(ctx.db, 'policy.test_update_deferred', `${job.ticket_identifier}: narrow existing-test update (${result.testUpdates.map((u) => `${u.file}: ${u.changes.length} rename/expected-value change(s)`).join('; ')}) deferred to the test-integrity review`, { jobId: job.id, ticketId: job.ticket_id });
    }
    return;
  }
  // Triage: findings that come ONLY from the keyword heuristic may be cleared for this exact diff.
  let triageNote = '';
  if (onlyKeywordFindings(result) && triageEnabled(ctx, project)) {
    const c = await clearKeywordFlags(ctx, job, project, result);
    if (c.kind === 'cleared') return;
    triageNote = c.kind === 'waiting' ? 'triage unavailable (second-review budget reached)' : c.note;
  }
  // flaggedDiffApprover 'second-review': don't stop for the owner here. The merge gate asks the second reviewer to judge
  // every finding for the exact diff and holds for a human unless it accepts all of them. Nothing merges on this path alone.
  if (aiApprovalEligible(ctx, project, result)) {
    const key = `policy-deferred-ai:${job.id}:${result.hash}`;
    if (!kvGet(ctx.db, key)) {
      kvSet(ctx.db, key, '1');
      logEvent(ctx.db, 'policy.deferred_to_ai_review', `${job.ticket_identifier}: flagged diff ${result.hash.slice(0, 12)} (${result.reasons.length} finding(s)) deferred to the second reviewer (owner-delegated)`, { jobId: job.id, ticketId: job.ticket_id });
    }
    return;
  }
  throw new Divert('blocked', 'mandatory diff policy requires human approval', {
    reason: `${result.reasons.join('; ')}${triageNote ? `\n\n**Triage:** ${triageNote}` : ''}`, policyHash: result.hash,
    ...(result.fingerprint ? { policyFingerprint: result.fingerprint } : {}), policyReasons: result.reasons,
    question: `Review the local diff (${result.hash.slice(0, 12)}). Remove the flagged changes, or explicitly approve this exact diff with /answer approve.`,
    options: ['Remove or revise flagged changes', 'Approve this exact diff with /answer approve'],
    recommendation: 'Remove or revise flagged changes', decisionId: null,
  });
}

/**
 * A CI failure confined to test files outside the candidate's diff may be a flaky test the agent cannot fix. The first
 * time for a candidate, re-run the failed jobs and wait for CI again (diverts to waiting_ci). A second such failure is
 * evidence of a deterministic one, so it goes to the agent with a neutral note (the tests may cover code it changed);
 * only when the same tests also fail on the base branch's latest CI is it called likely pre-existing, and logged as
 * `ci.flake_suspected` so an operator can file a ticket. Returns null when the failure is not of that kind.
 */
async function flakyCi(ctx: Ctx, job: Job, project: ProjectConfig, pr: PullRequest, checks: CheckResult): Promise<string | null> {
  const { db, scm, ws, cfg } = ctx;
  const key = `ci-retry:${job.id}:${pr.headSha}`;
  const earlier = kvGet(db, key);
  const retry = earlier ? JSON.parse(earlier) as { at: number; rerun?: boolean } : null;
  // GitHub can register a re-run before its new check runs exist; until then the head still reports the failures the
  // re-run was requested for. Those finished before the request: keep waiting (bounded by ciTimeoutMinutes) rather than
  // read them as the re-run's result.
  if (retry && retry.rerun !== false && checks.failures.some((f) => f.completedAt !== undefined && f.completedAt < retry.at)) {
    if (now() - retry.at < cfg.limits.ciTimeoutMinutes * 60_000) throw new Divert('wait_ci', 'waiting for the re-run CI jobs to report');
    kvSet(db, key, JSON.stringify({ ...retry, rerun: false }));
    logEvent(db, 'ci.flake_retry_error', `${job.ticket_identifier}: the re-run CI jobs did not report within ${cfg.limits.ciTimeoutMinutes} minutes`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
    retry.rerun = false;
  }
  const files = failingTestFilesOfChecks(checks);
  if (!files) return null;
  const changed = await ws.changedFiles(job.worktree!, job.base_branch!);
  if (files.some((f) => inDiff(f, changed))) return null;
  const at = { jobId: job.id, ticketId: job.ticket_id };
  const sha = pr.headSha.slice(0, 8);
  if (!retry) {
    kvSet(db, key, JSON.stringify({ files, at: now(), rerun: true }));
    try {
      await scm.rerunFailedJobs(job.repo, pr);
      logEvent(db, 'ci.flake_retry', `${job.ticket_identifier}: CI failed only in tests outside the diff (${files.join(', ')}); re-running the failed jobs once on ${sha}`, { ...at, level: 'warn', data: { sha: pr.headSha, files } });
      throw new Divert('wait_ci', 're-running CI jobs that failed outside the diff');
    } catch (e) {
      if (e instanceof Divert) throw e;
      kvSet(db, key, JSON.stringify({ files, at: now(), rerun: false }));
      logEvent(db, 'ci.flake_retry_error', `${job.ticket_identifier}: could not re-run the failed jobs: ${String((e as Error)?.message ?? e).slice(0, 300)}`, { ...at, level: 'warn' });
      return outsideDiffNote(files, false);
    }
  }
  if (retry.rerun === false) return outsideDiffNote(files, false);
  const base = job.base_branch!;
  const baseFiles = await scm.branchSha(job.repo, base)
    .then((baseSha) => scm.checks(job.repo, { ...pr, headSha: baseSha, headBranch: base }, project.requiredChecks))
    .then((c) => failingTestFilesOfChecks(c) ?? [])
    .catch(() => [] as string[]);
  if (files.every((f) => baseFiles.includes(f))) {
    logEvent(db, 'ci.flake_suspected', `${job.ticket_identifier}: CI failed again after a re-run on ${sha}, only in tests outside the diff that also fail on ${base}: ${files.join(', ')}; consider a ticket`, { ...at, level: 'warn', data: { sha: pr.headSha, base, files } });
    return baseFailsNote(files, base);
  }
  logEvent(db, 'ci.retry_failed', `${job.ticket_identifier}: CI failed again after a re-run on ${sha} in tests outside the diff (${files.join(', ')}); ${base} does not fail them, so the change is handed back to the agent`, { ...at, level: 'warn', data: { sha: pr.headSha, files } });
  return outsideDiffNote(files, true);
}

/** Queue feedback for another implement pass, bounded by maxFixAttempts. */
function feedbackLoop(ctx: Ctx, job: Job, source: string, feedback: string): never {
  const max = ctx.cfg.limits.maxFixAttempts;
  if (job.fix_attempts >= max) {
    throw new Divert('failed', `${source} still failing after ${max} fix attempts:\n${tail(feedback, 1500)}`);
  }
  updateJob(ctx.db, job.id, { fix_attempts: job.fix_attempts + 1, pending_feedback: feedback, stage: 'workspace' }, ctx.owner);
  logEvent(ctx.db, `fix.${source}`, `queued fix attempt ${job.fix_attempts + 1}/${max}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
  throw new Divert('requeue', `${source} failed; retrying with feedback`);
}

/**
 * Prime the project's offline npm cache from the candidate snapshot's lockfile, at most once per candidate. Returns true
 * when the cache was primed (the caller retries setup); false when priming was refused or failed, with the reason logged
 * and left in the job's feedback so the agent (or a human) sees why.
 */
async function primeCacheForCandidate(ctx: Ctx, job: Job, project: ProjectConfig, snapshot: string, signal: AbortSignal): Promise<{ primed: boolean; note?: string }> {
  const { db } = ctx;
  const key = `npm-cache-primed:${job.id}:${candidate(job)}`;
  if (kvGet(db, key)) return { primed: false, note: 'already attempted for this candidate' };
  kvSet(db, key, 'attempted');
  const cacheDir = resolve(ctx.cfg.configDir, project.npmCacheDir!);
  // Untrusted setup commands just ran in the snapshot: re-verify it against the candidate before reading anything,
  // then read the lockfile without following symlinks, regular files only, size-capped.
  await ctx.ws.assertSnapshot(snapshot, job.worktree!, candidate(job));
  let candidateLock: string | null;
  try { candidateLock = readLockfileSafely(join(snapshot, 'package-lock.json')); } catch (e) {
    const note = String((e as Error).message ?? e).slice(0, 300);
    logEvent(db, 'cache.prime.refused', `${job.ticket_identifier}: ${note}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' }); return { primed: false, note };
  }
  if (!candidateLock) { logEvent(db, 'cache.prime.refused', `${job.ticket_identifier}: no package-lock.json in the candidate`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' }); return { primed: false, note: 'no package-lock.json in the candidate' }; }
  const baseLock = job.base_sha ? await readBaseLockfile(job.worktree!, job.base_sha) : null;
  const limits = { maxArtifacts: project.npmCachePrimeMaxArtifacts, maxBytes: Math.round(project.npmCachePrimeMaxMb * 1e6) };
  const plan = await planPrime(candidateLock, baseLock, project.approvedDependencies, { ...limits, deadlineMs: project.npmCachePrimeTimeoutMinutes * 60_000 }, ctx.fetchPackument, signal);
  if (!plan.ok) { logEvent(db, 'cache.prime.refused', `${job.ticket_identifier}: ${plan.reason}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' }); return { primed: false, note: plan.reason }; }
  if (!plan.artifacts.length) return { primed: false, note: 'the lockfile adds or changes no registry packages, so the cache is not the cause' };
  signal.throwIfAborted();
  const out = await ctx.primeNpmCache({ artifacts: plan.artifacts, cacheDir, timeoutMs: project.npmCachePrimeTimeoutMinutes * 60_000, maxBytes: limits.maxBytes, signal });
  if (!out.ok) { logEvent(db, 'cache.prime.failed', `${job.ticket_identifier}: ${out.reason.slice(0, 400)} (${out.artifacts} artifact(s), ${(out.bytesAdded / 1e6).toFixed(1)} MB added before stopping)`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' }); return { primed: false, note: `npm failed: ${out.reason.slice(0, 300)}` }; }
  kvSet(db, key, 'primed');
  logEvent(db, 'cache.primed', `${job.ticket_identifier}: ${out.artifacts} artifact(s) fetched for ${plan.newNames.length} new package(s) of ${plan.totalEntries} entries (${(out.bytesAdded / 1e6).toFixed(1)} MB added, ${Math.round(out.durationMs / 1000)}s): ${plan.newNames.slice(0, 12).join(', ')}${plan.newNames.length > 12 ? ', …' : ''}`, { jobId: job.id, ticketId: job.ticket_id });
  return { primed: true };
}

async function projectCommand(ctx: Ctx, job: Job, project: ProjectConfig, cmd: string, timeoutMs: number, signal: AbortSignal) {
  const env = projectEnv(project, job);
  return ctx.runCommand(cmd, job.worktree!, env, timeoutMs, signal, { npmCacheDir: project.npmCacheDir ? resolve(ctx.cfg.configDir, project.npmCacheDir) : undefined });
}

async function commandPreflight(ctx: Ctx, job: Job, project: ProjectConfig, signal: AbortSignal) {
  const marker = 'AUTODEV_RUNTIME_READY';
  const cmd = `${shellQuote(process.execPath)} -e ${shellQuote(`process.stdout.write('${marker}')`)}`;
  const result = await projectCommand(ctx, job, project, cmd, 10_000, signal);
  signal.throwIfAborted();
  if (result.code === 0 && result.stdout === marker) return;
  throw new Divert('blocked', 'command sandbox preflight failed', {
    reason: `command sandbox preflight failed before agent execution (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ''}): ${tail(result.stderr || result.stdout || 'no output', 1500)}`,
    question: 'Repair and verify the host command sandbox with node scripts/diagnose-sandbox.ts before resuming this ticket.',
    options: ['Repair the host command sandbox, then retry', 'Cancel'], recommendation: null, decisionId: null,
  });
}

function mergeSummary(job: Job, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(job.summary_json ?? '{}'), ...patch });
}

// ---------------- implement (Coding Agent) ----------------

async function implement(ctx: Ctx, job: Job, ticket: Ticket, project: ProjectConfig, signal: AbortSignal) {
  const { cfg, db, owner } = ctx;
  let blocker: Blocker | null = null;
  let proposals = 0;
  const tools: AgentTool[] = [
    {
      name: 'request_decision',
      description: 'Ask the Decision Agent to research and resolve a technical question you cannot answer from docs/code. Returns DECIDED (follow it) or BLOCKED (stop, leave WIP in place, finish with status blocked).',
      schema: { question: z.string().describe('One precise question'), context: z.string().describe('What you found so far and why it matters'), options: z.array(z.string()).describe('Options you see') },
      handler: async (a) => {
        signal.throwIfAborted();
        const out = await resolveQuestion(ctx, { job: getJob(db, job.id)!, ticket, project, worktree: job.worktree!, question: String(a.question), context: String(a.context), options: (a.options as string[]) ?? [], signal });
        if (out.kind === 'answered') return out.text;
        blocker = { reason: out.reason, question: out.question, options: out.options, recommendation: out.recommendation, decisionId: out.decisionId };
        return `BLOCKED: ${out.reason}. Stop implementing. Leave your work-in-progress in place and finish with status "blocked".`;
      },
    },
    {
      name: 'propose_ticket',
      description: 'Propose a follow-up ticket (bug, missing test, tech debt, improvement) outside this ticket\'s scope. It goes to Backlog for human approval.',
      schema: { title: z.string(), description: z.string(), kind: z.enum(['bug', 'test', 'debt', 'improvement']) },
      handler: async (a) => {
        if (proposals >= 3) return 'Proposal limit reached for this ticket; mention further ideas in knownLimitations.';
        proposals++;
        return proposeTicket(ctx, job, ticket, String(a.title), `${a.description}\n\nKind: ${a.kind}`);
      },
    },
    {
      name: 'report_blocker',
      description: 'Report that you cannot proceed safely without a human (missing access, contradictory requirements, destructive change needed). Then leave WIP in place and finish with status blocked.',
      schema: { reason: z.string(), question: z.string(), options: z.array(z.string()), recommendation: z.string().optional() },
      handler: async (a) => {
        blocker = { reason: String(a.reason), question: String(a.question), options: (a.options as string[]) ?? [], recommendation: (a.recommendation as string) ?? null, decisionId: null };
        return 'Blocker recorded. Leave your work-in-progress in place and finish with status "blocked".';
      },
    },
  ];

  const complexity = ticket.estimate ?? 3;
  const model = complexity >= cfg.models.complexThreshold ? cfg.models.codingComplex : cfg.models.coding;
  const priorDecisions = decisionsForTicket(ctx, ticket.id).filter((d) => d.status === 'resolved').map((d) => `- Q: ${d.question}\n  A (${d.authority}): ${d.decision}`).join('\n');
  // Human answers on the [Plan] umbrella issue (e.g. to the plan's open questions) are part of the requirements.
  const planNotes = ticket.parentId ? (await ctx.tracker.listComments(ticket.parentId).catch(() => [])).filter((c) => !c.byAutomation).map((c) => c.body).join('\n---\n') : '';
  const refreshed = baseRefreshNote(ctx, job);
  const feedback = [job.pending_feedback, refreshed].filter(Boolean).join('\n\n') || null;
  const status = (await ctx.ws.status(job.worktree!)).trim();
  const ahead = await ctx.ws.aheadOf(job.worktree!, job.base_branch!);

  const fresh = `${docsHint(project)}
Implement this approved ticket in repository ${job.repo}. You are on branch ${job.branch} (base ${job.base_branch}).
${ticketBlock(ticket)}
${planNotes ? `\nHuman answers/notes on the parent plan (authoritative requirements):\n${untrusted('linear-plan-comments', planNotes)}\n` : ''}${priorDecisions ? `\nDecisions already made for this ticket (follow them):\n${priorDecisions}\n` : ''}
${ahead || status ? `\nNOTE: a previous attempt left work on this branch (${ahead} commit(s) ahead${status ? ', uncommitted changes present' : ''}). Inspect git log/diff/status and continue from it rather than starting over.\n` : ''}
${feedback ? `\nFeedback to address:\n${untrusted('orchestrator-feedback', feedback)}\n` : ''}
${complexity >= 3 && cfg.featureDevPluginPath ? 'This is a complex ticket: use the code-explorer and code-architect subagents (Task tool) to map the code and choose an approach before editing.\n' : ''}
Validation the orchestrator will run after you: ${project.validate.join(' && ') || '(none configured — run the relevant tests yourself)'}.
When done, leave the changes in the working tree (the orchestrator commits them) and return the structured result.`;

  const spec = {
    role: 'coding' as const, systemAppend: CODING_SYSTEM, cwd: job.worktree!, model, mode: 'write' as const, tools,
    outputSchema: jsonSchema(CodingResultSchema), maxTurns: cfg.limits.agentMaxTurns, timeoutMs: cfg.limits.agentTimeoutMinutes * 60_000,
    env: projectEnv(project, job), sandbox: cfg.sandbox, plugins: cfg.featureDevPluginPath && complexity >= 3 ? [cfg.featureDevPluginPath] : undefined,
    signal,
  };
  let res: AgentRunResult;
  try {
    // Fix loops resume the previous session (keeps context); fall back to a fresh session if it can't be resumed.
    if (feedback && job.session_id) {
      res = await runAgent(ctx, { ...spec, resume: job.session_id, prompt: `Follow-up from the orchestrator. ${untrusted('orchestrator-feedback', feedback)}\nAddress it, re-run relevant checks, leave changes in the working tree, and return the structured result.` }, { jobId: job.id, ticketId: ticket.id });
      if (!res.ok && res.numTurns === 0 && res.errorKind === 'other') res = await runAgent(ctx, { ...spec, prompt: fresh }, { jobId: job.id, ticketId: ticket.id });
    } else {
      res = await runAgent(ctx, { ...spec, prompt: fresh }, { jobId: job.id, ticketId: ticket.id });
    }
  } catch (e) {
    if (e instanceof RunGateClosed) throw gateDivert(ctx, job, e);
    throw e;
  }
  if (res.sessionId) updateJob(db, job.id, { session_id: res.sessionId }, owner);

  const blk = blocker as Blocker | null;
  if (blk) throw new Divert('blocked', blk.reason, blk);
  if (!res.ok) throw new AgentFailure(res);

  const parsed = CodingResultSchema.safeParse(res.structured);
  const result: CodingResult = parsed.success ? parsed.data : { status: 'completed', summary: res.text.slice(0, 2000), filesChanged: [], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: ['structured result missing'] };
  if (result.status === 'blocked') throw new Divert('blocked', result.blocker ?? 'agent reported blocked', { reason: result.blocker ?? 'agent reported blocked', question: result.blocker ?? 'The coding agent could not proceed. See its summary.', options: [], recommendation: null, decisionId: null, triage: true });
  if (result.status === 'failed') throw new AgentFailure({ ...res, ok: false, errorKind: 'other', error: result.blocker ?? result.summary });
  updateJob(db, job.id, { pending_feedback: null, summary_json: mergeSummary(job, { coding: result }) }, owner);
  kvSet(db, `base-refreshed:${job.id}`, null);
  job.pending_feedback = null;
}

class AgentFailure extends Error {
  res: AgentRunResult;
  constructor(res: AgentRunResult) { super(`agent failed (${res.errorKind}): ${res.error}`); this.res = res; }
}

export async function proposeTicket(ctx: Ctx, job: Job, source: Ticket, title: string, description: string): Promise<string> {
  const existing = await ctx.tracker.listTickets({ projectKey: job.project });
  // Paraphrased repeats from the same source ticket (e.g. successive review passes) use a looser threshold.
  const sameSource = (t: Ticket) => t.labels.includes(LABEL_SUGGESTED) && t.description.includes(`while working on ${source.identifier}.`);
  const dup = existing.find((t) => t.status !== 'canceled' && similarity(t.title, title) >= (sameSource(t) ? 0.3 : 0.7));
  if (dup) return `Not created: similar ticket ${dup.identifier} "${dup.title}" already exists.`;
  const t = await ctx.tracker.createTicket({
    projectKey: job.project, title, status: 'backlog', priority: 0, labels: [LABEL_SUGGESTED],
    description: `${description}\n\n---\nSuggested automatically while working on ${source.identifier}. Stays in Backlog until a human approves it.`,
  });
  logEvent(ctx.db, 'ticket.suggested', `${t.identifier}: ${title}`, { jobId: job.id, ticketId: source.id });
  return `Created ${t.identifier} in Backlog (needs human approval).`;
}

// ---------------- review (independent) ----------------

async function review(ctx: Ctx, job: Job, ticket: Ticket, project: ProjectConfig, signal: AbortSignal) {
  const { cfg, db, owner, ws } = ctx;
  await ws.assertCandidate(job.worktree!, candidate(job));
  if (!job.candidate_worktree) throw new WorktreeTamperedError(job.worktree!, 'missing validated candidate snapshot');
  await ws.assertSnapshot(job.candidate_worktree, job.worktree!, candidate(job));
  const stat = await ws.diff(job.worktree!, job.base_branch!, true);
  const diff = await ws.diff(job.worktree!, job.base_branch!);
  const weakened = assertionDelta(diff);
  const s = JSON.parse(job.summary_json ?? '{}');
  const prompt = `${docsHint(project)}
Review candidate ${candidate(job)} against trusted base ${job.base_sha} in ${job.repo}.
${ticketBlock(ticket)}

Diff stat:
${untrusted('git', stat)}

Full diff from the orchestrator's protected object store:
${untrusted('git-diff', diff)}

Decisions already approved for this ticket (from the decision log — authoritative requirements, do not re-question them):
${decisionsForTicket(ctx, ticket.id).filter((d) => d.status === 'resolved').map((d) => `- (${d.authority}) Q: ${d.question}\n  A: ${d.decision}`).join('\n') || '- none'}

Orchestrator-verified facts:
- Validation commands passed: ${project.validate.join(', ') || '(none configured)'}
- CI: ${s.ci ?? 'unknown'}
${weakened ? `- WARNING: the diff removes more test assertions than it adds in test files (${weakened}). Scrutinize whether tests were weakened.\n` : ''}
Review this supplied diff and the surrounding files in this candidate snapshot. It has no .git metadata; use the supplied hashes and diff as the authoritative candidate. Return the structured review.`;
  let res: AgentRunResult;
  try {
    res = await runAgent(ctx, {
      role: 'review', prompt, systemAppend: REVIEW_SYSTEM, cwd: job.candidate_worktree, model: cfg.models.review, mode: 'review', fileOnly: true,
      outputSchema: jsonSchema(ReviewSchema), maxTurns: 80, timeoutMs: 30 * 60_000, sandbox: cfg.sandbox,
      signal,
    }, { jobId: job.id, ticketId: ticket.id });
  } catch (e) {
    if (e instanceof RunGateClosed) throw gateDivert(ctx, job, e);
    throw e;
  }
  await ws.assertCandidate(job.worktree!, candidate(job));
  await ws.assertSnapshot(job.candidate_worktree, job.worktree!, candidate(job));
  if (!res.ok) throw new AgentFailure(res);
  const parsed = ReviewSchema.safeParse(res.structured);
  if (!parsed.success) throw new AgentFailure({ ...res, ok: false, errorKind: 'structured_output', error: parsed.error.message });
  const r: Review = parsed.data;
  updateJob(db, job.id, { summary_json: mergeSummary(job, { review: r }) }, owner);
  job.summary_json = mergeSummary(job, { review: r });
  logEvent(db, 'review', `${r.outcome}: ${r.summary.slice(0, 200)}`, { jobId: job.id, ticketId: job.ticket_id });
  for (const f of r.followUps.slice(0, 3)) await proposeTicket(ctx, job, ticket, f.title, f.description).catch(() => {});
  void diff;

  if (r.outcome === 'approved') { updateJob(db, job.id, { reviewed_sha: candidate(job) }, owner); return; }
  if (r.outcome === 'blocked') {
    throw new Divert('blocked', 'review needs a human decision', { reason: `the review agent raised a question that needs a human\n\nReview summary: ${r.summary}`, question: r.blockingQuestion ?? r.summary, options: [], recommendation: null, decisionId: null, triage: true });
  }
  const findings = r.findings.filter((f) => f.severity !== 'nit').map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}\n  Fix: ${f.suggestion}`).join('\n');
  const unmet = r.acceptanceCriteria.filter((a) => !a.met).map((a) => `- NOT MET: ${a.criterion} (${a.evidence})`).join('\n');
  if (job.review_cycles >= cfg.limits.maxReviewCycles) {
    throw new Divert('blocked', 'review loop exhausted', { reason: `review still requests changes after ${cfg.limits.maxReviewCycles} fix cycles`, question: `Open review findings:\n${findings}\n${unmet}\nHow should we proceed?`, options: ['Accept as-is and review manually', 'Clarify requirements and retry', 'Cancel'], recommendation: null, decisionId: null });
  }
  updateJob(db, job.id, { review_cycles: job.review_cycles + 1, pending_feedback: `Independent code review requested changes:\n${r.summary}\n${findings}\n${unmet}`, stage: 'workspace' }, owner);
  throw new Divert('requeue', `review requested changes (cycle ${job.review_cycles + 1}/${cfg.limits.maxReviewCycles})`);
}

// ---------------- divert handling ----------------

async function handleDivert(ctx: Ctx, job: Job, project: ProjectConfig, e: unknown) {
  const { db, owner, tracker, cfg } = ctx;
  if (e instanceof LeaseLostError) { logEvent(db, 'lease.lost', 'stopping worker; another owner or recovery took over', { jobId: job.id, level: 'warn' }); return; }
  if (job.lease_owner !== owner) { logEvent(db, 'lease.lost', `not owner anymore; ignoring ${String(e).slice(0, 200)}`, { jobId: job.id, level: 'warn' }); return; }
  if (e instanceof WorktreeTamperedError) {
    logEvent(db, 'security.worktree_tampered', e.message, { jobId: job.id, ticketId: job.ticket_id, level: 'error' });
    return blockJob(ctx, job, { reason: `security: ${e.message}`, question: 'Something in this job (agent or repository code) modified git metadata. Inspect the worktree before doing anything else; do not retry until it is understood.', options: ['Discard the worktree and retry from scratch', 'Cancel the ticket'], recommendation: 'Discard the worktree and retry from scratch', decisionId: null });
  }
  if (e instanceof UnsafePushError) return blockJob(ctx, job, { reason: e.message, question: 'Remove credentials from every outgoing commit before retrying.', options: [], recommendation: null, decisionId: null });

  if (e instanceof Divert) {
    switch (e.kind) {
      case 'wait_ci':
        releaseLease(db, job.id, owner, 'waiting_ci', { heartbeat_at: now() });
        return;
      case 'requeue':
        releaseLease(db, job.id, owner, 'queued', { error: e.message });
        logEvent(db, 'job.requeued', e.message, { jobId: job.id, ticketId: job.ticket_id });
        return;
      case 'canceled':
        await preserveWork(ctx, job, 'canceled');
        releaseLease(db, job.id, owner, 'canceled', { error: e.message });
        logEvent(db, 'job.canceled', e.message, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
        await tracker.comment(job.ticket_id, `⏹️ autodev stopped: ${e.message}`).catch(() => {});
        return;
      case 'blocked':
        return blockJob(ctx, job, e.blocker!);
      case 'failed':
        return fail(ctx, job, e.message);
    }
  }
  if (e instanceof AgentFailure) {
    const k = e.res.errorKind;
    if (k === 'rate_limited' || k === 'api') {
      releaseLease(db, job.id, owner, 'queued', { error: e.message, stage: 'workspace' });
      return;
    }
    if (k === 'auth') {
      db.prepare("INSERT INTO kv (k, v, updated_at) VALUES ('manual_pause', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run('Claude authentication failed — fix credentials then run `autodev resume`', now());
      releaseLease(db, job.id, owner, 'queued', { error: e.message, stage: 'workspace' });
      logEvent(db, 'auth.failed', e.message, { jobId: job.id, level: 'error' });
      return;
    }
    if (k === 'budget') {
      const t = (db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE ticket_id = ?').get(job.ticket_id) as { s: number }).s;
      if (t >= perTicketLimit(db, cfg, job.ticket_id) - 0.05) return blockJob(ctx, job, ticketBudgetBlocker(ctx, job));
    }
  }
  // Generic failure: bounded retries, then Failed.
  const attempts = job.attempts + 1;
  const msg = String((e as Error)?.message ?? e).slice(0, 4000);
  if (attempts >= cfg.limits.maxAttempts) return fail(ctx, { ...job, attempts }, msg);
  releaseLease(db, job.id, owner, 'queued', { attempts, error: msg, stage: STAGES.indexOf(job.stage) >= STAGES.indexOf('workspace') ? job.stage : 'claimed', pending_feedback: job.pending_feedback ?? (job.stage === 'workspace' ? `A previous attempt failed: ${msg.slice(0, 1500)}` : null) });
  logEvent(db, 'job.retry', `attempt ${attempts}/${cfg.limits.maxAttempts} failed: ${msg.slice(0, 300)}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
  void project;
}

/** Preserve WIP locally. Blocked, failed and canceled work is never published. */
/** Remember that autodev merged the base into this branch, so the coding agent is told those changes are legitimate. */
export function markBaseRefreshed(ctx: Ctx, job: Job, baseSha: string) {
  kvSet(ctx.db, `base-refreshed:${job.id}`, JSON.stringify({ base: job.base_branch, sha: baseSha }));
}

function baseRefreshNote(ctx: Ctx, job: Job): string | null {
  const raw = kvGet(ctx.db, `base-refreshed:${job.id}`);
  if (!raw) return null;
  const r = JSON.parse(raw) as { base: string; sha: string };
  return `Autodev merged the latest ${r.base} (${r.sha.slice(0, 12)}) into this branch. Every change that came from ${r.base} is legitimate, merged work by other tickets: keep it exactly as it is. Don't delete or revert files you didn't change; if something conflicts or tests now fail, adapt this ticket's change to work with ${r.base}.`;
}

/**
 * Shared by every resume of a blocked job (a human answer, or triage once its fix tickets merged): commit leftover work
 * locally (hardened git; never pushed before validation), then bring the base up to date if it moved (refreshBase keeps
 * its tamper checks). Any failure is returned, never thrown, so the caller can hold the ticket.
 */
export async function prepareResume(ctx: Ctx, job: Job): Promise<{ ok: true; patch: Partial<Job>; note: string; conflict: boolean } | { ok: false; error: string }> {
  if (!job.worktree || !job.base_branch) return { ok: true, patch: {}, note: '', conflict: false };
  try {
    const preserved = await ctx.ws.commitAll(job.worktree, `WIP ${job.ticket_identifier} (autodev: preserved before resuming)`);
    const r = await ctx.ws.refreshBase(job.worktree, job.base_branch);
    const st = ctx.ws.trustedState(job.worktree);
    const changed = preserved || r.status !== 'current' || st.head_sha !== job.candidate_sha;
    const patch: Partial<Job> = changed ? { base_sha: st.base_sha, candidate_sha: st.head_sha, validated_sha: null, reviewed_sha: null, candidate_worktree: null } : {};
    if (r.status === 'current') return { ok: true, patch, note: '', conflict: false };
    markBaseRefreshed(ctx, job, r.baseSha);
    logEvent(ctx.db, 'job.base_refreshed', `${job.ticket_identifier}: merged the latest ${job.base_branch} before resuming${r.status === 'conflict' ? ` (conflicts in ${r.files.join(', ')})` : ''}`, { jobId: job.id, ticketId: job.ticket_id });
    if (r.status === 'conflict') return { ok: true, patch, note: conflictFeedback(job.base_branch, r.files), conflict: true };
    return { ok: true, patch, note: '', conflict: false };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 500) };
  }
}

/** A resume that could not prepare the workspace: keep the job blocked with the reason, once (no retry every tick). */
export async function holdResume(ctx: Ctx, job: Job, b: Blocker, error: string): Promise<void> {
  const reason = { ...b, triageWait: undefined, resumeFailed: error };
  updateJob(ctx.db, job.id, { status: 'blocked', blocked_reason: JSON.stringify(reason) });
  await ctx.tracker.setStatus(job.ticket_id, 'blocked').catch(() => {});
  await ctx.tracker.comment(job.ticket_id, `⏸️ autodev could not resume this ticket: preparing the workspace (saving work in progress and merging the latest ${job.base_branch ?? 'base'}) failed, so nothing was changed or pushed.\n\n\`\`\`\n${error}\n\`\`\`\nA human should check the workspace; move the ticket back to Ready to try again.`).catch(() => {});
  logEvent(ctx.db, 'job.resume_failed', `${job.ticket_identifier}: ${error.split('\n')[0]}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
}

async function preserveWork(ctx: Ctx, job: Job, why: string) {
  if (!job.worktree || !job.branch) return;
  try {
    await ctx.ws.commitAll(job.worktree, `WIP ${job.ticket_identifier} (autodev: ${why})`);
  } catch (e) {
    logEvent(ctx.db, 'preserve.failed', String(e).slice(0, 500), { jobId: job.id, level: 'warn' });
  }
}

export async function blockJob(ctx: Ctx, job: Job, blocker: Blocker) {
  const { db, owner, tracker } = ctx;
  let b = blocker;
  // Save the interrupted run's work as a local commit first, whatever happens next: triage may park or requeue the job
  // without reaching a human, and a later base refresh refuses a dirty workspace. Nothing is pushed unvalidated.
  await preserveWork(ctx, job, 'blocked');
  if (b.triage) {
    const t = await triageBlocker(ctx, job, b).catch((e) => ({ kind: 'human' as const, note: `triage failed: ${(e as Error).message.slice(0, 300)}`, recommendation: null }));
    if (t?.kind === 'resolved') return;
    if (t) b = { ...b, reason: `${b.reason}\n\n**Triage:** ${t.note}`, recommendation: b.recommendation ?? t.recommendation };
  }
  if (!b.decisionId) {
    // Record the open question in the decision log so the answer is kept with it.
    b.decisionId = recordPending(ctx, job, b);
  }
  const body = `🚧 **autodev is blocked** on this ticket.

**Reason:** ${b.reason}

**Question:** ${b.question}
${b.options.length ? `\n**Options:**\n${b.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n` : ''}${b.recommendation ? `\n**Recommendation:** ${b.recommendation}\n` : ''}
Work so far is saved locally on branch \`${job.branch ?? '(none)'}\`.${job.pr_url ? ` Existing PR: ${job.pr_url} (may not contain the local WIP).` : ''}

To continue: reply with a comment starting with \`/answer\` and move this ticket back to **Ready**. ${b.policyHash ? 'This diff-policy blocker requires an explicit /answer approve to accept the exact reviewed diff; otherwise revise the flagged changes.' : 'Moving it to Ready without an answer accepts the recommendation.'}
<!-- autodev:decision:${b.decisionId} -->`;
  await tracker.comment(job.ticket_id, body).catch((err) => logEvent(db, 'linear.error', String(err), { jobId: job.id, level: 'warn' }));
  await tracker.setStatus(job.ticket_id, 'blocked').catch((err) => logEvent(db, 'linear.error', String(err), { jobId: job.id, level: 'warn' }));
  releaseLease(db, job.id, owner, 'blocked', { blocked_reason: JSON.stringify({ ...b, blockedAt: now() }), stage: STAGES.indexOf(job.stage) > STAGES.indexOf('workspace') ? 'workspace' : job.stage });
  logEvent(db, 'job.blocked', `${job.ticket_identifier}: ${b.reason.split('\n')[0]}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
}

function recordPending(ctx: Ctx, job: Job, b: Blocker): string {
  const id = crypto.randomUUID();
  ctx.db.prepare(`INSERT INTO decisions (id, ticket_id, ticket_identifier, repo, question, question_hash, context, alternatives_json, decision, authority, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?, 'pending', 'pending_human', ?)`)
    .run(id, job.ticket_id, job.ticket_identifier, job.repo, b.question, `blocker-${id.slice(0, 8)}`, b.reason, JSON.stringify(b.options.map((name) => ({ name, pros: [], cons: [] }))), b.recommendation, now());
  return id;
}

async function fail(ctx: Ctx, job: Job, message: string) {
  const { db, owner, tracker } = ctx;
  await preserveWork(ctx, job, 'failed');
  releaseLease(db, job.id, owner, 'failed', { error: message, attempts: job.attempts });
  await tracker.comment(job.ticket_id, `❌ autodev could not complete this ticket.\n\n\`\`\`\n${message.slice(0, 2500)}\n\`\`\`\nWork so far is on branch \`${job.branch ?? '(none)'}\`. Move back to **Ready** to retry from scratch.`).catch(() => {});
  await tracker.setStatus(job.ticket_id, 'failed').catch(() => {});
  logEvent(db, 'job.failed', `${job.ticket_identifier}: ${message.slice(0, 300)}`, { jobId: job.id, ticketId: job.ticket_id, level: 'error' });
}

/**
 * Called when a human moves a Blocked ticket back to Ready. Takes the latest human comment after the block
 * (prefer `/answer …`), records the decision, and re-queues the job with the answer as feedback.
 */
export async function resumeBlocked(ctx: Ctx, job: Job, explicitAnswer?: string): Promise<void> {
  const b = JSON.parse(job.blocked_reason ?? '{}') as Blocker & { blockedAt?: number };
  let answer = explicitAnswer;
  if (!answer) {
    const comments = await ctx.tracker.listComments(job.ticket_id);
    const after = comments.filter((c) => !c.byAutomation && Date.parse(c.createdAt) >= (b.blockedAt ?? 0) - 1000);
    const explicit = [...after].reverse().find((c) => c.body.trim().startsWith('/answer'));
    const latest = explicit ?? after[after.length - 1];
    answer = latest ? latest.body.trim().replace(/^\/answer\s*/, '') : b.recommendation ? `Proceed with the recommendation: ${b.recommendation}` : 'Proceed using your best judgment within the approved requirements.';
  }
  const ticket = await ctx.tracker.getTicket(job.ticket_id);
  const approved = !!b.policyHash && /^\s*(approve|accept)(?:\s|$)/i.test(answer);
  if (approved) {
    kvSet(ctx.db, `policy-approved:${job.id}:${b.policyHash}`, 'human');
    if (b.policyFingerprint && b.policyReasons) kvSet(ctx.db, `policy-approved-change:${job.id}:${b.policyFingerprint}`, JSON.stringify(b.policyReasons));
  }
  recordHumanDecision(ctx, b.decisionId ?? null, answer, { ticket: ticket ?? undefined, repo: job.repo, question: b.question });
  const prep = await prepareResume(ctx, job);
  if (!prep.ok) return holdResume(ctx, job, b, prep.error);
  updateJob(ctx.db, job.id, {
    ...prep.patch,
    status: 'queued', blocked_reason: null, attempts: 0, fix_attempts: 0, review_cycles: 0, decision_count: Math.max(0, job.decision_count - 1),
    pending_feedback: `A human answered the blocking question.\nQuestion: ${b.question}\nAnswer: ${answer}\nContinue the implementation accordingly.${prep.note ? `\n\n${prep.note}` : ''}`,
    // A conflicting base merge leaves markers for the coding agent to resolve, so it always goes back through coding
    // (stage 'workspace'), even after a policy approval that would otherwise go straight to validation.
    ...(prep.conflict ? { stage: 'workspace' as const } : approved ? { stage: 'implement' as const } : {}),
  });
  await ctx.tracker.setStatus(job.ticket_id, 'in_progress').catch(() => {});
  logEvent(ctx.db, 'job.unblocked', `${job.ticket_identifier}: human answer recorded`, { jobId: job.id, ticketId: job.ticket_id });
}

/** CLI path: answer a blocked ticket directly (recorded as a human decision). */
export async function answerBlocked(ctx: Ctx, job: Job, answer: string): Promise<void> {
  await resumeBlocked(ctx, job, answer);
  await ctx.tracker.comment(job.ticket_id, `💬 Answer recorded via CLI: ${answer}`).catch(() => {});
}

// ---------------- helpers ----------------

/** "removed N vs added M" when a diff deletes more assertions than it adds in test files; '' otherwise. */
export function assertionDelta(diff: string): string {
  let file = ''; let removed = 0; let added = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4); continue; }
    if (!/(test|spec)/i.test(file)) continue;
    if (/\b(expect|assert\w*|should)\b/.test(l)) {
      if (l.startsWith('-') && !l.startsWith('---')) removed++;
      else if (l.startsWith('+')) added++;
    }
  }
  return removed > added ? `removed ${removed} vs added ${added}` : '';
}

async function prBody(ctx: Ctx, job: Job, ticket: Ticket, preview: string | null, state: string): Promise<string> {
  const s = JSON.parse(job.summary_json ?? '{}') as { coding?: CodingResult; review?: Review; ci?: string };
  const decisions = decisionsForTicket(ctx, ticket.id).filter((d) => d.status === 'resolved');
  const files = job.worktree && job.base_branch ? await ctx.ws.changedFiles(job.worktree, job.base_branch).catch(() => []) : [];
  const project = ctx.cfg.projects.find((p) => p.key === job.project)!;
  return `Linear: [${ticket.identifier}](${ticket.url}) — ${ticket.title}
Status: **${state}** · autodev job \`${job.id.slice(0, 8)}\`${preview ? `\nPreview: ${preview}` : ''}

## Summary
${s.coding?.summary ?? '_in progress_'}

## Files changed
${files.length ? files.map((f) => `- \`${f}\``).join('\n') : '_pending_'}

## Technical decisions
${[...(s.coding?.decisions ?? []).map((d) => `- ${d}`), ...decisions.map((d) => `- ${d.question} → **${d.decision}** (${d.authority}${d.adr_path ? `, ADR \`${d.adr_path}\`` : ''})`)].join('\n') || '- none'}

## Tests
${(s.coding?.testsAdded ?? []).map((t) => `- added: ${t}`).join('\n')}
${project.validate.map((c) => `- \`${c}\` ✅ (run by orchestrator)`).join('\n')}
- CI: ${s.ci ?? 'pending'}

## AI review
${s.review ? `**${s.review.outcome}** — ${s.review.summary}\n${s.review.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.issue}`).join('\n')}` : '_pending_'}

## Known limitations
${(s.coding?.knownLimitations ?? []).map((l) => `- ${l}`).join('\n') || '- none reported'}

## How to test
${preview ? `Open the preview: ${preview}` : `\`git fetch origin && git switch ${job.branch}\`, then: ${project.setup.concat(project.validate).map((c) => `\`${c}\``).join(', ') || 'run the app'}.`}

---
🤖 Generated by autodev using [Claude Code](https://claude.com/claude-code). Merge authority stays with a human.`;
}

export type { PullRequest };
