import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';

// 2026-10-26: the shared Linear API key hit its 2,500 requests/hour limit. Each reconcile tick fetched every Done or
// Canceled dependency ticket individually (one request per link), for both teams, every 30 seconds. Those lookups are
// now cached for loop.dependencyCacheSeconds.

test('reconcile fetches a Done dependency once per cache window, not once per tick', async () => {
  const e = makeEnv({ config: { loop: { dependencyCacheSeconds: 600 } } });
  const done = await e.tracker.createTicket({ projectKey: 'demo', title: 'Done dep', description: '', status: 'done', priority: 2 });
  const ready = await e.tracker.createTicket({ projectKey: 'demo', title: 'Blocked by done', description: '', status: 'ready', priority: 2 });
  await e.tracker.addBlockedBy(ready.id, done.id);
  const real = e.tracker.getTicket.bind(e.tracker);
  const fetched: string[] = [];
  e.ctx.tracker.getTicket = async (id: string) => { fetched.push(id); return real(id); };
  const first = await e.orch.reconcile();
  assert.ok(first.has(done.id), 'the done dependency is part of the snapshot');
  assert.ok(first.has(ready.id));
  const afterFirst = fetched.filter((id) => id === done.id).length;
  assert.equal(afterFirst, 1, 'one Linear request for the dependency on the first tick');
  await e.orch.reconcile();
  await e.orch.reconcile();
  assert.equal(fetched.filter((id) => id === done.id).length, 1, 'later ticks reuse the cached dependency');
  assert.ok((await e.orch.reconcile()).has(done.id), 'the cached dependency still appears in the snapshot');
});

test('dependencyCacheSeconds: 0 disables the cache', async () => {
  const e = makeEnv({ config: { loop: { dependencyCacheSeconds: 0 } } });
  const done = await e.tracker.createTicket({ projectKey: 'demo', title: 'Done dep', description: '', status: 'done', priority: 2 });
  const blocked = await e.tracker.createTicket({ projectKey: 'demo', title: 'Blocked', description: '', status: 'ready', priority: 2 });
  await e.tracker.addBlockedBy(blocked.id, done.id);
  const real = e.tracker.getTicket.bind(e.tracker);
  let n = 0;
  e.ctx.tracker.getTicket = async (id: string) => { if (id === done.id) n++; return real(id); };
  await e.orch.reconcile(); await e.orch.reconcile();
  assert.equal(n, 2);
});
