import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { WorktreeTamperedError } from '../src/scm/git.ts';

/** Pause a legitimate reference-clone update (`git worktree add`) mid-flight: refs changed, snapshot not yet recorded. */
function pauseWorktreeAdd(ws: ReturnType<typeof makeEnv>['ctx']['ws']) {
  let paused!: () => void; let release!: () => void;
  const reached = new Promise<void>((r) => { paused = r; });
  const gate = new Promise<void>((r) => { release = r; });
  ws.testHooks.afterCloneCommand = async (args) => {
    if (args[0] === 'worktree' && args[1] === 'add') { ws.testHooks.afterCloneCommand = undefined; paused(); await gate; }
  };
  return { reached, release };
}

const settled = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

test('ref checks wait for an in-progress worktree creation instead of reporting it as tampering', async () => {
  const e = makeEnv();
  const ws = e.ctx.ws;
  const { path: a } = await ws.ensureWorktree(e.repo, 'LOCK-A', 'autodev/lock-a', 'main');

  const pause = pauseWorktreeAdd(ws);
  const creatingB = ws.ensureWorktree(e.repo, 'LOCK-B', 'autodev/lock-b', 'main');
  await pause.reached; // B holds the repo lock with refs mid-update

  // Every kind of worktree-side check that previously raced: git commands, headSha, agent workspace verification.
  const done: string[] = [];
  const track = <T>(name: string, p: Promise<T>) => settled(p.finally(() => done.push(name)));
  const status = track('status', ws.git(a, ['status', '--porcelain']));
  const head = track('headSha', ws.headSha(a));
  const agent = track('verifyAgentWorkspace', ws.verifyAgentWorkspace(a));

  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(done, [], 'no check ran against the half-updated clone');

  pause.release();
  const results = await Promise.all([status, head, agent, settled(creatingB)]);
  for (const r of results) assert.equal(r.ok, true, r.ok ? '' : String((r as { e: unknown }).e));
  assert.equal(e.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'security.worktree_tampered'").get()!.n, 0);
});

test('two concurrent jobs on one repo never produce a false tamper block (pipeline level)', async () => {
  const e = makeEnv({ config: { concurrency: { global: 2 } }, project: { maxConcurrent: 2 } });
  const ws = e.ctx.ws;
  // Job 1 creates its worktree; then job 2 updates the shared clone (fetch, prune, worktree add) under the
  // lock. Job 2's update is held at its first command until a ref check from job 1 is pending, so that
  // check necessarily overlaps job 2's whole update. Before the fix the check ran unlocked against the
  // half-updated clone and reported tampering; now it must wait, then pass, and both jobs must complete.
  let pending = 0;
  let overlapped = false;
  const track = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => async (...a: A) => {
    pending++;
    try { await fn(...a); } finally { pending--; }
  };
  ws.verifyRefsLocked = track(ws.verifyRefsLocked.bind(ws));
  ws.verifyAgentWorkspace = track(ws.verifyAgentWorkspace.bind(ws));
  let adds = 0;
  ws.testHooks.afterCloneCommand = async (args) => {
    if (args[0] === 'fetch') {
      // Job 2's update has begun (job 1 cloned fresh, without a fetch). Wait for job 1 to request a check.
      const deadline = Date.now() + 15_000;
      while (pending === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      overlapped = pending > 0;
    }
    if (args[0] === 'worktree' && args[1] === 'add') adds++;
  };
  await e.tracker.createTicket({ projectKey: 'demo', title: 'Overlap one', description: '', status: 'ready', priority: 1 });
  await e.tracker.createTicket({ projectKey: 'demo', title: 'Overlap two', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  assert.equal(adds, 2, 'both worktrees were created');
  assert.equal(overlapped, true, "a ref check from job 1 was pending during job 2's clone update");
  const jobs = e.ctx.db.prepare('SELECT ticket_identifier, status, blocked_reason FROM jobs ORDER BY ticket_identifier').all() as { ticket_identifier: string; status: string; blocked_reason: string | null }[];
  assert.equal(jobs.length, 2);
  for (const j of jobs) assert.equal(j.status, 'awaiting_merge', `${j.ticket_identifier}: ${j.blocked_reason}`);
  assert.equal(e.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'security.worktree_tampered'").get()!.n, 0);
});

test('tampering outside the lock is still detected by every ref check', async () => {
  const e = makeEnv();
  const ws = e.ctx.ws;
  const { path: a } = await ws.ensureWorktree(e.repo, 'TAMPER-A', 'autodev/tamper-a', 'main');
  const rec = ws.verifiedRecord(a);
  const head = (await ws.git(a, ['rev-parse', 'HEAD'])).trim();
  writeFileSync(join(rec.commonDir, 'refs', 'heads', 'planted'), `${head}\n`); // a write no orchestrator command made

  await assert.rejects(ws.git(a, ['status']), WorktreeTamperedError);
  await assert.rejects(ws.headSha(a), WorktreeTamperedError);
  await assert.rejects(ws.verifyAgentWorkspace(a), WorktreeTamperedError);
  // A later, legitimate locked clone command must not launder the earlier tampering into the snapshot.
  await assert.rejects(ws.ensureWorktree(e.repo, 'TAMPER-B', 'autodev/tamper-b', 'main'), WorktreeTamperedError);
  await assert.rejects(ws.git(a, ['status']), WorktreeTamperedError, 'still detected afterwards');
});

test('the repo lock is re-entrant within one async context and exclusive across contexts', async () => {
  const e = makeEnv();
  const ws = e.ctx.ws;
  await ws.ensureClone(e.repo);
  const order: string[] = [];
  let inside!: () => void; const entered = new Promise<void>((r) => { inside = r; });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const first = ws.withRepoLock(e.repo, async () => {
    order.push('outer');
    await ws.withRepoLock(e.repo, async () => { order.push('nested'); }); // would deadlock without re-entrancy
    inside();
    await gate;
    order.push('outer-end');
  });
  await entered;
  const second = ws.withRepoLock(e.repo, async () => { order.push('other'); });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ['outer', 'nested'], 'another context waits');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['outer', 'nested', 'outer-end', 'other']);
});
