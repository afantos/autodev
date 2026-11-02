import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { parseConfig } from '../src/config.ts';
import { humanDecisions, requirementsHash } from '../src/automerge.ts';
import { resolveQuestion } from '../src/decisions.ts';
import type { Job } from '../src/types.ts';

const question = 'Should the parser helpers use a dedicated module?';
const recommendation = {
  category: 'architecture_change', options: [{ name: 'Dedicated module', pros: ['simple'], cons: ['needs validation'] }],
  recommendation: 'Dedicated module', reasoning: 'A trial hypothesis', evidence: ['docs/product-spec.md'],
  confidence: 0.9, requiresHuman: true, significantArchitecture: false,
  futureTests: ['Verify the parser produces the same output and rejects malformed input.'],
};

for (const mode of ['ask', 'continue', 'missing-tests'] as const) {
  test(`decision mode ${mode}: end-to-end question, persistence and reviewer context`, async () => {
    let reply = '';
    const env = makeEnv({
      project: { decisionMode: mode === 'ask' ? 'ask' : 'continue' },
      behaviors: {
        decision: async () => ({ structured: { ...recommendation, futureTests: mode === 'missing-tests' ? [] : recommendation.futureTests } }),
        coding: async (spec, n) => {
          reply = await spec.tools!.find(t => t.name === 'request_decision')!.handler({ question, context: 'Module layout is unresolved', options: ['Dedicated module'] }) as string;
          return DEFAULTS.coding!(spec, n);
        },
      },
    });
    const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Choose module', description: '', status: 'ready', priority: 2 });
    await env.cycle();
    const j = job(env, t.identifier);
    const rows = env.ctx.db.prepare('SELECT * FROM decisions').all() as Record<string, any>[];
    assert.equal(rows.length, mode === 'missing-tests' ? 2 : 1);
    if (mode !== 'continue') {
      assert.equal(j.status, mode === 'ask' ? 'blocked' : 'queued');
      assert.equal(rows[0].status, mode === 'ask' ? 'pending_human' : 'failed');
      assert.equal(rows[0].authority, 'pending');
      assert.equal(rows[0].adr_path, null);
      return;
    }
    assert.match(reply, /DECIDED \(delegated/);
    assert.equal(j.status, 'awaiting_merge', j.error);
    assert.equal(rows[0].status, 'resolved');
    assert.equal(rows[0].authority, 'delegated');
    assert.match(rows[0].reasoning, /Future tests \(pending\)/);
    const doc = readFileSync(join(j.worktree, rows[0].adr_path), 'utf8');
    assert.match(doc, /decisionMode=continue/);
    assert.match(doc, /- \[ \] Verify the parser/);
    assert.match(doc, /needs validation/);
    assert.match(env.scm.prBody(j.pr_number), /delegated/);
    assert.match(humanDecisions(env.ctx, t)[0].decision, /Delegated/);
    const hash = requirementsHash(env.ctx, t);
    env.ctx.cfg.projects[0].decisionMode = 'ask';
    assert.equal(humanDecisions(env.ctx, t).length, 0);
    assert.notEqual(requirementsHash(env.ctx, t), hash);
    const next = await resolveQuestion(env.ctx, { job: j as Job, ticket: t, project: env.ctx.cfg.projects[0], worktree: j.worktree, question, context: '', options: [] });
    assert.equal(next.kind, 'blocked', 'switching to ask must not reuse delegated authority');
    env.ctx.cfg.projects[0].decisionMode = 'continue';
    // A pending question with a new wording is re-researched when continue is enabled.
    const changed = question + ' for the batch parser?';
    env.ctx.cfg.projects[0].decisionMode = 'ask';
    const pending = await resolveQuestion(env.ctx, { job: j as Job, ticket: t, project: env.ctx.cfg.projects[0], worktree: j.worktree, question: changed, context: '', options: [] });
    assert.equal(pending.kind, 'blocked');
    env.ctx.cfg.projects[0].decisionMode = 'continue';
    env.ctx.cfg.limits.maxDecisionsPerTicket = 10;
    const resumed = await resolveQuestion(env.ctx, { job: j as Job, ticket: t, project: env.ctx.cfg.projects[0], worktree: j.worktree, question: changed, context: '', options: [] });
    assert.equal(resumed.kind, 'answered');
    assert.equal(env.ctx.db.prepare('SELECT status FROM decisions WHERE id = ?').get(pending.decisionId!)?.status, 'superseded');
  });
}

test('decision mode defaults to ask and rejects misspellings', () => {
  assert.equal(parseConfig({ projects: [{ key: 'demo', repo: 'a/b' }] }, '/tmp').projects[0].decisionMode, 'ask');
  assert.throws(() => parseConfig({ projects: [{ key: 'demo', repo: 'a/b', decisionMode: 'contineu' }] }, '/tmp'));
});

test('documentation failure never releases delegated authority', async () => {
  const { writeFileSync } = await import('node:fs');
  const env = makeEnv({ project: { decisionMode: 'continue' }, behaviors: { decision: async () => ({ structured: recommendation }) } });
  const t = await env.tracker.createTicket({ projectKey: 'demo', title: 'Document decision', description: '', status: 'ready', priority: 2 });
  await env.cycle();
  const j = job(env, t.identifier);
  writeFileSync(join(j.worktree, 'docs'), 'a file prevents documentation');
  await assert.rejects(resolveQuestion(env.ctx, { job: j as Job, ticket: t, project: env.ctx.cfg.projects[0], worktree: j.worktree, question, context: '', options: [] }), /real directory/);
  const d = env.ctx.db.prepare('SELECT status, authority FROM decisions').get();
  assert.equal(d?.status, 'failed');
  assert.notEqual(d?.authority, 'delegated');
});
