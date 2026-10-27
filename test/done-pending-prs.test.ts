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
async function inReview(config: Record<string, unknown> = {}) {
  const e = makeEnv({ config });
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
  assert.match(await comments(e, t.id), new RegExp(`Not marking Done yet: #${stacked.number} still references ${t.identifier}`));
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

const countMatching = async (e: ReturnType<typeof makeEnv>, id: string, re: RegExp) => (await e.tracker.listComments(id)).filter((c) => re.test(c.body)).length;
const setPrState = (e: ReturnType<typeof makeEnv>, n: number, state: string) => e.ctx.db.prepare('UPDATE local_prs SET state = ? WHERE number = ?').run(state, n);
/** Opens the stacked workflow PR on the job's branch, then a human merges the job's PR. */
async function stackedThenMerge(e: ReturnType<typeof makeEnv>, t: { identifier: string }) {
  const j = job(e, t.identifier);
  pushBranch(e.repo, 'ci/e2e-job', j.branch);
  const stacked = await e.scm.createPr(e.repo, { head: 'ci/e2e-job', base: j.branch, title: `ci: e2e job (stacked on ${t.identifier})`, body: '', draft: false });
  humanMerge(e.repo, j.branch);
  await e.cycle();
  return stacked;
}
/** GitHub retargets the stacked PR to main once its base merged; then a human merges it. */
async function mergeStacked(e: ReturnType<typeof makeEnv>, n: number) {
  await e.scm.updatePr(e.repo, n, { base: 'main' });
  humanMerge(e.repo, 'ci/e2e-job');
}

test('the ticket is marked Done once the remaining PR merges, with one comment, and stays pending until then', async () => {
  const { e, t } = await inReview();
  const stacked = await stackedThenMerge(e, t);
  for (let i = 0; i < 3; i++) await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review');
  assert.equal(await countMatching(e, t.id, /Not marking Done yet/), 1, 'the pending comment is posted once, not per tick');
  await mergeStacked(e, stacked.number);
  await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'done', 'eventual completion after the second PR merges');
  assert.equal(await countMatching(e, t.id, /All PRs for .* merged \(#\d+, #\d+\) — marked Done by autodev/), 1);
  for (let i = 0; i < 2; i++) await e.cycle();
  assert.equal(await countMatching(e, t.id, /marked Done by autodev/), 1, 'no repeated completion comment');
});

test('a pending completion holds no work slot: other tickets run meanwhile', async () => {
  const { e, t } = await inReview({ concurrency: { global: 1 } });
  await stackedThenMerge(e, t);
  const other = await e.tracker.createTicket({ projectKey: 'demo', title: 'Other', description: 'Do it.', status: 'ready', priority: 2 });
  for (let i = 0; i < 5 && job(e, other.identifier)?.status !== 'awaiting_merge'; i++) await e.cycle();
  assert.equal(job(e, other.identifier)?.status, 'awaiting_merge', 'the only slot was free for the next ticket');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review');
});

test('a remaining PR closed without merging leaves the ticket open for a human, with one comment', async () => {
  const { e, t } = await inReview();
  const stacked = await stackedThenMerge(e, t);
  setPrState(e, stacked.number, 'closed');
  for (let i = 0; i < 3; i++) await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review');
  assert.equal(await countMatching(e, t.id, new RegExp(`#${stacked.number} was closed without merging`)), 1);
  assert.equal(await countMatching(e, t.id, /marked Done by autodev/), 0);
});

test('a failed lookup while pending is retried; the ticket is marked Done once it succeeds', async () => {
  const { e, t } = await inReview();
  const stacked = await stackedThenMerge(e, t);
  await mergeStacked(e, stacked.number);
  const real = e.scm.openPrsReferencing.bind(e.scm);
  e.scm.openPrsReferencing = async () => { throw new Error('HTTP 502'); };
  for (let i = 0; i < 2; i++) await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review', 'never Done on a failed lookup');
  e.scm.openPrsReferencing = real;
  await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'done');
});

test('a ticket a human already closed while pending is left alone', async () => {
  const { e, t } = await inReview();
  const stacked = await stackedThenMerge(e, t);
  await e.tracker.setStatus(t.id, 'canceled');
  await mergeStacked(e, stacked.number);
  for (let i = 0; i < 2; i++) await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'canceled');
  assert.equal(await countMatching(e, t.id, /marked Done by autodev/), 0);
});

test('an empty ticket lookup keeps the pending record; the ticket is marked Done once the lookup recovers', async () => {
  const { e, t } = await inReview();
  const stacked = await stackedThenMerge(e, t);
  await mergeStacked(e, stacked.number);
  const real = e.tracker.getTicket.bind(e.tracker);
  e.tracker.getTicket = async (id: string) => (id === t.id ? null : real(id));
  for (let i = 0; i < 2; i++) await e.cycle();
  e.tracker.getTicket = real;
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'review', 'not Done, and not dropped, while the lookup is empty');
  await e.cycle();
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'done', 'completed after the lookup recovers');
  assert.equal(await countMatching(e, t.id, /marked Done by autodev/), 1);
});
