import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { mentionsKey } from '../src/scm/types.ts';

// 2026-10-27 (DEV-203): the code PR merged and autodev marked the ticket Done, although the workflow PR stacked on it
// (opened from the owner's account, since the bot can't push .github/workflows) was still open. The owner had said the
// ticket closes only after both merge. A merged PR now leaves the ticket open while another open PR names it.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' } });
const clone = (repo: string) => { const d = mkdtempSync(join(tmpdir(), 'h-')); git(d, 'clone', '-q', repo, '.'); return d; };
/** A human merges `branch` into main outside autodev. */
function humanMerge(repo: string, branch: string) {
  const d = clone(repo);
  git(d, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, `origin/${branch}`);
  git(d, 'push', '-q', 'origin', 'HEAD:main');
}
/** A human pushes a branch with one commit on top of `from`. */
function pushBranch(repo: string, branch: string, from: string) {
  const d = clone(repo);
  git(d, 'checkout', '-q', '-b', branch, `origin/${from}`);
  writeFileSync(join(d, 'ci.yml'), 'jobs: {}\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'ci'); git(d, 'push', '-q', 'origin', branch);
}
async function inReview() {
  const e = makeEnv();
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Feature', description: 'Do it.', status: 'ready', priority: 2 });
  for (let i = 0; i < 5 && job(e, t.identifier)?.status !== 'awaiting_merge'; i++) await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review');
  return { e, t };
}
const comments = async (e: ReturnType<typeof makeEnv>, id: string) => (await e.tracker.listComments(id)).map((c) => c.body).join('\n');

test('mentionsKey matches the ticket key as a whole word, case-insensitively, never a longer number', () => {
  assert.equal(mentionsKey('ci: e2e job (stacked on DEV-203 #67)', 'DEV-203'), true);
  assert.equal(mentionsKey('dev-203-ci', 'DEV-203'), true);
  assert.equal(mentionsKey('DEV-2030 and XDEV-203', 'DEV-203'), false);
  assert.equal(mentionsKey('DEV-20', 'DEV-203'), false);
  assert.equal(mentionsKey('', 'DEV-203'), false);
});

test('a merged PR leaves the ticket open while another open PR names it; the job itself is finished', async () => {
  const { e, t } = await inReview();
  const j = job(e, t.identifier);
  pushBranch(e.repo, 'ci/e2e-job', j.branch);
  const stacked = await e.scm.createPr(e.repo, { head: 'ci/e2e-job', base: j.branch, title: `ci: e2e job (stacked on ${t.identifier})`, body: 'workflow change', draft: true });
  humanMerge(e.repo, j.branch);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'done');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review', 'not Done while the stacked PR is open');
  assert.match(await comments(e, t.id), new RegExp(`Not marking Done: #${stacked.number} still references ${t.identifier}`));
  assert.doesNotMatch(await comments(e, t.id), /marked Done by autodev/);
  // Later ticks don't flip it to Done behind the owner's back either.
  await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review');
});

test('open PRs that do not name the ticket, or name a different one, do not hold it open', async () => {
  const { e, t } = await inReview();
  const j = job(e, t.identifier);
  pushBranch(e.repo, 'other', 'main');
  await e.scm.createPr(e.repo, { head: 'other', base: 'main', title: `unrelated ${t.identifier}0`, body: 'nothing to see', draft: false });
  humanMerge(e.repo, j.branch);
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'done');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'done');
  assert.match(await comments(e, t.id), /marked Done by autodev/);
});

test('a failed lookup of open PRs never marks Done; the next tick retries', async () => {
  const { e, t } = await inReview();
  humanMerge(e.repo, job(e, t.identifier).branch);
  const real = e.scm.openPrsReferencing.bind(e.scm);
  e.scm.openPrsReferencing = async () => { throw new Error('HTTP 502'); };
  await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review');
  e.scm.openPrsReferencing = real;
  await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'done');
});
