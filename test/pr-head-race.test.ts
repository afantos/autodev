import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, job } from './helpers.ts';
import type { PullRequest } from '../src/types.ts';

// DEV-8 (2026-10-24): after a rework push, GitHub's PR API reported the previous head for about a second, and the
// PR stage blocked the job as tampering. The stage now polls for a bounded window and accepts only the exact
// validated candidate; a mismatch that persists still blocks.

const REQUEST_CHANGES = { structured: { outcome: 'changes_requested', summary: 'Handle the short all-in big blind.', acceptanceCriteria: [], findings: [{ severity: 'major', file: 'CHANGES.md', issue: 'missing case', suggestion: 'add it' }], followUps: [] } };
const APPROVED = { structured: { outcome: 'approved', summary: 'Looks good.', acceptanceCriteria: [], findings: [], followUps: [] } };

function env(windowSeconds: number) {
  // First review requests changes, so the job reworks and pushes a second candidate to the existing PR.
  return makeEnv({ config: { loop: { prHeadConvergeSeconds: windowSeconds } }, behaviors: { review: async (_spec, n) => (n === 1 ? REQUEST_CHANGES : APPROVED) } });
}
const ready = (e: ReturnType<typeof makeEnv>) => e.tracker.createTicket({ projectKey: 'demo', title: 'Race', description: '', status: 'ready', priority: 2 });

/**
 * Wrap getPr: after the branch moves past `firstHead` (i.e. after the rework push), report `reported(realHead)` for the
 * first `staleReads` reads, then the real head (or keep lying forever when staleReads is Infinity).
 */
function lagPrApi(e: ReturnType<typeof makeEnv>, staleReads: number, reported: (firstHead: string, realHead: string) => string) {
  const real = e.scm.getPr.bind(e.scm);
  let firstHead: string | null = null;
  let lies = 0;
  const reads: string[] = [];
  e.ctx.scm.getPr = async (repo: string, n: number): Promise<PullRequest> => {
    const pr = await real(repo, n);
    firstHead ??= pr.headSha;
    if (pr.headSha !== firstHead && lies < staleReads) {
      lies++;
      reads.push('stale');
      return { ...pr, headSha: reported(firstHead, pr.headSha) };
    }
    reads.push('real');
    return pr;
  };
  return { reads, lies: () => lies };
}

test('delayed convergence: a rework push whose PR head lags briefly is accepted once the API reports the exact candidate', async () => {
  const e = env(5);
  const t = await ready(e);
  const api = lagPrApi(e, 3, (first) => first); // the API keeps showing the previous head for 3 reads
  await e.cycle();
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge', String(j.blocked_reason ?? j.error));
  assert.equal(api.lies(), 3, 'the stale reads were actually served');
  assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'pr.head_converged'").get());
  assert.equal(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'security.worktree_tampered'").get(), undefined, 'no false tamper alarm');
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).headSha, j.candidate_sha);
});

test('genuine unexpected head: a mismatch that persists past the window still blocks as tampering', async () => {
  const e = env(1);
  const t = await ready(e);
  const unexpected = 'f'.repeat(40);
  lagPrApi(e, Infinity, () => unexpected); // something else keeps showing as the PR head
  await e.cycle();
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /remote PR HEAD differs from the validated candidate/);
  assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'pr.head_mismatch'").get());
  assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'security.worktree_tampered'").get());
});

test('the previous head persisting past the window also blocks (stale is never accepted)', async () => {
  const e = env(1);
  const t = await ready(e);
  lagPrApi(e, Infinity, (first) => first);
  await e.cycle();
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
});

test('only the exact candidate is accepted: a different head that appears during the window does not end the wait', async () => {
  const e = env(1);
  const t = await ready(e);
  let n = 0;
  // stale previous head, then an unexpected head for the rest of the window: never the candidate.
  lagPrApi(e, Infinity, (first) => (++n <= 2 ? first : 'e'.repeat(40)));
  await e.cycle();
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.equal(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'pr.head_converged'").get(), undefined);
});

test('the window is bounded: the PR stage gives up after prHeadConvergeSeconds rather than waiting indefinitely', async () => {
  const e = env(1);
  const t = await ready(e);
  lagPrApi(e, Infinity, () => 'd'.repeat(40));
  const t0 = Date.now();
  await e.cycle();
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.ok(Date.now() - t0 < 20_000, 'bounded by the 1 s window plus normal pipeline time');
});

// ---------------------------------------------------------------- cancellation (review of adf1e85)

import { getEventListeners } from 'node:events';
import { abortableSleep, awaitPrHead } from '../src/pipeline.ts';
import type { Job } from '../src/types.ts';

const CANDIDATE = 'c'.repeat(40);
const fakeJob = { id: 'j1', ticket_id: 't1', ticket_identifier: 'X-1', repo: 'o/r', candidate_sha: CANDIDATE, base_sha: 'b'.repeat(40), worktree: '/w' } as unknown as Job;
const stalePr = (headSha = 'a'.repeat(40)): PullRequest => ({ number: 8, url: 'u', headBranch: 'h', baseBranch: 'main', headSha, state: 'open', draft: false });

function unitCtx(windowSeconds: number, getPr: () => Promise<PullRequest>) {
  const e = makeEnv({ config: { loop: { prHeadConvergeSeconds: windowSeconds } } });
  e.ctx.scm.getPr = getPr;
  return e.ctx;
}

test('cancellation during an API read stops the wait at once: no further reads (reproduced: 8 reads with a 2 s window)', async () => {
  const ac = new AbortController();
  let reads = 0;
  const ctx = unitCtx(2, async () => { reads++; if (reads === 1) ac.abort(new Error('lease lost')); return stalePr(); });
  const t0 = Date.now();
  await assert.rejects(awaitPrHead(ctx, fakeJob, stalePr(), ac.signal), /lease lost/);
  assert.equal(reads, 1, 'the read that observed cancellation is the last one');
  assert.ok(Date.now() - t0 < 1_000, 'returns well before the 2 s window');
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
});

test('a read that completes after cancellation is never acted on, even if it shows the candidate', async () => {
  const ac = new AbortController();
  const ctx = unitCtx(2, async () => { ac.abort(new Error('canceled')); return stalePr(CANDIDATE); });
  await assert.rejects(awaitPrHead(ctx, fakeJob, stalePr(), ac.signal), /canceled/);
  assert.equal(ctx.db.prepare("SELECT 1 FROM events WHERE type = 'pr.head_converged'").get(), undefined);
});

test('cancellation during the wait between reads rejects promptly without another read', async () => {
  const ac = new AbortController();
  let reads = 0;
  const ctx = unitCtx(5, async () => { reads++; return stalePr(); }); // interval 500 ms
  setTimeout(() => ac.abort(new Error('stop')), 50);
  const t0 = Date.now();
  await assert.rejects(awaitPrHead(ctx, fakeJob, stalePr(), ac.signal), /stop/);
  assert.equal(reads, 0);
  assert.ok(Date.now() - t0 < 400);
});

test('an already-cancelled signal makes no reads at all', async () => {
  const ac = new AbortController();
  ac.abort(new Error('already'));
  let reads = 0;
  const ctx = unitCtx(2, async () => { reads++; return stalePr(); });
  await assert.rejects(awaitPrHead(ctx, fakeJob, stalePr(), ac.signal), /already/);
  assert.equal(reads, 0);
});

test('sleep listeners are cleaned up: none remain after convergence or on an already-aborted sleep', async () => {
  const ac = new AbortController();
  let reads = 0;
  const ctx = unitCtx(2, async () => (++reads >= 3 ? stalePr(CANDIDATE) : stalePr()));
  const pr = await awaitPrHead(ctx, fakeJob, stalePr(), ac.signal);
  assert.equal(pr.headSha, CANDIDATE);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'every sleep removed its listener');
  const done = new AbortController();
  done.abort(new Error('x'));
  await assert.rejects(abortableSleep(1_000, done.signal), /x/);
  assert.equal(getEventListeners(done.signal, 'abort').length, 0, 'no listener registered on an aborted signal');
});
