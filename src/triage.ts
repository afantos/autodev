import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { kvGet, kvSet, logEvent, releaseLease, updateJob } from './db.ts';
import { recordTriageDecision } from './decisions.ts';
import { tail } from './exec.ts';
import { cachedVerdict, reservedReview } from './external-review.ts';
import { ClearanceSchema, EvidenceSchema, TriageSchema, clearanceTask, evidenceTask, flaggedReviewTask, taskBytes, triageTask } from './agents/triage.ts';
import type { CheckResult, Clearance, FlaggedReview, KeywordMatch, StructuredTask, Triage, TriageCandidateTicket } from './agents/triage.ts';
import { onlyKeywordFindings } from './policy.ts';
import type { PolicyInspection } from './policy.ts';
import { holdResume, prepareResume, projectEnv } from './pipeline.ts';
import type { Blocker } from './pipeline.ts';
import { LABEL_SUGGESTED } from './tracker/types.ts';
import { STAGES } from './types.ts';
import type { Job, Ticket } from './types.ts';

/**
 * Triage: before a blocker reaches the human, the second-review model classifies it and code decides what may happen.
 *
 * Allowed without a human (each bound to the exact diff, ticket or candidate, and charged to the second-review caps):
 *  - Keyword-only policy flags (the HUMAN_PATTERNS heuristic, nothing else) are cleared for the exact diff hash when the
 *    model judges every matched line a mention, not a restricted change. Normal CI and both reviews still apply.
 *  - Factual questions are answered with evidence: the model proposes checks, autodev runs them in the command sandbox
 *    on a throwaway copy of the candidate, records commands and results, and the model evaluates them. Only a
 *    conclusive answer resumes the work.
 *  - Defects in existing code are sequenced: fix tickets suggested from this ticket's own work are promoted (or one new
 *    fix ticket is created) and made prerequisites; the job waits, then resumes on a refreshed base.
 * Never: product or requirement changes, accepting broken behavior, security rules, budgets, paid services, CI,
 * protected files, dependency or test-policy flags, or merging. Those, and anything uncertain, go to the human with
 * the model's recommendation. Each job gets at most `maxPerJob` resolutions and each question one triage.
 */

export type TriageOutcome = { kind: 'resolved' } | { kind: 'human'; note: string; recommendation: string | null };

export function triageEnabled(ctx: Ctx, project: ProjectConfig | undefined): boolean {
  const r = ctx.secondReviewer;
  return !!project?.autoMerge && ctx.cfg.secondReview.enabled && ctx.cfg.secondReview.triage.enabled && !!r?.ask && !!r.maxAskCostUsd;
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

type Asked<T> = { kind: 'ok'; value: T; model: string } | { kind: 'waiting' } | { kind: 'failed'; message: string };

/** One triage request under the shared second-review budget rules, cached per key. */
async function ask<T>(ctx: Ctx, job: Job, key: string, event: string, task: StructuredTask<T>, describe: (v: T) => { outcome: string; summary: string }): Promise<Asked<T>> {
  const reviewer = ctx.secondReviewer!;
  const cached = cachedVerdict(ctx, job, key, task.parser, event);
  if (cached) return { kind: 'ok', value: cached, model: reviewer.model };
  const bytes = taskBytes(task);
  if (bytes > ctx.cfg.secondReview.maxInputChars) return { kind: 'failed', message: `request too large (${bytes} bytes)` };
  const r = await reservedReview(ctx, job, shortHash(key), event, `${event}-failures`, reviewer.maxAskCostUsd!(task), async () => {
    const out = await reviewer.ask!(task);
    return { ...out, ...describe(out.value) };
  });
  if (r.kind !== 'ok') return r;
  kvSet(ctx.db, key, JSON.stringify(r.value));
  return { kind: 'ok', value: r.value, model: reviewer.model };
}

// ---------------------------------------------------------------- keyword-flag clearance

export type ClearanceOutcome = { kind: 'cleared'; note: string } | { kind: 'human'; note: string } | { kind: 'waiting' };

const clearedKey = (job: Job, hash: string) => `policy-cleared:${job.id}:${hash}`;
export const isCleared = (ctx: Ctx, job: Job, policy: PolicyInspection) => !!kvGet(ctx.db, clearedKey(job, policy.hash));

/** Enforced in code: "clear" only if the model judged every match, each exactly once, as not restricted. */
export function clearanceAccepted(v: Clearance, matches: KeywordMatch[]): boolean {
  if (v.verdict !== 'clear' || v.matches.length !== matches.length) return false;
  const ids = new Set(matches.map((m) => m.id));
  const seen = new Set<string>();
  for (const m of v.matches) {
    if (!ids.has(m.id) || seen.has(m.id) || m.restricted) return false;
    seen.add(m.id);
  }
  return seen.size === ids.size;
}

export async function clearKeywordFlags(ctx: Ctx, job: Job, project: ProjectConfig, policy: PolicyInspection): Promise<ClearanceOutcome> {
  if (!triageEnabled(ctx, project) || !onlyKeywordFindings(policy)) return { kind: 'human', note: 'not eligible for triage' };
  if (isCleared(ctx, job, policy)) return { kind: 'cleared', note: 'cleared earlier for this exact diff' };
  const count = Number(kvGet(ctx.db, `triage-count:${job.id}`) ?? 0);
  if (count >= ctx.cfg.secondReview.triage.maxPerJob) return { kind: 'human', note: `triage already resolved ${count} blocker(s) on this job (limit ${ctx.cfg.secondReview.triage.maxPerJob})` };
  const limit = ctx.cfg.secondReview.triage.maxKeywordMatches;
  if (policy.keywordMatches.length > limit) return { kind: 'human', note: `${policy.keywordMatches.length} keyword matches (more than ${limit}) are not treated as incidental` };
  const matches: KeywordMatch[] = policy.keywordMatches.map((m, i) => ({ id: `m${i + 1}`, ...m }));
  const ticket = (await ctx.tracker.getTicket(job.ticket_id))!;
  const diff = await ctx.ws.diff(job.worktree!, job.base_branch!);
  const task = clearanceTask({ repo: job.repo, ticket, candidateSha: job.candidate_sha!, matches, diff });
  const r = await ask(ctx, job, `triage-clearance:${job.id}:${policy.hash}`, 'triage.clearance', task, (v) => ({ outcome: v.verdict, summary: v.summary }));
  if (r.kind === 'waiting') return { kind: 'waiting' };
  if (r.kind === 'failed') return { kind: 'human', note: `triage unavailable: ${r.message.slice(0, 300)}` };
  const v = r.value;
  const detail = v.matches.map((m) => `- ${m.id} ${m.restricted ? 'restricted' : 'mention'}: ${m.explanation}`).join('\n');
  if (!clearanceAccepted(v, matches)) return { kind: 'human', note: `${r.model} did not clear the flag(s): ${v.summary}\n${detail}` };
  kvSet(ctx.db, clearedKey(job, policy.hash), JSON.stringify({ model: r.model, summary: v.summary }));
  kvSet(ctx.db, `triage-count:${job.id}`, String(count + 1));
  const categories = [...new Set(matches.map((m) => m.category))].join(', ');
  logEvent(ctx.db, 'triage.policy_cleared', `${job.ticket_identifier}: keyword flag(s) [${categories}] cleared for diff ${policy.hash.slice(0, 12)} by ${r.model}`, { jobId: job.id, ticketId: job.ticket_id });
  await ctx.tracker.comment(job.ticket_id, `🧭 **Triage (${r.model})** cleared the diff-policy keyword flag(s) [${categories}] for diff ${policy.hash.slice(0, 12)}: they are mentions, not restricted changes. CI and both reviews still apply.\n\n${v.summary}\n${matches.map((m) => `- ${m.id} \`${m.file}\`: ${m.text}`).join('\n')}`).catch(() => {});
  return { kind: 'cleared', note: v.summary };
}

// ---------------------------------------------------------------- flagged-diff approval by the second reviewer

/**
 * flaggedDiffApprover 'second-review': the owner delegated approval of policy-flagged diffs to the second reviewer.
 * Eligible only with autoMerge and a second reviewer, and only when the changed files are known and none matches
 * alwaysHumanPaths (fail closed). Approval is bound to the exact diff hash, like a human `/answer approve`.
 */
export function aiApprovalEligible(ctx: Ctx, project: ProjectConfig | undefined, policy: PolicyInspection): boolean {
  if (!project || project.flaggedDiffApprover !== 'second-review' || !project.autoMerge || !ctx.cfg.secondReview.enabled) return false;
  const r = ctx.secondReviewer;
  if (!r?.ask || !r.maxAskCostUsd || !policy.reasons.length || !policy.files) return false;
  return !policy.files.some((f) => project.alwaysHumanPaths.some((p) => new RegExp(p).test(f)));
}

/**
 * What an approval covers: the exact diff hash AND the findings judged AND the ticket requirements (description and
 * recorded decisions). A new finding (e.g. a config change adds a protected path) or a clarified ticket asks again.
 */
const approvalScope = (policy: PolicyInspection, requirements: string) =>
  createHash('sha256').update(policy.hash).update('\0').update(JSON.stringify([...policy.reasons].sort())).update('\0').update(requirements).digest('hex');
const aiApprovedKey = (job: Job, scope: string) => `policy-ai-approved:${job.id}:${scope}`;
export const isAiApproved = (ctx: Ctx, job: Job, policy: PolicyInspection, requirements: string) => !!kvGet(ctx.db, aiApprovedKey(job, approvalScope(policy, requirements)));

/** Enforced in code: approve only if the model accepted every finding, each exactly once. */
export function flaggedReviewAccepted(v: FlaggedReview, ids: string[]): boolean {
  if (v.verdict !== 'approve' || v.findings.length !== ids.length) return false;
  const want = new Set(ids);
  const seen = new Set<string>();
  for (const f of v.findings) {
    if (!want.has(f.id) || seen.has(f.id) || !f.acceptable) return false;
    seen.add(f.id);
  }
  return seen.size === want.size;
}

export type FlaggedApprovalOutcome = { kind: 'approved'; note: string } | { kind: 'human'; note: string } | { kind: 'waiting' };

export async function approveFlaggedDiff(ctx: Ctx, job: Job, project: ProjectConfig, policy: PolicyInspection, decisions: { question: string; decision: string }[], requirements: string): Promise<FlaggedApprovalOutcome> {
  if (!aiApprovalEligible(ctx, project, policy)) return { kind: 'human', note: 'not eligible for second-review approval' };
  const scope = approvalScope(policy, requirements);
  if (isAiApproved(ctx, job, policy, requirements)) return { kind: 'approved', note: 'approved earlier for this exact diff, findings and requirements' };
  const findings = policy.reasons.map((reason, i) => ({ id: `f${i + 1}`, reason }));
  const ticket = (await ctx.tracker.getTicket(job.ticket_id))!;
  const diff = await ctx.ws.diff(job.worktree!, job.base_branch!);
  const task = flaggedReviewTask({ repo: job.repo, ticket, candidateSha: job.candidate_sha!, findings, decisions, diff });
  const r = await ask(ctx, job, `flagged-review:${job.id}:${scope}`, 'policy.ai_review', task, (v) => ({ outcome: v.verdict, summary: v.summary }));
  if (r.kind === 'waiting') return { kind: 'waiting' };
  if (r.kind === 'failed') return { kind: 'human', note: `second-review approval unavailable: ${r.message.slice(0, 300)}` };
  const v = r.value;
  const detail = v.findings.map((f) => `- ${f.id} ${f.acceptable ? 'acceptable' : 'NOT acceptable'}: ${f.explanation}`).join('\n');
  if (!flaggedReviewAccepted(v, findings.map((f) => f.id))) {
    logEvent(ctx.db, 'policy.ai_escalated', `${job.ticket_identifier}: ${r.model} did not approve flagged diff ${policy.hash.slice(0, 12)}: ${v.summary.slice(0, 200)}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
    return { kind: 'human', note: `${r.model} did not approve the flagged change(s): ${v.summary}\n${detail}` };
  }
  kvSet(ctx.db, aiApprovedKey(job, scope), JSON.stringify({ model: r.model, summary: v.summary, hash: policy.hash, reasons: policy.reasons }));
  logEvent(ctx.db, 'policy.ai_approved', `${job.ticket_identifier}: flagged diff ${policy.hash.slice(0, 12)} approved by ${r.model} (owner-delegated): ${policy.reasons.length} finding(s)`, { jobId: job.id, ticketId: job.ticket_id });
  await ctx.tracker.comment(job.ticket_id, `🛡️ **Flagged-diff approval (${r.model}, delegated by the owner)** for diff ${policy.hash.slice(0, 12)}. CI, the Claude review and the second review still apply.\n\n${v.summary}\n${findings.map((f) => `- ${f.reason}`).join('\n')}`).catch(() => {});
  return { kind: 'approved', note: v.summary };
}

// ---------------------------------------------------------------- blocking questions

/** Events that start a new attempt on a job: suggestions older than the latest one may already have been seen and held. */
const ATTEMPT_START = ['job.claimed', 'job.unblocked', 'triage.resolved', 'triage.prerequisites_merged'];

/**
 * The only tickets triage may promote or depend on: suggested (labelled and marked) from this ticket by THIS job during
 * its CURRENT attempt, so the owner can't have reviewed and held them yet, with no human comment (any human comment is
 * the owner's call, e.g. "keep this in Backlog") and no hold label.
 */
export async function eligibleFixTickets(ctx: Ctx, job: Job, ticket: Ticket): Promise<Ticket[]> {
  const since = (ctx.db.prepare(`SELECT MAX(ts) AS t FROM events WHERE job_id = ? AND type IN (${ATTEMPT_START.map(() => '?').join(',')})`).get(job.id, ...ATTEMPT_START) as { t: number | null }).t ?? 0;
  const fresh = new Set((ctx.db.prepare(`SELECT message FROM events WHERE job_id = ? AND type = 'ticket.suggested' AND ts >= ?`).all(job.id, since) as { message: string }[]).map((r) => r.message.split(':')[0]!));
  const all = await ctx.tracker.listTickets({ projectKey: job.project });
  const out: Ticket[] = [];
  for (const t of all) {
    if (!fresh.has(t.identifier) || !t.labels.includes(LABEL_SUGGESTED) || !t.description.includes(`while working on ${ticket.identifier}.`)) continue;
    if (!['backlog', 'ready'].includes(t.status) || t.labels.some((l) => /hold/i.test(l))) continue;
    if ((await ctx.tracker.listComments(t.id)).some((c) => !c.byAutomation)) continue;
    out.push(t);
  }
  return out;
}

export async function triageBlocker(ctx: Ctx, job: Job, b: Blocker): Promise<TriageOutcome | null> {
  const { db, cfg } = ctx;
  const project = cfg.projects.find((p) => p.key === job.project);
  if (!b.triage || !triageEnabled(ctx, project) || !job.worktree || !job.base_branch || !job.candidate_sha) return null;
  const limits = cfg.secondReview.triage;
  const count = Number(kvGet(db, `triage-count:${job.id}`) ?? 0);
  if (count >= limits.maxPerJob) return { kind: 'human', note: `triage already resolved ${count} blocker(s) on this job (limit ${limits.maxPerJob})`, recommendation: null };
  const q = shortHash(b.question);
  if (kvGet(db, `triage-seen:${job.id}:${q}`)) return { kind: 'human', note: 'triage already handled this same question once', recommendation: null };
  kvSet(db, `triage-seen:${job.id}:${q}`, '1');

  const ticket = (await ctx.tracker.getTicket(job.ticket_id))!;
  const candidates = await eligibleFixTickets(ctx, job, ticket);
  let diff = await ctx.ws.diff(job.worktree, job.base_branch);
  if (diff.length > limits.maxDiffChars) diff = `${diff.slice(0, limits.maxDiffChars)}\n[diff truncated at ${limits.maxDiffChars} characters]`;
  const task = triageTask({
    repo: job.repo, ticket, candidateSha: job.candidate_sha, question: b.question, context: b.reason, diff,
    candidates: candidates.map((t): TriageCandidateTicket => ({ identifier: t.identifier, title: t.title, status: t.status, description: t.description })),
    validate: project!.validate, maxChecks: limits.maxChecks,
  });
  const r = await ask(ctx, job, `triage-blocker:${job.id}:${q}`, 'triage.blocker', task, (v) => ({ outcome: v.kind, summary: v.summary }));
  if (r.kind !== 'ok') return { kind: 'human', note: `triage unavailable: ${r.kind === 'failed' ? r.message.slice(0, 300) : 'second-review budget reached'}`, recommendation: null };
  const v = r.value;
  const human = (note: string): TriageOutcome => ({ kind: 'human', note: `${r.model} classified this as ${v.kind}: ${v.summary}${note ? `\n${note}` : ''}`, recommendation: v.recommendation || null });
  if (v.kind === 'factual') return verifyFactual(ctx, job, project!, ticket, b, v, r.model, count, human);
  if (v.kind === 'defect') return sequenceDefect(ctx, job, ticket, b, v, candidates, r.model, count, human);
  return human('');
}

const validCommand = (c: string) => c.trim().length > 0 && c.length <= 400 && !/[\r\n\0]/.test(c);

async function verifyFactual(ctx: Ctx, job: Job, project: ProjectConfig, ticket: Ticket, b: Blocker, v: Triage, model: string, count: number, human: (note: string) => TriageOutcome): Promise<TriageOutcome> {
  const { cfg, ws, db } = ctx;
  const limits = cfg.secondReview.triage;
  if (!v.claim.trim() || !v.checks.length) return human('No checks were proposed.');
  if (v.checks.length > limits.maxChecks) return human(`${v.checks.length} checks proposed (limit ${limits.maxChecks}).`);
  const bad = v.checks.find((c) => !validCommand(c.command));
  if (bad) return human(`A proposed check is not a single command line: ${JSON.stringify(bad.command.slice(0, 120))}`);

  // Run every check in the command sandbox on a throwaway copy of the candidate, never in the job's worktree.
  // A validated snapshot when there is one; otherwise (a coding-agent question) the trusted head, which includes the
  // run's preserved work in progress.
  const sha = job.candidate_worktree ? job.candidate_sha! : ws.trustedState(job.worktree!).head_sha;
  const source = job.candidate_worktree ?? await ws.candidateSnapshot(job.worktree!, sha);
  const dir = join(cfg.workspaceDir!, 'triage', `${job.ticket_identifier}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(cfg.workspaceDir!, 'triage'), { recursive: true });
  cpSync(source, dir, { recursive: true, verbatimSymlinks: true });
  const results: CheckResult[] = [];
  try {
    const env = projectEnv(project, job);
    const opts = { npmCacheDir: project.npmCacheDir ? resolve(cfg.configDir, project.npmCacheDir) : undefined };
    if (!job.candidate_worktree) {
      for (const cmd of project.setup) {
        const s = await ctx.runCommand(cmd, dir, env, 20 * 60_000, AbortSignal.timeout(20 * 60_000), opts);
        if (s.code !== 0) return human(`Setup for the checks failed: ${cmd} (exit ${s.code}).`);
      }
    }
    for (const c of v.checks) {
      const t0 = Date.now();
      const timeout = limits.checkTimeoutSeconds * 1000;
      const out = await ctx.runCommand(c.command, dir, env, timeout, AbortSignal.timeout(timeout + 5_000), opts);
      results.push({ purpose: c.purpose.slice(0, 200), command: c.command, exitCode: out.code, timedOut: !!out.timedOut, durationMs: Date.now() - t0, output: tail(`${out.stdout}\n${out.stderr}`, 3_000) });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const q = shortHash(b.question);
  kvSet(db, `triage-evidence:${job.id}:${q}`, JSON.stringify({ sha, results }));
  logEvent(db, 'triage.checks', `${job.ticket_identifier}: ran ${results.length} check(s) on ${sha.slice(0, 12)}: ${results.map((x) => `${x.command.slice(0, 80)} → ${x.exitCode}`).join('; ')}`, { jobId: job.id, ticketId: job.ticket_id });

  const evidence = `Candidate ${sha.slice(0, 12)}:\n${results.map((x) => `$ ${x.command}\n  → exit ${x.exitCode}${x.timedOut ? ' (timed out)' : ''}: ${x.output.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`).join('\n')}`;
  const e = await ask(ctx, job, `triage-evidence-verdict:${job.id}:${q}`, 'triage.evidence', evidenceTask({ repo: job.repo, ticket, candidateSha: sha, question: b.question, claim: v.claim, results }), (x) => ({ outcome: x.conclusive ? 'conclusive' : 'inconclusive', summary: x.summary }));
  if (e.kind !== 'ok') return human(`The checks ran, but evaluating them failed.\n${evidence}`);
  const answer = e.value.answer.trim();
  if (!e.value.conclusive || !answer) return human(`The checks were not conclusive: ${e.value.summary}\n${evidence}`);
  if (/^\s*(approve|accept)\b/i.test(answer)) return human('The proposed answer reads as an approval, which triage may not give.');
  await resumeAfterTriage(ctx, job, b, model, count, `Verified by autodev triage (${model}) on candidate ${sha.slice(0, 12)}:\n${answer}`, `${answer}\n\n**Evidence (commands run in the sandbox):**\n\`\`\`\n${evidence}\n\`\`\``);
  return { kind: 'resolved' };
}

async function sequenceDefect(ctx: Ctx, job: Job, ticket: Ticket, b: Blocker, v: Triage, candidates: Ticket[], model: string, count: number, human: (note: string) => TriageOutcome): Promise<TriageOutcome> {
  const { db, tracker } = ctx;
  if (!v.instructions.trim()) return human('No follow-up instructions for this ticket were given.');
  const allowed = new Map(candidates.map((t) => [t.identifier, t]));
  const outside = v.fixTickets.filter((id) => !allowed.has(id));
  if (outside.length) return human(`Proposed fix tickets outside the allowed set (suggested from ${ticket.identifier} in this attempt, with no owner comment or hold): ${outside.join(', ')}.`);
  if (v.fixTickets.length > 3) return human(`${v.fixTickets.length} fix tickets proposed (limit 3).`);
  let fixes = [...new Set(v.fixTickets)].map((id) => allowed.get(id)!);
  if (!fixes.length) {
    if (!v.newTicket?.title.trim() || !v.newTicket.description.trim()) return human('No fix ticket was named or proposed.');
    if (kvGet(db, `triage-created:${job.id}`)) return human('Triage already created a fix ticket for this job.');
    const created = await tracker.createTicket({
      projectKey: job.project, title: v.newTicket.title.trim().slice(0, 120), status: 'ready', priority: ticket.priority, labels: [LABEL_SUGGESTED],
      description: `${v.newTicket.description.trim()}\n\n---\nSuggested automatically while working on ${ticket.identifier}. Created by autodev triage (${model}) as a prerequisite fix.`,
    });
    kvSet(db, `triage-created:${job.id}`, created.identifier);
    logEvent(db, 'ticket.suggested', `${created.identifier}: ${created.title} (triage prerequisite for ${ticket.identifier})`, { jobId: job.id, ticketId: ticket.id });
    fixes = [created];
  }
  for (const f of fixes) {
    if (f.status === 'backlog') await tracker.setStatus(f.id, 'ready');
    await tracker.addBlockedBy(ticket.id, f.id);
  }
  const ids = fixes.map((f) => f.identifier).join(', ');
  const answer = `Triage decision (${model}): ${ids} fix the underlying defect first and are prerequisites of this ticket. After they merge, the branch is refreshed with ${job.base_branch} and work resumes. Then: ${v.instructions.trim()}\nDo not keep workarounds or skips for that defect.`;
  recordTriageDecision(ctx, job, b.question, answer, model);
  kvSet(db, `triage-count:${job.id}`, String(count + 1));
  // Park the job as blocked (it holds no concurrency slot, so the fixes can run) until every fix ticket is Done;
  // reconcile then resumes it on a refreshed base (resumeIfFixesMerged).
  releaseLease(db, job.id, ctx.owner, 'blocked', {
    blocked_reason: JSON.stringify({ ...b, triageWait: { tickets: fixes.map((f) => f.id), answer }, blockedAt: Date.now() }), error: null,
    stage: STAGES.indexOf(job.stage) > STAGES.indexOf('workspace') ? 'workspace' : job.stage,
  });
  await tracker.setStatus(ticket.id, 'blocked').catch(() => {});
  await tracker.comment(ticket.id, `🧭 **autodev triage (${model})** found a defect in existing code behind this blocker. ${ids} ${fixes.length > 1 ? 'are' : 'is'} now ${fixes.length > 1 ? 'prerequisites' : 'a prerequisite'} and ${fixes.length > 1 ? 'go' : 'goes'} through the normal gates first; this ticket resumes automatically once ${fixes.length > 1 ? 'they have' : 'it has'} merged.\n\n**Question:** ${b.question}\n\n**Plan:** ${answer}\n\n${v.summary}`).catch(() => {});
  logEvent(db, 'triage.sequenced', `${job.ticket_identifier}: waiting for ${ids} (defect fix first)`, { jobId: job.id, ticketId: job.ticket_id });
  return { kind: 'resolved' };
}

/**
 * Reconcile hook: a job parked by sequenceDefect resumes once every fix ticket is Done. The branch is first refreshed
 * with the base so it contains the fixes (no worker holds a parked job, so this is safe here); conflicts go to the
 * coding agent like any base merge.
 */
export async function resumeIfFixesMerged(ctx: Ctx, job: Job, ticketById: (id: string) => Promise<Ticket | null>): Promise<boolean> {
  const b = JSON.parse(job.blocked_reason ?? '{}') as Blocker & { triageWait?: { tickets: string[]; answer: string } };
  if (!b.triageWait) return false;
  for (const id of b.triageWait.tickets) if ((await ticketById(id))?.status !== 'done') return false;
  const prep = await prepareResume(ctx, job);
  if (!prep.ok) { await holdResume(ctx, job, b, prep.error); return true; }
  const feedback = `Autodev triage answered a blocking question.\nQuestion: ${b.question}\nAnswer: ${b.triageWait.answer}\nContinue the implementation accordingly.${prep.note ? `\n\n${prep.note}` : ''}`;
  logEvent(ctx.db, 'triage.base_refreshed', `${job.ticket_identifier}: ${prep.patch.base_sha && prep.patch.base_sha !== job.base_sha ? `merged the latest ${job.base_branch}` : `already on the latest ${job.base_branch}`}`, { jobId: job.id, ticketId: job.ticket_id });
  updateJob(ctx.db, job.id, { ...prep.patch, status: 'queued', stage: 'workspace', blocked_reason: null, attempts: 0, fix_attempts: 0, review_cycles: 0, pending_feedback: feedback });
  await ctx.tracker.setStatus(job.ticket_id, 'in_progress').catch(() => {});
  await ctx.tracker.comment(job.ticket_id, '🧭 The prerequisite fix ticket(s) merged. autodev refreshes this branch with them and resumes the work.').catch(() => {});
  logEvent(ctx.db, 'triage.prerequisites_merged', `${job.ticket_identifier}: prerequisites merged; resuming`, { jobId: job.id, ticketId: job.ticket_id });
  return true;
}

/** Record the triage answer as a decision and requeue the job with it as feedback (like a human /answer, but marked triage). */
async function resumeAfterTriage(ctx: Ctx, job: Job, b: Blocker, model: string, count: number, answer: string, comment: string) {
  const { db, owner, tracker } = ctx;
  recordTriageDecision(ctx, job, b.question, answer, model);
  kvSet(db, `triage-count:${job.id}`, String(count + 1));
  releaseLease(db, job.id, owner, 'queued', {
    blocked_reason: null, error: null, attempts: 0, fix_attempts: 0, review_cycles: 0,
    pending_feedback: `Autodev triage answered a blocking question.\nQuestion: ${b.question}\nAnswer: ${answer}\nContinue the implementation accordingly.`,
    stage: STAGES.indexOf(job.stage) > STAGES.indexOf('workspace') ? 'workspace' : job.stage,
  });
  await tracker.comment(job.ticket_id, `🧭 **autodev triage (${model}) resolved a blocking question** instead of asking a human.\n\n**Question:** ${b.question}\n\n**Answer:** ${comment}\n\nWork continues through the normal gates. Reply with a comment and move the ticket to Blocked if this is wrong.`).catch(() => {});
  logEvent(db, 'triage.resolved', `${job.ticket_identifier}: ${answer.split('\n')[0]!.slice(0, 200)}`, { jobId: job.id, ticketId: job.ticket_id });
}
