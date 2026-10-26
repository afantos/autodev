import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import type { Env } from './helpers.ts';
import type { CheckResult, PullRequest } from '../src/types.ts';

// 2026-10-26 (poker DEV-102 / PR #55): GitHub runs no pull_request workflow on a PR that conflicts with its base, so a
// job in waiting_ci sat until ciTimeoutMinutes and then blocked for a human. pollCi now merges the base and sends the
// job back through coding (as auto-merge does for awaiting_merge), or revalidates when the merge is clean.

const PENDING: CheckResult = { state: 'pending', failures: [], logExcerpt: '' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', ...args], { cwd, stdio: 'pipe' }).toString();

/** Someone else lands a change on main (the fake coder also writes CHANGES.md, so both sides add it: a conflict). */
function landOnMain(e: Env, content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'autodev-main-'));
  git(dir, 'clone', '--quiet', '--branch', 'main', e.repo, '.');
  writeFileSync(join(dir, 'CHANGES.md'), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'other ticket');
  git(dir, 'push', '-q', 'origin', 'main');
}

/** CI stays pending (GitHub never starts it) and the PR reports the given mergeability, until `release()` is called. */
function conflictingGithub(e: Env) {
  let stuck = true;
  const realChecks = e.scm.checks.bind(e.scm);
  const realGetPr = e.scm.getPr.bind(e.scm);
  e.ctx.scm.checks = async (repo: string, pr: PullRequest) => (stuck ? PENDING : realChecks(repo, pr));
  e.ctx.scm.getPr = async (repo: string, n: number) => ({ ...(await realGetPr(repo, n)), mergeable: stuck ? 'conflicting' : 'mergeable' });
  return { release: () => { stuck = false; } };
}

function env(extra: Record<string, unknown> = {}) {
  return makeEnv({
    config: { loop: { ciPollSeconds: 0 }, ...extra },
    // The coding agent resolves whatever it is handed: it rewrites CHANGES.md without markers, keeping both sides.
    behaviors: { coding: async (spec) => {
      const file = join(spec.cwd, 'CHANGES.md');
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { /* first pass: no file yet */ }
      const lines = text.split('\n').filter((l) => l && !/^(<{7}|={7}|>{7})/.test(l));
      if (!lines.some((l) => l.includes('ticket'))) lines.push('- ticket: change');
      writeFileSync(file, lines.join('\n') + '\n');
      return { structured: { status: 'completed', summary: 'done (fake)', filesChanged: ['CHANGES.md'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
}

test('a waiting_ci job whose PR conflicts with main is sent back through coding instead of waiting for the CI timeout', async () => {
  const e = env();
  const gh = conflictingGithub(e);
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Conflict', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  let j = job(e, t.identifier);
  assert.equal(j.status, 'waiting_ci', String(j.blocked_reason ?? j.error));
  const firstHead = j.candidate_sha;

  landOnMain(e, '- other: landed first\n');
  await e.orch.pollCi();
  j = job(e, t.identifier);
  assert.equal(j.status, 'queued');
  assert.equal(j.stage, 'workspace', 'conflict markers go back to the coding agent');
  assert.equal(j.fix_attempts, 1);
  assert.match(String(j.pending_feedback), /conflicts in:\n- CHANGES\.md/);
  assert.equal(j.lease_owner, null);
  assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'ci.conflict'").get());
  assert.equal(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'job.blocked'").get(), undefined);

  // The agent resolves it, the branch is revalidated and pushed; once GitHub reports CI, the job proceeds normally.
  gh.release();
  await e.cycle();
  await e.cycle();
  j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge', String(j.blocked_reason ?? j.error));
  assert.notEqual(j.candidate_sha, firstHead, 'a new candidate was pushed');
  const pr = await e.scm.getPr(e.repo, j.pr_number);
  const changes = git(e.repo, 'show', `${pr.headSha}:CHANGES.md`);
  assert.doesNotMatch(changes, /<{7}|={7}|>{7}/);
  assert.match(changes, /other: landed first/);
  assert.match(changes, /ticket/);
});

test('a conflicting PR with the fix-attempt limit used up blocks for a human with the reason, rather than looping', async () => {
  const e = env({ limits: { maxFixAttempts: 0 } });
  conflictingGithub(e);
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Conflict', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'waiting_ci');
  landOnMain(e, '- other: landed first\n');
  await e.orch.pollCi();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.match(String(j.blocked_reason), /conflicts with main, so CI cannot run/);
});

test('a PR reported as conflicting while main has not moved keeps waiting for CI (nothing to merge)', async () => {
  const e = env();
  conflictingGithub(e);
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Conflict', description: '', status: 'ready', priority: 2 });
  await e.cycle();
  await e.orch.pollCi();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'waiting_ci');
  assert.equal(j.lease_owner, null);
  assert.equal(e.ctx.db.prepare("SELECT 1 FROM events WHERE type IN ('ci.conflict','ci.refresh')").get(), undefined);
});
