import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeRunner } from '../src/agents/runner.ts';
import type { AgentRunSpec } from '../src/agents/runner.ts';
import { canStartRun } from '../src/budget.ts';
import { runAgent } from '../src/context.ts';
import { claimTicket, getJob, kvGet, openDb, spentOnTicket, spentSince } from '../src/db.ts';
import { makeEnv } from './helpers.ts';

function result(session: string, cost: number, input = 100, output = 10, cache = 20, subtype = 'success'): SDKMessage {
  return {
    type: 'result', subtype, is_error: subtype !== 'success', session_id: session, total_cost_usd: cost,
    num_turns: 1, result: 'done', modelUsage: { sonnet: { inputTokens: input, outputTokens: output, cacheReadInputTokens: cache } },
  } as unknown as SDKMessage;
}

function env() {
  return makeEnv({ config: { budget: { perRunUsd: 1.5, perTicketUsd: 3, dailyUsd: 10, monthlyUsd: 20 } } });
}
const spec = (e: ReturnType<typeof env>, resume?: string): AgentRunSpec => ({
  role: 'coding', prompt: 'offline fixture', systemAppend: '', cwd: e.root, model: 'sonnet', mode: 'readonly',
  maxTurns: 1, maxBudgetUsd: 1.5, timeoutMs: 1000, resume,
  sandbox: { enabled: true, failIfUnavailable: true, allowedDomains: [] },
});
const reservations = (e: ReturnType<typeof env>) => (e.ctx.db.prepare('SELECT COUNT(*) n FROM budget_reservations').get() as { n: number }).n;
const baseline = (e: ReturnType<typeof env>, session: string) => kvGet(e.ctx.db, `agent-session-usage:${session}`);

async function call(e: ReturnType<typeof env>, message: SDKMessage, resume?: string, more: Partial<AgentRunSpec> = {}) {
  e.ctx.runner = new ClaudeRunner(async function* () { yield message; });
  return runAgent(e.ctx, { ...spec(e, resume), ...more }, { ticketId: 'ticket' });
}

test('SDK resume totals become per-run cost and token deltas in results, ledger, job totals and budget gates', async () => {
  const e = env();
  // The SDK is replaced, so this fixture needs no git checkout or live accounts.
  const j = claimTicket(e.ctx.db, { ticketId: 'ticket', identifier: 'DEMO-1', project: 'demo', repo: '' }, e.ctx.owner, 60_000)!;
  const messages = [result('coding', 0.302, 100, 10, 20), result('coding', 0.452, 150, 15, 30)];
  const caps: number[] = [];
  e.ctx.runner = new ClaudeRunner(async function* ({ options }) { caps.push(options!.maxBudgetUsd!); yield messages.shift()!; });
  const first = await runAgent(e.ctx, spec(e), { jobId: j.id, ticketId: 'ticket' });
  const resumed = await runAgent(e.ctx, { ...spec(e, 'coding'), maxBudgetUsd: 0.15 }, { jobId: j.id, ticketId: 'ticket' });
  assert.equal(first.costUsd, 0.302);
  assert.ok(Math.abs(resumed.costUsd - 0.15) < 1e-12);
  assert.equal(resumed.inputTokens, 50);
  assert.equal(resumed.outputTokens, 5);
  assert.equal(resumed.cacheReadTokens, 10);
  assert.equal(resumed.usageScope, 'run');
  assert.deepEqual(caps, [1.5, 0.15]);
  assert.equal(spentSince(e.ctx.db, 0), 0.452);
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.452);
  assert.equal(getJob(e.ctx.db, j.id)!.cost_usd, 0.452);
  assert.deepEqual(e.ctx.db.prepare('SELECT session_id, input_tokens, output_tokens, cache_read_tokens FROM usage ORDER BY id').all().map(r => ({ ...r })), [
    { session_id: 'coding', input_tokens: 100, output_tokens: 10, cache_read_tokens: 20 },
    { session_id: 'coding', input_tokens: 50, output_tokens: 5, cache_read_tokens: 10 },
  ]);
  assert.equal(canStartRun(e.ctx.db, e.ctx.cfg, 'ticket').ok, true);
  assert.equal(reservations(e), 0);
});

test('DEV-17 audit: two resumed coding sessions and four fresh reviews total $2.284 and stay below $3', async () => {
  const e = env();
  for (const [session, costs] of [['coding-A', [0.402, 0.628]], ['coding-B', [0.215, 0.276, 0.335, 0.452, 0.478]]] as const) {
    for (const [i, cost] of costs.entries()) await call(e, result(session, cost, 100 + i * 10, 10 + i, 20 + i), i ? session : undefined);
  }
  for (const [i, cost] of [0.339, 0.455, 0.203, 0.181].entries()) await call(e, result(`review-${i}`, cost), undefined, { role: 'review', model: 'opus' });
  assert.ok(Math.abs(spentOnTicket(e.ctx.db, 'ticket') - 2.284) < 1e-12);
  assert.ok(Math.abs(spentSince(e.ctx.db, 0) - 2.284) < 1e-12);
  const gate = canStartRun(e.ctx.db, e.ctx.cfg, 'ticket');
  assert.equal(gate.ok, true);
  assert.ok(Math.abs(gate.allowanceUsd - 0.716) < 1e-12);
});

test('session baseline persists across a database reopen and a new runner instance', async () => {
  const e = env();
  await call(e, result('persisted', 0.302));
  e.ctx.db.close();
  e.ctx.db = openDb(join(e.ctx.cfg.dataDir, 'autodev.db'));
  const resumed = await call(e, result('persisted', 0.452, 150, 15, 30), 'persisted');
  assert.ok(Math.abs(resumed.costUsd - 0.15) < 1e-12);
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.452);
});

test('same session totals repeated add no spend; a new session ID is charged in full', async () => {
  const e = env();
  await call(e, result('old', 0.3));
  assert.equal((await call(e, result('old', 0.3), 'old')).costUsd, 0);
  assert.equal((await call(e, result('new', 0.2), 'old')).costUsd, 0.2);
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.5);
});

test('a terminal budget error records its incremental cost, including genuine overshoot', async () => {
  const e = env();
  await call(e, result('budget', 0.3));
  const out = await call(e, result('budget', 0.48, 200, 20, 40, 'error_max_budget_usd'), 'budget', { maxBudgetUsd: 0.15 });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'budget');
  assert.ok(Math.abs(out.costUsd - 0.18) < 1e-12);
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.48);
  assert.equal(reservations(e), 0);
});

test('a lost terminal result leaves its reservation and baseline intact, even after a later successful resume', async () => {
  const e = env();
  await call(e, result('lost', 0.302));
  const saved = baseline(e, 'lost');
  e.ctx.runner = new ClaudeRunner(async function* () { throw new Error('lost result'); });
  const lost = await runAgent(e.ctx, { ...spec(e, 'lost'), maxBudgetUsd: 0.15 }, { ticketId: 'ticket' });
  assert.equal(lost.usageComplete, false);
  assert.equal(baseline(e, 'lost'), saved);
  assert.equal(reservations(e), 1);
  await call(e, result('lost', 0.452, 150, 15, 30), 'lost');
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.452);
  assert.equal(reservations(e), 1, 'unknown earlier reservation is never silently released');
});

test('zeroed crash results and decreased token totals never reset the saved baseline or release reservations', async () => {
  const e = env();
  await call(e, result('zeroed', 0.302));
  const saved = baseline(e, 'zeroed');
  const zero = await call(e, result('zeroed', 0, 0, 0, 0, 'error_during_execution'), 'zeroed', { maxBudgetUsd: 0.1 });
  assert.equal(zero.usageComplete, false);
  assert.equal(baseline(e, 'zeroed'), saved);
  const decreased = await call(e, result('zeroed', 0.4, 99, 20, 40), 'zeroed', { maxBudgetUsd: 0.1 });
  assert.equal(decreased.usageComplete, false);
  assert.equal(baseline(e, 'zeroed'), saved);
  assert.equal(reservations(e), 2);
  const out = await call(e, result('zeroed', 0.452, 150, 15, 30), 'zeroed');
  assert.ok(Math.abs(out.costUsd - 0.15) < 1e-12);
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.452);
});

test('malformed session results keep the reservation instead of freeing unknown spend', async () => {
  for (const message of [result('', 0.2), result('invalid', NaN), result('invalid', -0.1), result('invalid', 0.2, -1)]) {
    const e = env();
    const out = await call(e, message);
    assert.equal(out.ok, false);
    assert.equal(out.usageComplete, false);
    assert.equal(reservations(e), 1);
    assert.equal(baseline(e, 'invalid'), null);
  }
});

test('an upgraded ledger preserves historical usage; a resumed session without a baseline is charged conservatively once', async () => {
  const e = env();
  e.ctx.db.exec('ALTER TABLE usage DROP COLUMN session_id');
  e.ctx.db.prepare("INSERT INTO usage (ts, ticket_id, role, cost_usd) VALUES (1, 'ticket', 'coding', 0.302)").run();
  e.ctx.db.close();
  e.ctx.db = openDb(join(e.ctx.cfg.dataDir, 'autodev.db'));
  const historical = e.ctx.db.prepare('SELECT * FROM usage WHERE id = 1').get();
  assert.equal(historical!.cost_usd, 0.302);
  assert.equal(historical!.session_id, null);
  assert.equal((await call(e, result('legacy', 0.452), 'legacy')).costUsd, 0.452);
  const next = await call(e, result('legacy', 0.478, 110, 11, 21), 'legacy');
  assert.ok(Math.abs(next.costUsd - 0.026) < 1e-12);
  assert.deepEqual(e.ctx.db.prepare('SELECT * FROM usage WHERE id = 1').get(), historical);
  assert.equal(e.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'budget.session_baseline_missing'").get()!.n, 1);
});

test('usage insertion failure rolls back the session baseline and retains the reservation', async () => {
  const e = env();
  e.ctx.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'usage fixture failure'); END");
  await assert.rejects(call(e, result('atomic', 0.302)), /usage fixture failure/);
  assert.equal(baseline(e, 'atomic'), null);
  assert.equal(spentSince(e.ctx.db, 0), 0);
  assert.equal(reservations(e), 1);
});

test('session accounting warnings retain job and ticket identifiers for auditing', async () => {
  const e = env();
  const j = claimTicket(e.ctx.db, { ticketId: 'ticket', identifier: 'DEMO-1', project: 'demo', repo: '' }, e.ctx.owner, 60_000)!;
  const messages = [result('legacy', 0.302), result('legacy', 0, 0, 0, 0, 'error_during_execution')];
  e.ctx.runner = new ClaudeRunner(async function* () { yield messages.shift()!; });
  for (let i = 0; i < 2; i++) await runAgent(e.ctx, { ...spec(e, 'legacy'), maxBudgetUsd: 0.5 }, { jobId: j.id, ticketId: 'ticket' });
  assert.deepEqual(e.ctx.db.prepare("SELECT type, job_id, ticket_id FROM events WHERE type IN ('budget.session_baseline_missing', 'budget.session_usage_unknown') ORDER BY id").all().map(r => ({ ...r })), [
    { type: 'budget.session_baseline_missing', job_id: j.id, ticket_id: 'ticket' },
    { type: 'budget.session_usage_unknown', job_id: j.id, ticket_id: 'ticket' },
  ]);
});

test('per-run fake runner results stay incremental even when their fixture session ID repeats', async () => {
  const e = env();
  e.runner.behaviors.coding = async () => ({ costUsd: 0.1 });
  await runAgent(e.ctx, spec(e), { ticketId: 'ticket' });
  await runAgent(e.ctx, spec(e, 'fake-session'), { ticketId: 'ticket' });
  assert.equal(spentOnTicket(e.ctx.db, 'ticket'), 0.2);
});

test('the SDK adapter replaces cumulative token totals if more than one result arrives', async () => {
  const e = env();
  e.ctx.runner = new ClaudeRunner(async function* () {
    yield result('stream', 0.2, 100, 10, 20);
    yield result('stream', 0.3, 150, 15, 30);
  });
  const out = await runAgent(e.ctx, spec(e), { ticketId: 'ticket' });
  assert.equal(out.costUsd, 0.3);
  assert.equal(out.inputTokens, 150);
  assert.equal(out.outputTokens, 15);
  assert.equal(out.cacheReadTokens, 30);
});
