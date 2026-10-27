import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { draftPlan, missingValidation, orderAfterScaffold, publishPlan, reconcilePlanValidation, scaffoldTicket } from '../src/planning.ts';
import type { Plan, PlanTicket } from '../src/agents/schemas.ts';
import { makeEnv } from './helpers.ts';

// A repository that cannot run its validate commands yet (no package.json for `npm test`): every ticket of a plan but the
// one that establishes validation must wait for it, or its validation fails and triage files a duplicate scaffold.

const ticket = (key: string, more: Partial<PlanTicket> = {}): PlanTicket => ({
  key, title: `Ticket ${key}`, objective: 'o', problem: 'p', technicalContext: 'c', acceptanceCriteria: ['a'], testing: ['t'], dependsOn: [],
  priority: 2, complexity: 2, relevantFiles: [], security: 'none', definitionOfDone: ['d'], parallelizable: true, ...more,
});
const plan = (tickets: PlanTicket[]): Plan => ({
  projectKey: 'demo', summary: 's', approach: 'a', reuse: [], requirements: ['r'], risks: [], openQuestions: [], duplicates: [], tickets,
});
// The scaffold is deliberately not the first ticket: it is identified by its field, never by position.
const docsFirst = () => plan([
  ticket('T1', { title: 'Write the architecture ADR' }),
  ticket('T2', { title: 'Scaffold the service with npm test', establishesValidation: true }),
  ticket('T3', { title: 'Add the inbound email webhook', dependsOn: ['T1'] }),
]);
const npmEnv = (structured: () => Plan) => makeEnv({ project: { validate: ['npm ci', 'npm test'] }, behaviors: { planning: async () => ({ structured: structured() }) } });
const deps = (p: Plan) => Object.fromEntries(p.tickets.map((t) => [t.key, t.dependsOn]));
const planStatus = (e: ReturnType<typeof makeEnv>) => (e.ctx.db.prepare('SELECT status FROM plans ORDER BY created_at DESC LIMIT 1').get() as { status: string }).status;

test('in a repository without validation, every other ticket depends on the scaffold, which depends on nothing', async () => {
  let prompt = '';
  const e = makeEnv({ project: { validate: ['npm ci', 'npm test'] }, behaviors: { planning: async (spec) => { prompt = spec.prompt; return { structured: docsFirst() }; } } });
  const p = await draftPlan(e.ctx, 'Email support service', 'demo');
  assert.match(prompt, /cannot run its validate commands yet \(package\.json missing for `npm ci`; package\.json missing for `npm test`\)/);
  assert.match(prompt, /establishesValidation: true/);
  assert.deepEqual(deps(p.plan), { T1: ['T2'], T2: [], T3: ['T1', 'T2'] });
  assert.match(p.markdown, /Validation scaffold: T2\./);
  const pub = await publishPlan(e.ctx, p.id);
  const [t1, t2, t3] = ['T1', 'T2', 'T3'].map((k) => pub.created.find((t) => t.title === p.plan.tickets.find((x) => x.key === k)!.title)!);
  assert.deepEqual((await e.tracker.getTicket(t1!.id))!.blockedBy, [t2!.id]);
  assert.deepEqual((await e.tracker.getTicket(t2!.id))!.blockedBy, []);
  assert.deepEqual([...(await e.tracker.getTicket(t3!.id))!.blockedBy].sort(), [t1!.id, t2!.id].sort());
});

test('a repository that can already validate keeps the planner\'s dependencies', async () => {
  const e = makeEnv({ project: { validate: ['test -f CHANGES.md'] }, behaviors: { planning: async () => ({ structured: docsFirst() }) } });
  const p = await draftPlan(e.ctx, 'Email support service', 'demo');
  assert.deepEqual(deps(p.plan), { T1: [], T2: [], T3: ['T1'] });
  assert.ok(p.plan.tickets.every((t) => !t.establishesValidation));
  assert.doesNotMatch(p.markdown, /Validation scaffold/);
});

test('a plan without exactly one scaffold, or whose scaffold depends on another ticket, is rejected', async () => {
  const unmarked = () => plan([ticket('T1'), ticket('T2')]);
  const twice = () => plan([ticket('T1', { establishesValidation: true }), ticket('T2', { establishesValidation: true })]);
  const cyclic = () => plan([ticket('T1'), ticket('T2', { establishesValidation: true, dependsOn: ['T1'] })]);
  for (const [make, why] of [[unmarked, /found none/], [twice, /found T1, T2/], [cyclic, /dependency cycle/]] as const) {
    const e = npmEnv(make);
    await assert.rejects(draftPlan(e.ctx, 'idea', 'demo'), why);
    assert.equal(planStatus(e), 'failed');
  }
  assert.throws(() => orderAfterScaffold(cyclic(), 'T2'), /dependency cycle/);
  assert.throws(() => orderAfterScaffold(docsFirst(), 'T9'), /not a ticket/);
  assert.equal(scaffoldTicket(docsFirst()).key, 'T2');
});

test('missingValidation knows which files each tool needs and ignores commands it cannot judge', () => {
  const none = () => false;
  assert.deepEqual(missingValidation([], none), []);
  assert.deepEqual(missingValidation(['test -f CHANGES.md', 'pytest'], none), []);
  assert.deepEqual(missingValidation(['cd app && CI=1 npm test'], none), ['package.json missing for `cd app && CI=1 npm test`']);
  assert.deepEqual(missingValidation(['npm test', 'make lint'], (f) => f === 'package.json'), ['Makefile or makefile or GNUmakefile missing for `make lint`']);
  assert.deepEqual(missingValidation(['cargo test', 'go test ./...'], (f) => f === 'go.mod' || f === 'Cargo.toml'), []);
});

/** A plan published before validation ordering existed: no scaffold links (and no establishesValidation field). */
async function legacyPlan(e: ReturnType<typeof makeEnv>) {
  const id = randomUUID();
  const legacy = plan([ticket('T1', { title: 'Write the architecture ADR' }), ticket('T2', { title: 'Scaffold the service' }), ticket('T3', { title: 'Add the webhook', dependsOn: ['T1'] })]);
  for (const t of legacy.tickets) delete t.establishesValidation;
  e.ctx.db.prepare(`INSERT INTO plans (id, project, idea, status, plan_json, created_at, updated_at) VALUES (?, 'demo', 'Email support', 'draft', ?, 1, 1)`).run(id, JSON.stringify(legacy));
  const pub = await publishPlan(e.ctx, id);
  const byKey = Object.fromEntries(legacy.tickets.map((t) => [t.key, pub.created.find((c) => c.title === t.title)!]));
  return { id, byKey };
}
const links = async (e: ReturnType<typeof makeEnv>, ids: string[]) => Promise.all(ids.map(async (id) => [...(await e.tracker.getTicket(id))!.blockedBy].sort()));

test('plan-reconcile lists missing scaffold links as a dry run and writes them only with --apply', async () => {
  const e = npmEnv(docsFirst);
  const { id, byKey } = await legacyPlan(e);
  const ids = ['T1', 'T2', 'T3'].map((k) => byKey[k]!.id);
  const before = await links(e, ids);
  await assert.rejects(reconcilePlanValidation(e.ctx, id), /pass --scaffold/);
  await assert.rejects(reconcilePlanValidation(e.ctx, id, { scaffold: 'NOPE-1' }), /neither a key nor a ticket/);

  const dry = await reconcilePlanValidation(e.ctx, id, { scaffold: byKey.T2!.identifier });
  assert.deepEqual(dry.scaffold, { key: 'T2', identifier: byKey.T2!.identifier });
  assert.deepEqual(dry.missing.map((m) => m.key), ['T1', 'T3']);
  assert.equal(dry.applied, false);
  assert.deepEqual(await links(e, ids), before, 'a dry run writes nothing');

  // Already finished tickets are left alone.
  await e.tracker.setStatus(byKey.T3!.id, 'done');
  const applied = await reconcilePlanValidation(e.ctx, id, { scaffold: 'T2', apply: true });
  assert.deepEqual(applied.missing.map((m) => m.identifier), [byKey.T1!.identifier]);
  assert.deepEqual(await links(e, ids), [[byKey.T2!.id], [], before[2]]);
  assert.deepEqual((await reconcilePlanValidation(e.ctx, id, { scaffold: 'T2' })).missing, [], 'idempotent');
});

test('plan-reconcile refuses a link that would close a cycle, and does nothing once the base can validate', async () => {
  const e = npmEnv(docsFirst);
  const { id, byKey } = await legacyPlan(e);
  await e.tracker.addBlockedBy(byKey.T2!.id, byKey.T3!.id);
  await assert.rejects(reconcilePlanValidation(e.ctx, id, { scaffold: 'T2', apply: true }), /dependency cycle/);
  assert.deepEqual((await e.tracker.getTicket(byKey.T1!.id))!.blockedBy, []);

  const dir = mkdtempSync(join(tmpdir(), 'autodev-base-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { cwd: dir, stdio: 'pipe' });
  git('clone', '-q', e.repo, '.');
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  git('add', '-A'); git('commit', '-qm', 'scaffold'); git('push', '-q', 'origin', 'main');
  const r = await reconcilePlanValidation(e.ctx, id, { scaffold: 'T2', apply: true });
  assert.equal(r.scaffold, null);
  assert.match(r.note, /can already run the validate commands/);
});
