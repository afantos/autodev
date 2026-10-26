import type { ProjectConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { kvGet, kvSet, logEvent, updateJob } from './db.ts';
import { cachedVerdict, reservedReview } from './external-review.ts';
import { markBaseRefreshed } from './pipeline.ts';
import { TEST_FILE, inspectChanges, onlyKeywordFindings, onlyNarrowTestUpdates } from './policy.ts';
import { aiApprovalEligible, approveFlaggedDiff, clearKeywordFlags, triageEnabled } from './triage.ts';
import type { PolicyInspection } from './policy.ts';
import { decisionsForTicket } from './decisions.ts';
import { findSupersedingRequirement } from './test-updates.ts';
import { SecondReviewSchema, TestIntegritySchema, effectiveVerdict, requestBytes, testIntegrityApproved } from './agents/second-review.ts';
import type { TestUpdateReviewInput } from './agents/second-review.ts';
import type { SecondReviewVerdict } from './agents/second-review.ts';
import type { Job, Ticket } from './types.ts';
import { createHash } from 'node:crypto';

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

  // Only a ticket a human hasn't moved elsewhere (Canceled, Backlog, Done, back to Ready...) may merge.
  if (ticket.status !== 'review') return 'skipped';
  // Owner hold, checked first (before any refresh or review spend), again after marking the PR ready and before
  // approving, and once more before merging. Fails closed: a ticket that can't be read stops the merge.
  const holdLabel = cfg.linear.holdMergeLabel;
  const holdReason = `The ticket carries the \`${holdLabel}\` label, so auto-merge is on hold. Remove the label to let it continue.`;
  const mayProceed = async (): Promise<'ok' | 'held' | 'skipped'> => {
    let current: Ticket | null = null;
    try { current = await tracker.getTicket(ticket.id); } catch (e) {
      await hold(`The ticket's state could not be verified (${(e as Error).message.slice(0, 200)}), so auto-merge stopped; it retries on the next pass.`);
      return 'held';
    }
    if (!current) { await hold('The ticket could not be found, so its hold state could not be verified; auto-merge stopped.'); return 'held'; }
    if (holdLabel && current.labels.includes(holdLabel)) { await hold(holdReason); return 'held'; }
    if (current.status !== 'review') return 'skipped';
    return 'ok';
  };
  { const g = await mayProceed(); if (g !== 'ok') return g; }
  const pr = await scm.getPr(job.repo, job.pr_number);
  if (pr.state !== 'open') return 'skipped';
  if (pr.baseBranch !== job.base_branch) return hold(`The PR now targets \`${pr.baseBranch}\`, but autodev validated it against \`${job.base_branch}\`. It won't merge a retargeted PR.`);
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
    if (r.status !== 'current') markBaseRefreshed(ctx, job, r.baseSha);
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

  // 4. Mandatory policy: flagged changes go to a human, even if a human approved them earlier, unless
  // secondReview.mergeOwnerApprovedDiffs is on and the owner approved this exact diff hash. The other exception
  // (option B): findings that are ONLY eligible narrow existing-test updates, not human-approved, may pass a recorded
  // superseding requirement plus a dedicated test-integrity review of this exact candidate.
  // Triage exception: findings that come only from the keyword heuristic, cleared for this exact diff hash.
  const policy = await inspectChanges(ws, job.worktree, job.base_branch, project, cfg);
  let policyNote = 'clean';
  if (policy.reasons.length) {
    const humanApproved = !!kvGet(db, `policy-approved:${job.id}:${policy.hash}`);
    const flagged = `The diff policy flags changes that need a human:\n${policy.reasons.map((r) => `- ${r}`).join('\n')}`;
    if (humanApproved && cfg.secondReview.mergeOwnerApprovedDiffs) {
      // The owner approved this exact diff (by hash); the second review and the CI/head gates still apply.
      policyNote = `flagged changes approved by the owner for this exact diff (${policy.hash.slice(0, 12)})`;
    } else if (!humanApproved && onlyNarrowTestUpdates(policy)) {
      const gate = await testIntegrityGate(ctx, job, ticket, policy, sha, hold);
      if (gate !== 'approved') return gate;
      policyNote = 'narrow existing-test update approved by the test-integrity review';
    } else {
      let triageNote = '';
      if (!humanApproved && onlyKeywordFindings(policy) && triageEnabled(ctx, project)) {
        const c = await clearKeywordFlags(ctx, job, project, policy);
        if (c.kind === 'waiting') return 'waiting';
        if (c.kind === 'cleared') policyNote = 'keyword flag(s) cleared by triage as mentions only';
        else triageNote = `\n\nTriage: ${c.note}`;
      }
      if (policyNote === 'clean') {
        // flaggedDiffApprover 'second-review': the owner delegated approval of flagged diffs (outside alwaysHumanPaths).
        if (!aiApprovalEligible(ctx, project, policy)) return hold(`${flagged}${triageNote}`);
        if (humanApproved) policyNote = `flagged changes approved by the owner for this exact diff (${policy.hash.slice(0, 12)})`;
        else {
          const a = await approveFlaggedDiff(ctx, job, project, policy, humanDecisions(ctx, ticket));
          if (a.kind === 'waiting') return 'waiting';
          if (a.kind !== 'approved') return hold(`${flagged}${triageNote}\n\nSecond-review approval: ${a.note}`);
          policyNote = `flagged changes approved by the second reviewer for this exact diff (${policy.hash.slice(0, 12)}), delegated by the owner`;
        }
      }
    }
  }

  // 5. Independent second review, once per candidate sha AND requirements: a clarified ticket (description or a recorded
  // human decision) gets a fresh review instead of a verdict that predates the clarification.
  const requirements = requirementsHash(ctx, ticket);
  const verdictKey = `second-review:${job.id}:${sha}:${requirements}`;
  // A cached verdict is reused only if it still validates against the current schema. Verdicts cached by an older
  // version (e.g. findings without a category) are discarded and the review runs again: never reinterpret them.
  let verdict = cachedVerdict(ctx, job, verdictKey, SecondReviewSchema, 'second_review');
  if (!verdict) {
    const input = {
      repo: job.repo, ticket, baseSha: job.base_sha!, candidateSha: sha, decisions: humanDecisions(ctx, ticket),
      docs: await reviewDocs(ctx, job.worktree, sha, project),
      diffStat: await ws.diff(job.worktree, job.base_branch, true),
      diff: await ws.diff(job.worktree, job.base_branch),
    };
    const bytes = requestBytes(input);
    if (bytes > cfg.secondReview.maxInputChars) return hold(`The change is too large for the second review (${bytes} bytes; limit ${cfg.secondReview.maxInputChars}).`);
    const r = await reservedReview(ctx, job, sha, 'second_review', 'second-review-failures', reviewer.maxCostUsd(input), async () => {
      const out = await reviewer.review(input);
      return { value: out.verdict, model: out.model, costUsd: out.costUsd, inputTokens: out.inputTokens, outputTokens: out.outputTokens, outcome: out.verdict.verdict, summary: out.verdict.summary };
    });
    if (r.kind === 'waiting') return 'waiting';
    if (r.kind === 'failed') return hold(`The second review failed ${r.failures} times: ${r.message.slice(0, 500)}`);
    verdict = r.value;
    kvSet(db, verdictKey, JSON.stringify(verdict));
  }

  // The merge decision is enforced in code: only blocker findings, or major bugs/regressions/spec/security/test gaps, block.
  const decision = effectiveVerdict(verdict);
  const fmt = (fs: SecondReviewVerdict['findings']) => fs.map((f) => `- [${f.severity}/${f.category}] ${f.file}${f.line ? `:${f.line}` : ''}: ${f.issue}\n  Fix: ${f.suggestion}`).join('\n');
  if (decision.overridden) {
    logEvent(db, 'second_review.overridden', `${job.ticket_identifier}: model said ${verdict.verdict}; ${decision.blocking.length} blocking finding(s) → ${decision.decision}`, { jobId: job.id, ticketId: job.ticket_id });
  }
  if (decision.decision !== 'approve') {
    const findings = fmt(decision.blocking);
    // No progress: this exact candidate was already sent back for these findings and the rework changed nothing.
    const reworkKey = `second-review-rework:${job.id}:${sha}:${requirements}`;
    if (kvGet(db, reworkKey)) return hold(`The second review (${reviewer.model}) still requests changes, but the last rework left the candidate unchanged (${sha.slice(0, 12)}), so another rework would repeat it. A human should decide:\n${verdict.summary}\n${findings}`);
    kvSet(db, reworkKey, '1');
    if (job.review_cycles >= cfg.limits.maxReviewCycles) return hold(`The second review (${reviewer.model}) still requests changes after ${cfg.limits.maxReviewCycles} rework cycles:\n${verdict.summary}\n${findings}`);
    return requeue({ stage: 'workspace', review_cycles: job.review_cycles + 1, pending_feedback: `The independent merge reviewer (${reviewer.model}) requested changes before this can be merged:\n${verdict.summary}\n${findings}\nSpec conformance notes: ${verdict.specConformance}` },
      'automerge.rework', `🔁 Second review (${reviewer.model}) requested changes; autodev is reworking the PR.\n\n${verdict.summary}\n${findings}`);
  }

  // All gates passed. Re-check everything that can change while the review ran, immediately before acting.
  const latest = await tracker.getTicket(ticket.id);
  if (latest && holdLabel && latest.labels.includes(holdLabel)) return hold(holdReason);
  if (!latest || latest.status !== 'review') {
    logEvent(db, 'automerge.skipped', `${job.ticket_identifier}: ticket moved to ${latest?.status ?? 'missing'} during review; not merging`, { jobId: job.id, ticketId: job.ticket_id });
    return 'skipped';
  }
  const now = await scm.getPr(job.repo, pr.number);
  if (now.state !== 'open') return 'skipped';
  if (now.baseBranch !== job.base_branch) return hold(`The PR was retargeted to \`${now.baseBranch}\` during review; autodev validated it against \`${job.base_branch}\`.`);
  if (now.headSha !== sha) return hold(`The PR head changed during review (${now.headSha.slice(0, 12)} ≠ ${sha.slice(0, 12)}).`);
  if ((await scm.branchSha(job.repo, job.base_branch)) !== job.base_sha) return 'waiting'; // base moved: refreshed next pass

  // Approve exactly this sha as the reviewer account, then squash-merge pinned to it.
  const notes = decision.notes.length ? `\n\nNon-blocking notes from the second review:\n${fmt(decision.notes)}` : '';
  const body = `Automated merge review for ${sha.slice(0, 12)}.\n\n- CI: passed\n- Claude review: approved\n- Second review (${reviewer.model}): approved: ${verdict.summary}\n- Diff policy: ${policyNote}\n- Base: up to date with ${job.base_branch} (${job.base_sha!.slice(0, 12)})${notes}`;
  await scm.markReady(job.repo, pr);
  // A hold added while marking the PR ready stops the approval.
  { const g = await mayProceed(); if (g !== 'ok') return g; }
  await scm.approve(job.repo, pr.number, sha, body);
  // Last check: a hold added while approving still stops the merge (the approval alone merges nothing).
  { const g = await mayProceed(); if (g !== 'ok') return g; }
  await scm.mergePr(job.repo, pr.number, sha, `${job.ticket_identifier}: ${ticket.title} (#${pr.number})`);
  logEvent(db, 'automerge.merged', `${job.ticket_identifier}: PR #${pr.number} merged at ${sha.slice(0, 12)}`, { jobId: job.id, ticketId: job.ticket_id });
  await tracker.comment(ticket.id, `🤖 Auto-merged PR #${pr.number}: CI ✓, Claude review ✓, ${reviewer.model} review ✓, policy ${policyNote === 'clean' ? 'clean' : `(${policyNote})`}, up to date with ${job.base_branch}.${notes}`).catch(() => {});
  return 'merged';
}

/** Hash of what the ticket requires: title, description and resolved human decisions (answers, clarifications). */
export function requirementsHash(ctx: Ctx, ticket: Ticket): string {
  return createHash('sha256').update(JSON.stringify([ticket.title, ticket.description, humanDecisions(ctx, ticket)])).digest('hex').slice(0, 16);
}

/**
 * Resolved human decisions for the ticket. The single source for both the verdict cache key (requirementsHash) and the
 * reviewer prompts, so a decision that invalidates a cached verdict is always shown to the fresh review.
 */
export function humanDecisions(ctx: Ctx, ticket: Ticket): { question: string; decision: string }[] {
  return decisionsForTicket(ctx, ticket.id).filter((d) => d.authority === 'human' && d.status === 'resolved').map((d) => ({ question: d.question, decision: d.decision ?? '' }));
}

export function conflictFeedback(base: string, files: string[]): string {
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

/**
 * Option B gate for eligible narrow existing-test updates: a recorded superseding requirement must exist, and a dedicated
 * test-integrity review of THIS candidate (original tests + proposed test diff + requirement) must approve, with both
 * "implements the requirement" and "preserves coverage" affirmed. Verdicts are bound to the exact candidate sha.
 */
async function testIntegrityGate(ctx: Ctx, job: Job, ticket: Ticket, policy: PolicyInspection, sha: string, hold: (reason: string) => Promise<'held'>): Promise<'approved' | 'waiting' | 'held'> {
  const { db, ws, tracker } = ctx;
  const reviewer = ctx.secondReviewer!;
  const files = policy.testUpdates.map((u) => u.file);
  const latest = (await tracker.getTicket(ticket.id)) ?? ticket;
  const comments = await tracker.listComments(ticket.id).catch(() => []);
  const resolvedHuman = decisionsForTicket(ctx, ticket.id).filter((d) => d.authority === 'human' && d.status === 'resolved');
  const superseding = findSupersedingRequirement({ description: latest.description, comments, humanDecisions: resolvedHuman });
  if (!superseding.length) {
    return hold(`Existing tests were updated (only test names and expected values: ${files.join(', ')}), but neither the ticket nor a recorded human decision says the old behavior is superseded. A human needs to confirm.`);
  }
  const key = `test-integrity:${job.id}:${sha}:${requirementsHash(ctx, latest)}`;
  let verdict = cachedVerdict(ctx, job, key, TestIntegritySchema, 'test_integrity');
  if (!verdict) {
    const state = ws.trustedState(job.worktree!);
    const originalTests: { path: string; content: string }[] = [];
    for (const f of files) originalTests.push({ path: f, content: await ws.git(job.worktree!, ['cat-file', 'blob', `${state.base_sha}:${f}`]) });
    const testDiff = await ws.git(job.worktree!, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', `${state.base_sha}...${sha}`, '--', ...files.map((f) => `:(literal)${f}`)]);
    const added = (await ws.git(job.worktree!, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', `${state.base_sha}...${sha}`])).split('\0').filter((f) => f && TEST_FILE.test(f));
    const newTests: { path: string; content: string }[] = [];
    let budget = 200_000;
    for (const f of added.slice(0, 20)) {
      if (budget <= 0) break;
      const content = (await ws.git(job.worktree!, ['cat-file', 'blob', `${sha}:${f}`])).slice(0, Math.min(50_000, budget));
      budget -= content.length;
      newTests.push({ path: f, content });
    }
    const input: TestUpdateReviewInput = { repo: job.repo, ticket: latest, candidateSha: sha, originalTests, testDiff, superseding, newTests, decisions: humanDecisions(ctx, latest) };
    const r = await reservedReview(ctx, job, sha, 'test_integrity', 'test-integrity-failures', reviewer.maxTestUpdateCostUsd(input), async () => {
      const out = await reviewer.reviewTestUpdate(input);
      return { value: out.verdict, model: out.model, costUsd: out.costUsd, inputTokens: out.inputTokens, outputTokens: out.outputTokens, outcome: testIntegrityApproved(out.verdict) ? 'approve' : 'reject', summary: out.verdict.summary };
    });
    if (r.kind === 'waiting') return 'waiting';
    if (r.kind === 'failed') return hold(`The test-integrity review failed ${r.failures} times: ${r.message.slice(0, 500)}`);
    verdict = r.value;
    kvSet(db, key, JSON.stringify(verdict));
  }
  if (!testIntegrityApproved(verdict)) {
    return hold(`The test-integrity review (${reviewer.model}) did not approve the existing-test update in ${files.join(', ')}: ${verdict.summary}${verdict.concerns.length ? `\n${verdict.concerns.map((c) => `- ${c}`).join('\n')}` : ''}\n(implements requirement: ${verdict.implementsRequirement}; preserves coverage: ${verdict.preservesCoverage})`);
  }
  logEvent(db, 'test_integrity.approved', `${job.ticket_identifier}: narrow existing-test update approved at ${sha.slice(0, 12)} (${files.join(', ')})`, { jobId: job.id, ticketId: job.ticket_id });
  return 'approved';
}
