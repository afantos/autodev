import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStartup } from '../deploy/health.ts';
import { makeEnv } from './helpers.ts';
import { kvSet, logEvent } from '../src/db.ts';

for (const failure of ['none', 'missing-lock', 'wrong-pid', 'stale-lock', 'old-event', 'wrong-owner'] as const) {
  test(`startup health: ${failure}`, () => {
    const e = makeEnv();
    const now = Date.now();
    const owner = `host:${process.pid}:new`;
    if (failure !== 'missing-lock') kvSet(e.ctx.db, 'instance_lock', failure === 'wrong-pid' ? 'host:1:new' : owner);
    if (failure === 'stale-lock') e.ctx.db.prepare("UPDATE kv SET updated_at = ? WHERE k = 'instance_lock'").run(now - 30_000);
    logEvent(e.ctx.db, 'orchestrator.start', `owner=${failure === 'wrong-owner' ? `other:${process.pid}:new` : owner} concurrency=2`);
    if (failure === 'old-event') e.ctx.db.prepare('UPDATE events SET ts = ?').run(now - 30_000);
    const check = () => checkStartup(join(e.ctx.cfg.dataDir, 'autodev.db'), process.pid, now - 1000, now);
    if (failure === 'none') assert.doesNotThrow(check);
    else assert.throws(check, /lock|event/);
    e.ctx.db.close();
  });
}

test('deployment guard starts and heartbeats without tracker, SCM or agent work, then resumes after commit', async (t) => {
  const e = makeEnv();
  const guard = join(mkdtempSync(join(tmpdir(), 'deploy-guard-')), 'pending');
  writeFileSync(guard, 'pending');
  const old = process.env.AUTODEV_DEPLOY_GUARD;
  process.env.AUTODEV_DEPLOY_GUARD = guard;
  t.after(() => { if (old === undefined) delete process.env.AUTODEV_DEPLOY_GUARD; else process.env.AUTODEV_DEPLOY_GUARD = old; e.orch.stop(); });
  let ticks = 0;
  e.orch.tick = async () => { ticks++; e.orch.stop(); };
  const running = e.orch.run();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ticks, 0);
  assert.equal(e.runner.calls.length, 0);
  checkStartup(join(e.ctx.cfg.dataDir, 'autodev.db'), process.pid, Date.now() - 2000);
  rmSync(guard);
  await running;
  assert.equal(ticks, 1);
});
