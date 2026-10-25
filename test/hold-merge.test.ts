import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { kvGet } from '../src/db.ts';
import type { SecondReviewer, SecondReviewInput, SecondReviewVerdict } from '../src/agents/second-review.ts';

// 2026-10-25 (DEV-97): the owner asked to review a ticket before merge. Moving it out of Review held it once, but a
// base refresh revalidated it and the handoff put it back into Review, so it auto-merged. hold-merge is a label: it
// survives status changes and refreshes, and the gate re-reads it before every attempt, approval and merge.

const APPROVE: SecondReviewVerdict = { verdict: 'approve', summary: 'Correct.', findings: [], specConformance: 'ok' };

class Reviewer implements SecondReviewer {
  readonly provider = 'openai';
  readonly model = 'gpt-6.1-sol';
  inputs: SecondReviewInput[] = [];
  onReview: () => void = () => {};
  maxCostUsd() { return 0.1; }
  maxTestUpdateCostUsd() { return 0.1; }
  async review(input: SecondReviewInput) { this.inputs.push(input); this.onReview(); return { verdict: APPROVE, model: this.model, costUsd: 0.02, inputTokens: 1, outputTokens: 1 }; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected'); }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' } });
function pushToMain(repo: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  git(dir, 'clone', '-q', repo, '.');
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'main moves'); git(dir, 'push', '-q', 'origin', 'HEAD:main');
}
function env(reviewer: Reviewer) {
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true }, config: { secondReview: { enabled: true } } });
  pushToMain(e.repo, { 'CHANGES.md': 'changes\n' });
  return e;
}
async function cycles(e: ReturnType<typeof makeEnv>, n: number) { for (let i = 0; i < n; i++) await e.cycle(); }
const ticket = (e: ReturnType<typeof makeEnv>) => e.tracker.createTicket({ projectKey: 'demo', title: 'Feature', description: 'Do it.', status: 'ready', priority: 2 });
const merged = async (e: ReturnType<typeof makeEnv>, id: string) => { const pr = job(e, id)?.pr_number; return !!pr && (await e.scm.getPr(e.repo, pr)).state === 'merged'; };
const approval = (e: ReturnType<typeof makeEnv>, pr: number) => kvGet(e.ctx.db, `local-approval:${pr}`);
const holds = (e: ReturnType<typeof makeEnv>) => (e.ctx.db.prepare("SELECT message FROM events WHERE type = 'automerge.hold' ORDER BY id").all() as { message: string }[]).map((r) => r.message);
const removeLabel = (e: ReturnType<typeof makeEnv>, id: string, label: string) => {
  const r = e.ctx.db.prepare('SELECT labels_json FROM local_tickets WHERE id = ?').get(id) as { labels_json: string };
  e.ctx.db.prepare('UPDATE local_tickets SET labels_json = ? WHERE id = ?').run(JSON.stringify((JSON.parse(r.labels_json) as string[]).filter((l) => l !== label)), id);
};

test('an existing hold-merge label blocks auto-merge across status changes and a base refresh; removing it lets the merge proceed', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer);
  const t = await ticket(e);
  await e.tracker.addLabel(t.id, 'hold-merge');
  await cycles(e, 5);
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge');
  assert.equal(await merged(e, t.identifier), false);
  assert.equal(approval(e, j.pr_number), null, 'never approved while held');
  assert.equal(reviewer.inputs.length, 0, 'no review spend while held');
  assert.match(holds(e)[0]!, /carries the `hold-merge` label/);
  // A human moves the ticket around, and main moves: still held.
  await e.tracker.setStatus(t.id, 'blocked');
  await cycles(e, 2);
  await e.tracker.setStatus(t.id, 'review');
  pushToMain(e.repo, { 'other.txt': 'unrelated\n' });
  await cycles(e, 6);
  assert.equal(await merged(e, t.identifier), false, 'status changes and a moved base do not release the hold');
  assert.equal(approval(e, job(e, t.identifier).pr_number), null);
  // Owner removes the label: the gate refreshes onto the new main, revalidates and merges.
  removeLabel(e, t.id, 'hold-merge');
  await cycles(e, 8);
  assert.equal(await merged(e, t.identifier), true);
});

test('a hold added during the second review stops the approval (rechecked immediately before approving)', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer);
  const t = await ticket(e);
  reviewer.onReview = () => { void e.tracker.addLabel(t.id, 'hold-merge'); };
  await cycles(e, 6);
  const j = job(e, t.identifier);
  assert.equal(reviewer.inputs.length, 1, 'the review ran');
  assert.equal(approval(e, j.pr_number), null, 'not approved');
  assert.equal(await merged(e, t.identifier), false);
  assert.match(holds(e).at(-1)!, /hold-merge/);
});

test('a hold added between approval and merge still stops the merge (rechecked immediately before merging)', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer);
  const t = await ticket(e);
  const approve = e.scm.approve.bind(e.scm);
  e.scm.approve = async (repo, n, sha, body) => { await approve(repo, n, sha, body); await e.tracker.addLabel(t.id, 'hold-merge'); };
  await cycles(e, 6);
  assert.notEqual(approval(e, job(e, t.identifier).pr_number), null, 'it was approved');
  assert.equal(await merged(e, t.identifier), false, 'but not merged');
  assert.match(holds(e).at(-1)!, /hold-merge/);
});

test('the hold label is configurable and can be disabled', async () => {
  const reviewer = new Reviewer();
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true }, config: { secondReview: { enabled: true }, linear: { holdMergeLabel: '' } } });
  pushToMain(e.repo, { 'CHANGES.md': 'changes\n' });
  const t = await ticket(e);
  await e.tracker.addLabel(t.id, 'hold-merge');
  await cycles(e, 6);
  assert.equal(await merged(e, t.identifier), true, 'with the label name empty, hold-merge has no effect');
});
