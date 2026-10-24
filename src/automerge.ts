import type { ProjectConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { externalSpentSince, kvGet, kvSet, logEvent, recordExternalUsage, updateJob } from './db.ts';
import { startOfDay, startOfMonth } from './budget.ts';
import { inspectChanges } from './policy.ts';
import type { SecondReviewVerdict } from './agents/second-review.ts';
import type { Job, Ticket } from './types.ts';

/**
 * Merge a finished PR without a human, but only when every gate holds for the exact validated candidate:
 *  1. the PR head is the candidate autodev validated and Claude approved (nothing pushed from outside);
 *  2. the branch contains the current base (otherwise base is merged in and the job is revalidated end to end);
 *  3. required CI passed on that head;
 *  4. the mandatory diff policy flags nothing (dependencies, protected paths, existing tests, security keywords);
 *  5. an independent second reviewer (another vendor's model) approves.
 * Then the reviewer account approves that sha and the coding bot squash-merges it, pinned to that sha.
 * Anything else holds the PR for a human with a one-time explanation; nothing here bypasses a check.
 */
export async function autoMergeStep(ctx: Ctx, job: Job, ticket: Ticket, project: ProjectConfig): Promise<'merged' | 'requeued' | 'waiting' | 'held' | 'skipped'> {
  const { cfg, db, scm, ws, tracker } = ctx;
  const reviewer = ctx.secondReviewer;
  if (!project.autoMerge || !cfg.secondReview.enabled || !reviewer) return 'skipped';
  if (job.status !== 'awaiting_merge' || !job.pr_number || !job.worktree || !job.base_branch) return 'skipped';
  const sha = job.candidate_sha;
  const hold = async (reason: string): Promise<'held'> => {
    const key = `automerge-hold:${job.id}:${sha}`;
    if (kvGet(db, key) !== reason) {
      kvSet(db, key, reason);
      logEvent(db, 'automerge.hold', `${job.ticket_identifier}: ${reason.split('\n')[0]}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
      await tracker.comment(ticket.id, `⏸️ Auto-merge is on hold for PR #${job.pr_number}; a human needs to review it.\n\n${reason}`).catch(() => {});
    }
    return 'held';
  };
  const requeue = async (patch: Partial<Job>, event: string, note: string): Promise<'requeued'> => {
    updateJob(db, job.id, { status: 'queued', lease_owner: null, lease_expires_at: null, validated_sha: null, reviewed_sha: null, candidate_worktree: null, ...patch });
    await tracker.setStatus(ticket.id, 'in_progress').catch(() => {});
    await tracker.comment(ticket.id, note).catch(() => {});
    logEvent(db, event, `${job.ticket_identifier}: ${note.split('\n')[0]}`, { jobId: job.id, ticketId: job.ticket_id });
    return 'requeued';
  };

  const pr = await scm.getPr(job.repo, job.pr_number);
  if (pr.state !== 'open') return 'skipped';
  if (!sha || pr.headSha !== sha) return hold(`The PR head (${pr.headSha.slice(0, 12)}) is not the candidate autodev validated (${(sha ?? 'none').slice(0, 12)}). Something was pushed outside autodev.`);
  if (job.validated_sha !== sha || job.reviewed_sha !== sha) return hold('The candidate lacks recorded validation or Claude review approval.');
  try {
    await ws.assertCandidate(job.worktree, sha);
  } catch (e) {
    return hold(`The workspace no longer matches the candidate: ${(e as Error).message}`);
  }

  // 2. Up to date with base. Never merge a candidate that was validated against an older base.
  const baseHead = await scm.branchSha(job.repo, job.base_branch);
  if (baseHead !== job.base_sha) {
    if (job.fix_attempts >= cfg.limits.maxFixAttempts) return hold(`${job.base_branch} moved, but the fix-attempt limit (${cfg.limits.maxFixAttempts}) is used up, so the branch can't be updated automatically.`);
    const r = await ws.refreshBase(job.worktree, job.base_branch);
    if (r.status === 'merged') {
      return requeue({ stage: 'implement', candidate_sha: r.headSha, base_sha: r.baseSha },
        'automerge.refresh', `🔄 ${job.base_branch} moved since this PR was validated. autodev merged it into the branch cleanly and is revalidating (checks, CI, review) before any merge.`);
    }
    if (r.status === 'conflict') {
      return requeue({ stage: 'workspace', base_sha: r.baseSha, fix_attempts: job.fix_attempts + 1, pending_feedback: conflictFeedback(job.base_branch, r.files) },
        'automerge.conflict', `🔀 Merging the latest ${job.base_branch} conflicts in ${r.files.map((f) => `\`${f}\``).join(', ')}. The coding agent will resolve it, then everything is revalidated.`);
    }
  }

  // 3. CI on this exact head.
  const checks = await scm.checks(job.repo, pr, project.requiredChecks);
  if (checks.state === 'pending') return 'waiting';
  if (checks.state !== 'success' && !(checks.state === 'none' && !project.requiredChecks.length)) return hold(`CI is not green on ${sha.slice(0, 12)} (${checks.state}).`);

  // 4. Mandatory policy: flagged changes always go to a human, even if a human approved them earlier.
  const policy = await inspectChanges(ws, job.worktree, job.base_branch, project, cfg);
  if (policy.reasons.length) return hold(`The diff policy flags changes that need a human:\n${policy.reasons.map((r) => `- ${r}`).join('\n')}`);

  // 5. Independent second review, once per candidate sha.
  const verdictKey = `second-review:${job.id}:${sha}`;
  let verdict = kvGet(db, verdictKey) ? JSON.parse(kvGet(db, verdictKey)!) as SecondReviewVerdict : null;
  if (!verdict) {
    const input = {
      repo: job.repo, ticket, baseSha: job.base_sha!, candidateSha: sha,
      docs: await reviewDocs(ctx, job.worktree, sha, project),
      diffStat: await ws.diff(job.worktree, job.base_branch, true),
      diff: await ws.diff(job.worktree, job.base_branch),
    };
    const chars = input.docs.reduce((n, d) => n + d.content.length, 0) + input.diff.length + input.ticket.description.length;
    if (chars > cfg.secondReview.maxInputChars) return hold(`The change is too large for the second review (${chars} characters; limit ${cfg.secondReview.maxInputChars}).`);
    const worst = reviewer.maxCostUsd?.(chars) ?? 1;
    const day = externalSpentSince(db, reviewer.provider, startOfDay());
    const month = externalSpentSince(db, reviewer.provider, startOfMonth());
    if (day + worst > cfg.secondReview.dailyUsd || month + worst > cfg.secondReview.monthlyUsd) {
      const key = `second-review-budget:${startOfDay()}`;
      if (!kvGet(db, key)) {
        kvSet(db, key, '1');
        logEvent(db, 'second_review.budget', `second-review budget reached (today $${day.toFixed(2)}/$${cfg.secondReview.dailyUsd}, month $${month.toFixed(2)}/$${cfg.secondReview.monthlyUsd}); waiting`, { level: 'warn' });
      }
      return 'waiting';
    }
    try {
      const out = await reviewer.review(input);
      recordExternalUsage(db, { provider: reviewer.provider, model: out.model, jobId: job.id, ticketId: job.ticket_id, costUsd: out.costUsd, inputTokens: out.inputTokens, outputTokens: out.outputTokens, outcome: out.verdict.verdict });
      verdict = out.verdict;
      kvSet(db, verdictKey, JSON.stringify(verdict));
      logEvent(db, 'second_review', `${job.ticket_identifier}: ${verdict.verdict} (${out.model}, $${out.costUsd.toFixed(3)}): ${verdict.summary.slice(0, 200)}`, { jobId: job.id, ticketId: job.ticket_id });
    } catch (e) {
      const err = e as Error & { costUsd?: number; inputTokens?: number; outputTokens?: number };
      if (err.costUsd) recordExternalUsage(db, { provider: reviewer.provider, model: reviewer.model, jobId: job.id, ticketId: job.ticket_id, costUsd: err.costUsd, inputTokens: err.inputTokens, outputTokens: err.outputTokens, outcome: 'error' });
      const failKey = `second-review-failures:${job.id}:${sha}`;
      const failures = Number(kvGet(db, failKey) ?? 0) + 1;
      kvSet(db, failKey, String(failures));
      logEvent(db, 'second_review.error', `${job.ticket_identifier}: ${err.message.slice(0, 300)}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
      return failures >= 3 ? hold(`The second review failed ${failures} times: ${err.message.slice(0, 500)}`) : 'waiting';
    }
  }

  if (verdict.verdict !== 'approve') {
    const findings = verdict.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}\n  Fix: ${f.suggestion}`).join('\n');
    if (job.review_cycles >= cfg.limits.maxReviewCycles) return hold(`The second review (${reviewer.model}) still requests changes after ${cfg.limits.maxReviewCycles} rework cycles:\n${verdict.summary}\n${findings}`);
    return requeue({ stage: 'workspace', review_cycles: job.review_cycles + 1, pending_feedback: `The independent merge reviewer (${reviewer.model}) requested changes before this can be merged:\n${verdict.summary}\n${findings}\nSpec conformance notes: ${verdict.specConformance}` },
      'automerge.rework', `🔁 Second review (${reviewer.model}) requested changes; autodev is reworking the PR.\n\n${verdict.summary}\n${findings}`);
  }

  // All gates passed: approve exactly this sha as the reviewer account, then squash-merge pinned to it.
  const body = `Automated merge review for ${sha.slice(0, 12)}.\n\n- CI: passed\n- Claude review: approved\n- Second review (${reviewer.model}): approved: ${verdict.summary}\n- Diff policy: clean\n- Base: up to date with ${job.base_branch} (${job.base_sha!.slice(0, 12)})`;
  await scm.markReady(job.repo, pr);
  await scm.approve(job.repo, pr.number, sha, body);
  await scm.mergePr(job.repo, pr.number, sha, `${job.ticket_identifier}: ${ticket.title} (#${pr.number})`);
  logEvent(db, 'automerge.merged', `${job.ticket_identifier}: PR #${pr.number} merged at ${sha.slice(0, 12)}`, { jobId: job.id, ticketId: job.ticket_id });
  await tracker.comment(ticket.id, `🤖 Auto-merged PR #${pr.number}: CI ✓, Claude review ✓, ${reviewer.model} review ✓, policy clean, up to date with ${job.base_branch}.`).catch(() => {});
  return 'merged';
}

function conflictFeedback(base: string, files: string[]): string {
  return `The orchestrator merged the latest ${base} into this branch and it conflicts in:\n${files.map((f) => `- ${f}`).join('\n')}\n`
    + 'Resolve every conflict in the working files (remove all <<<<<<< ======= >>>>>>> markers), keeping both the changes already on '
    + `${base} and this ticket's changes. Don't run git commands; the orchestrator completes the merge. Then re-run the checks.`;
}

/** Project docs at the candidate commit, read from the trusted object store (Markdown only, bounded). */
async function reviewDocs(ctx: Ctx, worktree: string, sha: string, project: ProjectConfig): Promise<{ path: string; content: string }[]> {
  const all = (await ctx.ws.git(worktree, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha])).split('\0').filter(Boolean);
  const wanted = all.filter((f) => /\.md$/i.test(f) && project.docs.some((d) => f === d || f.startsWith(`${d.replace(/\/$/, '')}/`)));
  const out: { path: string; content: string }[] = [];
  for (const f of wanted.slice(0, 60)) out.push({ path: f, content: (await ctx.ws.git(worktree, ['cat-file', 'blob', `${sha}:${f}`])).slice(0, 100_000) });
  return out;
}
