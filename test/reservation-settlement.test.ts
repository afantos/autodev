import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ClaudeRunner } from '../src/agents/runner.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';
import { canStartRun, reserveBudget, settleDeadOwnerReservations, settleReservation } from '../src/budget.ts';
import { createCtx, runAgent } from '../src/context.ts';
import { SETTLED_OUTCOME, claimTicket, openDb, ownerDead, recordUsage, spentOnTicket } from '../src/db.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { makeEnv } from './helpers.ts';

// Stale budget reservations: a run that ends without a usage total, or whose owner process died, is settled by charging
// the reservation minus what was already recorded for it, atomically and at most once per reservation id.

const env = () => makeEnv({ config: { budget: { perRunUsd: 1.5, perTicketUsd: 3, dailyUsd: 10, monthlyUsd: 20 } } });
type E = ReturnType<typeof env>;
const spec = (e: E, more: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
  role: 'coding', prompt: 'offline fixture', systemAppend: '', cwd: e.root, model: 'sonnet', mode: 'readonly',
  maxTurns: 1, maxBudgetUsd: 1.5, timeoutMs: 60_000, sandbox: { enabled: true, failIfUnavailable: true, allowedDomains: [] }, ...more,
});
const reservations = (e: E) => (e.ctx.db.prepare('SELECT COUNT(*) n FROM budget_reservations').get() as { n: number }).n;
const settlements = (e: E) => e.ctx.db.prepare('SELECT job_id, ticket_id, role, model, cost_usd, reservation_id FROM usage WHERE outcome = ? ORDER BY id').all(SETTLED_OUTCOME).map((r) => ({ ...r }));
const settledEvents = (e: E) => (e.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'budget.settled'").get() as { n: number }).n;
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** A pid on this host that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  assert.ok(r.pid && ownerDead(`${hostname()}:${r.pid}:x`), 'fixture pid has exited');
  return r.pid;
}
const deadOwner = () => `${hostname()}:${deadPid()}:${Date.now().toString(36)}`;

function job(e: E, identifier = 'DEMO-1') {
  return claimTicket(e.ctx.db, { ticketId: `ticket-${identifier}`, identifier, project: 'demo', repo: '' }, e.ctx.owner, 60_000)!;
}

test('canceling a run mid-flight settles its reservation conservatively', async () => {
  const e = env();
  const j = job(e);
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  e.ctx.runner = new ClaudeRunner(async function* ({ options }) {
    started();
    await new Promise((r) => options!.abortController!.signal.addEventListener('abort', r));
    throw new Error('aborted by user');
  });
  const cancel = new AbortController();
  const pending = runAgent(e.ctx, spec(e, { signal: cancel.signal }), { jobId: j.id, ticketId: j.ticket_id });
  await running;
  assert.equal(reservations(e), 1, 'held while the run is live');
  cancel.abort();
  const res = await pending;
  assert.equal(res.usageComplete, false);
  assert.equal(reservations(e), 0);
  assert.deepEqual(settlements(e).map(({ reservation_id: _, ...r }) => r), [{ job_id: j.id, ticket_id: j.ticket_id, role: 'coding', model: 'sonnet', cost_usd: 1.5 }]);
  assert.ok(close(spentOnTicket(e.ctx.db, j.ticket_id), 1.5));
  assert.equal(settledEvents(e), 1);
});

test('a runner that throws settles its reservation before the error propagates', async () => {
  const e = env();
  const j = job(e);
  e.runner.behaviors.coding = async () => { throw new Error('lost result'); };
  await assert.rejects(runAgent(e.ctx, spec(e), { jobId: j.id, ticketId: j.ticket_id }), /lost result/);
  assert.equal(reservations(e), 0);
  assert.equal(settlements(e).length, 1);
  assert.equal(settlements(e)[0]!.cost_usd, 1.5);
  assert.ok(close(spentOnTicket(e.ctx.db, j.ticket_id), 1.5), 'the unknown spend stays charged, never made available again');
  assert.ok(close(canStartRun(e.ctx.db, e.ctx.cfg, j.ticket_id).allowanceUsd, 1.5));
});

test('a restart settles a dead owner\'s reservation once, however often it restarts', async () => {
  const e = env();
  const j = job(e);
  const r = reserveBudget(e.ctx.db, e.ctx.cfg, deadOwner(), { jobId: j.id, ticketId: j.ticket_id }, 1.5, { role: 'review', model: 'opus' });
  assert.ok(r.ok);
  for (let i = 0; i < 3; i++) {
    // A fresh process (new owner) on the same state file, as after systemd restarts the service.
    const ctx = createCtx(e.ctx.cfg, { db: e.ctx.db, tracker: e.tracker, scm: e.scm, runner: e.runner, runCommand: e.ctx.runCommand });
    ctx.owner = `${hostname()}:${process.pid}:restart${i}`;
    await new Orchestrator(ctx).run({ once: true });
  }
  assert.equal(reservations(e), 0);
  assert.deepEqual(settlements(e), [{ job_id: j.id, ticket_id: j.ticket_id, role: 'review', model: 'opus', cost_usd: 1.5, reservation_id: r.reservationId }]);
  assert.equal(settledEvents(e), 1);
  assert.equal(settleReservation(e.ctx.db, r.reservationId!, 'again'), null, 'keyed by reservation id');
  assert.ok(close(spentOnTicket(e.ctx.db, j.ticket_id), 1.5));
});

test('settlement charges only the part of the reservation not already recorded for that run', async () => {
  const e = env();
  const a = job(e, 'DEMO-1'); const b = job(e, 'DEMO-2'); const c = job(e, 'DEMO-3');
  const owner = deadOwner();
  // Linked partial usage (recorded by runAgent for an incomplete run).
  const ra = reserveBudget(e.ctx.db, e.ctx.cfg, owner, { jobId: a.id, ticketId: a.ticket_id }, 1.5, { role: 'coding', model: 'sonnet' });
  recordUsage(e.ctx.db, { jobId: a.id, ticketId: a.ticket_id, role: 'coding', costUsd: 0.4, outcome: 'usage_unknown', reservationId: ra.reservationId });
  // A reservation made before usage rows carried reservation_id: its partial row is matched once, then linked.
  const rb = reserveBudget(e.ctx.db, e.ctx.cfg, owner, { jobId: b.id, ticketId: b.ticket_id }, 1.5);
  recordUsage(e.ctx.db, { jobId: b.id, ticketId: b.ticket_id, role: 'coding', costUsd: 0.25, outcome: 'usage_unknown' });
  // Recorded usage above the reservation: nothing more to charge, never a negative row.
  const rc = reserveBudget(e.ctx.db, e.ctx.cfg, owner, { jobId: c.id, ticketId: c.ticket_id }, 0.5);
  recordUsage(e.ctx.db, { jobId: c.id, ticketId: c.ticket_id, role: 'coding', costUsd: 0.7, outcome: 'usage_unknown', reservationId: rc.reservationId });

  const out = settleDeadOwnerReservations(e.ctx.db, e.ctx.owner);
  const charged = new Map(out.map((s) => [s.reservationId, +s.chargedUsd.toFixed(9)]));
  assert.deepEqual(charged, new Map([[ra.reservationId, 1.1], [rb.reservationId, 1.25], [rc.reservationId, 0]]));
  assert.equal(settlements(e).find((s) => s.reservation_id === rb.reservationId)!.role, 'unknown', 'legacy reservations have no role');
  assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM usage WHERE reservation_id = ?').get(rb.reservationId!) as { n: number }).n, 2, 'legacy partial row linked');
  for (const [t, total] of [[a, 1.5], [b, 1.5], [c, 0.7]] as const) assert.ok(close(spentOnTicket(e.ctx.db, t.ticket_id), total), t.ticket_identifier);
  assert.equal(reservations(e), 0);
  assert.deepEqual(settleDeadOwnerReservations(e.ctx.db, e.ctx.owner), []);
});

test('live runs keep their reservations; only dead owners on this host are settled', async () => {
  const e = env();
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const barrier = new Promise<void>((r) => { release = r; });
  e.runner.behaviors.coding = async () => { entered(); await barrier; return { costUsd: 0.2 }; };
  const pending = runAgent(e.ctx, spec(e), { ticketId: 'live' });
  await started;
  const keep = [
    `${hostname()}:${process.ppid}:parent`, // another live process on this host (e.g. a CLI planning run)
    `other-host:${deadPid()}:x`, // liveness on another host can't be checked
  ];
  for (const owner of keep) reserveBudget(e.ctx.db, e.ctx.cfg, owner, { ticketId: 'other' }, 0.5);
  const reused = reserveBudget(e.ctx.db, e.ctx.cfg, `${hostname()}:${process.pid}:earlier-boot`, { ticketId: 'other' }, 0.5);
  const settled = settleDeadOwnerReservations(e.ctx.db, e.ctx.owner);
  assert.deepEqual(settled.map((s) => s.reservationId), [reused.reservationId], 'only the earlier process that had our pid');
  const owners = (e.ctx.db.prepare('SELECT owner FROM budget_reservations ORDER BY created_at').all() as { owner: string }[]).map((r) => r.owner);
  assert.deepEqual(owners.sort(), [e.ctx.owner, ...keep].sort(), 'the live run keeps its reservation');
  release();
  await pending;
  assert.equal(reservations(e), 2);
  assert.equal(settlements(e).length, 1);
});

test('settlement is atomic: if the usage row cannot be written the reservation stays', async () => {
  const e = env();
  const r = reserveBudget(e.ctx.db, e.ctx.cfg, deadOwner(), { ticketId: 't' }, 1);
  e.ctx.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'usage fixture failure'); END");
  assert.throws(() => settleDeadOwnerReservations(e.ctx.db, e.ctx.owner), /usage fixture failure/);
  assert.equal(reservations(e), 1);
  e.ctx.db.exec('DROP TRIGGER fail_usage');
  // Reopening (a restart) after the failure settles it exactly once.
  const db = openDb(join(e.ctx.cfg.dataDir, 'autodev.db'));
  try {
    assert.equal(settleDeadOwnerReservations(db, 'restarted:1:x').length, 1);
    assert.deepEqual(db.prepare('SELECT reservation_id, cost_usd FROM usage').all().map((x) => ({ ...x })), [{ reservation_id: r.reservationId, cost_usd: 1 }]);
  } finally { db.close(); }
});
