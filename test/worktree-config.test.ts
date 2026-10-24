import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { WorktreeTamperedError, worktreeConfigMayBeEnabled } from '../src/scm/git.ts';

const tamperEvents = (e: ReturnType<typeof makeEnv>) =>
  (e.ctx.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'security.worktree_tampered'").get() as { n: number }).n;

async function worktree(e: ReturnType<typeof makeEnv>, id: string) {
  const { path } = await e.ctx.ws.ensureWorktree(e.repo, id, `autodev/${id.toLowerCase()}`, 'main');
  return { path, rec: e.ctx.ws.verifiedRecord(path) };
}

// ---------------------------------------------------------------- allowed

test('allowed: an empty config.worktree placeholder (as Claude Code’s sandbox creates) does not block the job', async () => {
  const e = makeEnv({ behaviors: { coding: async (spec, n) => {
    const rec = e.ctx.ws.verifiedRecord(spec.cwd);
    writeFileSync(join(rec.gitDir, 'config.worktree'), ''); // zero-byte regular file, as observed on the droplet
    return DEFAULTS.coding!(spec, n);
  } } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Placeholder', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge', j.blocked_reason ?? j.error);
  assert.equal(tamperEvents(e), 0);
});

test('allowed: verifiedRecord accepts a zero-byte regular config.worktree when per-worktree config is disabled', async () => {
  const e = makeEnv();
  const { path, rec } = await worktree(e, 'CW-OK');
  writeFileSync(join(rec.gitDir, 'config.worktree'), '');
  assert.doesNotThrow(() => e.ctx.ws.verifiedRecord(path));
  appendFileSync(join(rec.commonDir, 'config'), '[extensions]\n\tworktreeConfig = false\n');
  assert.doesNotThrow(() => e.ctx.ws.verifiedRecord(path), 'explicitly disabled is fine');
});

// ---------------------------------------------------------------- rejected

test('rejected: a non-empty config.worktree', async () => {
  const e = makeEnv();
  const { path, rec } = await worktree(e, 'CW-CONTENT');
  writeFileSync(join(rec.gitDir, 'config.worktree'), '[core]\n\thooksPath = /tmp/evil\n');
  assert.throws(() => e.ctx.ws.verifiedRecord(path), (err: Error) => err instanceof WorktreeTamperedError && /per-worktree config present/.test(err.message));
});

test('rejected: a symlinked config.worktree, even when it points at an empty file', async () => {
  const e = makeEnv();
  const { path, rec } = await worktree(e, 'CW-LINK');
  const empty = join(e.root, 'empty-target');
  writeFileSync(empty, '');
  symlinkSync(empty, join(rec.gitDir, 'config.worktree'));
  assert.throws(() => e.ctx.ws.verifiedRecord(path), /per-worktree config present/);
});

test('rejected: a config.worktree that is a directory', async () => {
  const e = makeEnv();
  const { path, rec } = await worktree(e, 'CW-DIR');
  mkdirSync(join(rec.gitDir, 'config.worktree'));
  assert.throws(() => e.ctx.ws.verifiedRecord(path), /per-worktree config present/);
});

test('rejected: an empty config.worktree while per-worktree config is enabled in the shared clone', async () => {
  for (const enable of ['[extensions]\n\tworktreeConfig = true\n', '[Extensions]\n\tWorkTreeConfig\n', '[extensions]\n\tworktreeconfig = 2\n', '[include]\n\tpath = /tmp/elsewhere\n']) {
    const e = makeEnv();
    const { path, rec } = await worktree(e, 'CW-ENABLED');
    writeFileSync(join(rec.gitDir, 'config.worktree'), '');
    appendFileSync(join(rec.commonDir, 'config'), enable);
    assert.throws(() => e.ctx.ws.verifiedRecord(path), /per-worktree config enabled/, JSON.stringify(enable));
  }
});

test('rejected: a non-empty config.worktree created by the agent blocks the job as a security event', async () => {
  const e = makeEnv({ behaviors: { coding: async (spec, n) => {
    writeFileSync(join(e.ctx.ws.verifiedRecord(spec.cwd).gitDir, 'config.worktree'), '[core]\n\tfsmonitor = /tmp/evil\n');
    return DEFAULTS.coding!(spec, n);
  } } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Content', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /per-worktree config present/);
  assert.ok(tamperEvents(e) >= 1);
});

test('worktreeConfigMayBeEnabled parses git config conservatively', () => {
  const dir = makeEnv().root;
  const cfg = (text: string) => { const p = join(dir, `cfg-${Math.random()}`); writeFileSync(p, text); return worktreeConfigMayBeEnabled(p); };
  assert.equal(cfg('[core]\n\tbare = false\n'), false);
  assert.equal(cfg('[extensions]\n\tworktreeConfig = false\n'), false);
  assert.equal(cfg('[extensions]\n\tworktreeConfig = 0\n'), false);
  assert.equal(cfg('[extensions]\n\tworktreeConfig = yes\n'), true);
  assert.equal(cfg('[extensions]\n\tworktreeConfig\n'), true);
  assert.equal(cfg('[includeIf "gitdir:/x/"]\n\tpath = y\n'), true);
  assert.equal(worktreeConfigMayBeEnabled(join(dir, 'missing-config')), true, 'unreadable config is not trusted');
});
