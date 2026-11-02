import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { CONTINUE_SAME_BLOCKER_LIMIT } from '../src/pipeline.ts';
import { DEFAULTS } from '../src/agents/fake.ts';

const done = (files: string[]) => ({ structured: { status: 'completed', summary: 'done', filesChanged: files, testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } });

// Reproduces the 2026-11-02 LWC-462 loop: a follow-up ticket was dispatched before the ticket whose code it fixes had
// merged. The coding agent stopped ("the base lacks DEMO-1's code"), continue answered from a cached decision and
// requeued it, and the same stop repeated about ten times, each a paid coding run.
test('continue parks a job that keeps hitting the same blocker, survives a restart, and resumes once the dependency is Done', async () => {
  let prerequisiteMerged = false;
  let codingRuns = 0;
  const e = makeEnv({
    project: { decisionMode: 'continue' },
    behaviors: {
      coding: async (spec, n) => {
        codingRuns++;
        if (!prerequisiteMerged) {
          return { structured: { status: 'blocked', summary: 'prerequisite missing', filesChanged: [], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [],
            blocker: 'The base lacks the checkout code from DEMO-1, which this ticket fixes. End this run as blocked until DEMO-1 merges?' } };
        }
        return DEFAULTS.coding!(spec, n);
      },
    },
  });
  const prerequisite = await e.tracker.createTicket({ projectKey: 'demo', title: 'Checkout page', description: 'Build it.', status: 'backlog', priority: 2 });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Fix checkout pending payments', description: 'Fix the checkout from DEMO-1.', status: 'ready', priority: 2 });
  assert.equal(prerequisite.identifier, 'DEMO-1');

  const codingFor = () => codingRuns;
  const paid = () => e.runner.calls.length;
  for (let i = 0; i < 8; i++) await e.cycle();
  let j = job(e, t.identifier);
  assert.equal(j.status, 'blocked', j.error ?? '');
  assert.ok(codingFor() <= CONTINUE_SAME_BLOCKER_LIMIT, `coding ran ${codingFor()} times`);
  assert.match(JSON.parse(j.blocked_reason!).reason, /Parked: .*DEMO-1/);
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'blocked');

  // While parked: more ticks and a process restart start no agent run of any kind.
  const before = paid();
  for (let i = 0; i < 4; i++) await e.cycle();
  const restarted = new Orchestrator(e.ctx);
  for (let i = 0; i < 4; i++) { await restarted.tick(); await restarted.drain(Infinity); }
  assert.equal(paid(), before, 'no agent calls while parked');
  assert.equal(job(e, t.identifier).status, 'blocked');

  // The prerequisite lands: one resume, and the work completes.
  prerequisiteMerged = true;
  await e.tracker.setStatus(prerequisite.id, 'done');
  for (let i = 0; i < 4; i++) { await restarted.tick(); await restarted.drain(Infinity); }
  j = job(e, t.identifier);
  assert.notEqual(j.status, 'blocked', j.blocked_reason ?? '');
  assert.equal(codingFor(), CONTINUE_SAME_BLOCKER_LIMIT + 1);
  assert.ok(['awaiting_merge', 'done', 'waiting_ci'].includes(j.status), `status ${j.status}`);
});

test('continue: blockers whose wording keeps changing still park at the total limit', async () => {
  let n = 0;
  const e = makeEnv({
    project: { decisionMode: 'continue' },
    behaviors: {
      coding: async () => ({ structured: { status: 'blocked', summary: 'stuck', filesChanged: [], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [],
        blocker: `Variant ${['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'][n++ % 10]} of an unclear requirement: which layout?` } }),
      decision: async () => ({ structured: { category: 'internal_structure', options: [{ name: 'Grid', pros: ['simple'], cons: [] }], recommendation: 'Grid',
        reasoning: 'Matches existing pages.', evidence: ['src/'], confidence: 0.9, requiresHuman: false, significantArchitecture: false,
        futureTests: ['Verify the grid renders with zero and many items.'] } }),
    },
  });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Unclear', description: 'Do it.', status: 'ready', priority: 2 });
  for (let i = 0; i < 20; i++) await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(JSON.parse(j.blocked_reason!).reason, /Stopped: \d+ automatic stops on this job/);
  const runs = e.runner.calls.filter(c => c.role === 'coding').length;
  for (let i = 0; i < 4; i++) await e.cycle();
  assert.equal(e.runner.calls.filter(c => c.role === 'coding').length, runs);
});
