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
