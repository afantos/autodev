import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLease, claimTicket, expiredLeases, heartbeat, openDb, releaseLease, updateJob } from '../src/db.ts';
import { rank, relevantFiles } from '../src/scheduler.ts';
import { authorize, mentionedInstalls } from '../src/policy.ts';
import { parseConfig } from '../src/config.ts';
import { scanSecrets, assertionDelta } from '../src/pipeline.ts';
import { normalizeQuestion } from '../src/decisions.ts';
import { similarity, validatePlanGraph } from '../src/planning.ts';
import type { Decision, Plan } from '../src/agents/schemas.ts';
import type { Job, Ticket } from '../src/types.ts';

const cfg = parseConfig({ projects: [{ key: 'app', repo: 'o/app', maxConcurrent: 2, approvedDependencies: ['zod'] }, { key: 'web', repo: 'o/web', stackedBranches: true }] }, '/tmp');

const t = (id: string, p: Partial<Ticket> = {}): Ticket => ({
  id, identifier: id.toUpperCase(), title: id, description: '', status: 'ready', priority: 3, estimate: 2, labels: [], projectKey: 'app',
  blockedBy: [], blocks: [], parentId: null, url: '', createdAt: new Date().toISOString(), updatedAt: '', ...p,
});

test('claims are atomic: a ticket can only have one active job', () => {
  const db = openDb(':memory:');
  const a = claimTicket(db, { ticketId: 't1', identifier: 'T-1', project: 'app', repo: 'o/app' }, 'w1', 60_000);
  const b = claimTicket(db, { ticketId: 't1', identifier: 'T-1', project: 'app', repo: 'o/app' }, 'w2', 60_000);
  assert.ok(a);
  assert.equal(b, null);
  // After the job finishes, the ticket can be claimed again (e.g. moved back to Ready).
  updateJob(db, a!.id, { status: 'done' });
  assert.ok(claimTicket(db, { ticketId: 't1', identifier: 'T-1', project: 'app', repo: 'o/app' }, 'w2', 60_000));
});

test('leases: only the owner heartbeats; expired leases are recoverable; others cannot steal a live lease', () => {
  const db = openDb(':memory:');
  const j = claimTicket(db, { ticketId: 't1', identifier: 'T-1', project: 'app', repo: 'o/app' }, 'w1', 60_000)!;
  assert.equal(heartbeat(db, j.id, 'w2', 60_000), false);
  assert.equal(heartbeat(db, j.id, 'w1', 60_000), true);
  assert.equal(expiredLeases(db).length, 0);
  releaseLease(db, j.id, 'w1', 'queued');
  assert.equal(acquireLease(db, j.id, 'w2', 60_000, ['queued']), true);
  assert.equal(acquireLease(db, j.id, 'w3', 60_000, ['queued', 'running']), false, 'live lease held by w2');
  updateJob(db, j.id, { lease_expires_at: Date.now() - 1 });
  assert.equal(expiredLeases(db).length, 1);
  assert.equal(acquireLease(db, j.id, 'w3', 60_000, ['running']), true, 'expired lease can be taken over');
  assert.equal(heartbeat(db, j.id, 'w2', 60_000), false, 'old owner must stop');
});

test('scheduler: dependencies must be merged (done), not just implemented', () => {
  const dep = t('a', { status: 'review', blocks: ['b'] });
  const b = t('b', { blockedBy: ['a'] });
  const byId = new Map([[dep.id, dep], [b.id, b]]);
  let r = rank({ ready: [b], byId, activeJobs: [], cfg });
  assert.equal(r.eligible.length, 0);
  assert.match(r.skipped[0].reason, /waiting for A \(review\) to merge/);
  byId.set('a', { ...dep, status: 'done' });
  r = rank({ ready: [b], byId, activeJobs: [], cfg });
  assert.equal(r.eligible.length, 1);
});

test('scheduler: stacked branches only where enabled and the dependency PR exists', () => {
  const dep = t('a', { status: 'review', projectKey: 'web', blocks: ['b'] });
  const b = t('b', { blockedBy: ['a'], projectKey: 'web' });
  const depJob = { ticket_id: 'a', status: 'awaiting_merge', branch: 'autodev/a', project: 'web', repo: 'o/web' } as Job;
  const r = rank({ ready: [b], byId: new Map([[dep.id, dep], [b.id, b]]), activeJobs: [depJob], cfg });
  assert.equal(r.eligible[0]?.baseBranchOverride, 'autodev/a');
});

test('scheduler: prefers urgent, unblocking, small work over age', () => {
  const old = t('old', { priority: 4, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  const urgent = t('urgent', { priority: 1, estimate: 3 });
  const unblocker = t('unb', { priority: 3, blocks: ['x', 'y'] });
  const x = t('x', { status: 'backlog', blockedBy: ['unb'] }); const y = t('y', { status: 'backlog', blockedBy: ['unb'] });
  const byId = new Map([old, urgent, unblocker, x, y].map((v) => [v.id, v]));
  const r = rank({ ready: [old, urgent, unblocker], byId, activeJobs: [], cfg });
  assert.deepEqual(r.eligible.map((c) => c.ticket.id), ['urgent', 'unb', 'old']);
});

test('scheduler: avoids concurrent edits to the same files and respects project capacity', () => {
  const desc = '## Relevant files\n- `src/billing/plan.ts`\n- src/db/\n\n## Other';
  assert.deepEqual(relevantFiles(t('z', { description: desc })), ['src/billing/plan.ts', 'src/db/']);
  const running = t('r', { description: '## Relevant files\n- `src/db/schema.ts`' });
  const cand = t('c', { description: desc });
  const j = { ticket_id: 'r', ticket_identifier: 'R', status: 'running', project: 'app', repo: 'o/app' } as Job;
  const r = rank({ ready: [cand], byId: new Map([[running.id, running], [cand.id, cand]]), activeJobs: [j], cfg });
  assert.match(r.skipped[0].reason, /file conflict/);
  const full = rank({ ready: [t('q')], byId: new Map(), activeJobs: [j, { ...j, ticket_id: 'r2' }], cfg });
  assert.match(full.skipped[0].reason, /capacity/);
});

const dec = (p: Partial<Decision> = {}): Decision => ({ category: 'internal_structure', options: [{ name: 'a', pros: [], cons: [] }], recommendation: 'Put helpers in src/lib', reasoning: 'matches existing layout', evidence: [], confidence: 0.9, requiresHuman: false, significantArchitecture: false, ...p });

test('policy: routine decisions are auto; human categories, keywords, low confidence and new deps escalate', () => {
  const p = cfg.projects[0];
  assert.equal(authorize(dec(), 'Where should helpers live?', p, cfg, null).authority, 'auto');
  assert.equal(authorize(dec({ category: 'billing_pricing' }), 'q', p, cfg, null).authority, 'human');
  assert.equal(authorize(dec(), 'What should the Business plan pricing be?', p, cfg, null).authority, 'human');
  assert.equal(authorize(dec({ recommendation: 'Drop table sessions and recreate it' }), 'q', p, cfg, null).authority, 'human');
  assert.equal(authorize(dec({ confidence: 0.4 }), 'q', p, cfg, null).authority, 'human');
  assert.equal(authorize(dec({ requiresHuman: true }), 'q', p, cfg, null).authority, 'human', 'agent flag can only escalate');
  assert.equal(authorize(dec({ recommendation: 'Run npm install left-pad' }), 'q', p, cfg, null).authority, 'human');
  assert.equal(authorize(dec({ recommendation: 'Run npm install zod' }), 'q', p, cfg, null).authority, 'auto', 'approved dependency');
  assert.deepEqual(mentionedInstalls('pnpm add -D vitest@1.2 msw'), ['vitest', 'msw']);
});

test('secret scanning and assertion-weakening detection', () => {
  assert.deepEqual(scanSecrets('+const k = "sk_live_abcdefghijklmnopqrstuvwx";'), ['Stripe live key']);
  assert.deepEqual(scanSecrets('-const k = "sk_live_abcdefghijklmnopqrstuvwx";'), [], 'removing a secret is fine');
  const diff = '+++ b/test/a.test.ts\n-  expect(a).toBe(1)\n-  expect(b).toBe(2)\n+  expect(a).toBeTruthy()\n';
  assert.equal(assertionDelta(diff), 'removed 2 vs added 1');
});

test('question normalization, similarity, plan graph validation', () => {
  assert.equal(normalizeQuestion('Should we use the Repository pattern?'), normalizeQuestion('use repository pattern'));
  assert.ok(similarity('Add Stripe checkout session endpoint', 'Add Stripe checkout session API endpoint') > 0.7);
  assert.ok(similarity('Centralize plan pricing constants', 'Centralize plan discount rates') >= 0.3, 'same-source paraphrase caught');
  const plan = { tickets: [{ key: 'T1', dependsOn: ['T2'] }, { key: 'T2', dependsOn: ['T1'] }] } as unknown as Plan;
  assert.throws(() => validatePlanGraph(plan), /cycle/);
});
