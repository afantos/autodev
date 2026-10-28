import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidate, DeploymentFailed, poll } from '../deploy/ci-poll.ts';

const sha = 'b'.repeat(40);
const good = { head_sha: sha, id: 123, run_number: 456, event: 'push', head_branch: 'main', conclusion: 'success', status: 'completed', path: '.github/workflows/check.yml', head_repository: { full_name: 'afantos/autodev' } };
function fixture(run: object | null = good, main = sha, checks = 'success') {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const body = url.includes('/workflows/') ? { workflow_runs: run ? [run] : [] }
      : url.includes('/branches/') ? { commit: { sha: main } }
      : { jobs: [{ name: 'checks', status: 'completed', conclusion: checks }] };
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

test('select only a completed successful main push with passing required checks and the current main SHA', async () => {
  const f = fixture();
  assert.deepEqual(await candidate(f.fetchImpl), { sha, sequence: 456, runId: 123 });
  assert.equal(f.urls.length, 3);
});

for (const patch of [{ event: 'pull_request' }, { head_branch: 'feature' }, { conclusion: 'failure' }, { status: 'in_progress' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'fork/autodev' } }, { head_sha: 'invalid' }, { run_number: -1 }, { id: '123' }]) {
  test(`reject CI provenance ${JSON.stringify(patch)}`, async () => {
    await assert.rejects(candidate(fixture({ ...good, ...patch }).fetchImpl), /provenance/);
  });
}

test('main moved while CI ran: wait for current main, not the last green commit', async () => {
  assert.equal(await candidate(fixture(good, 'c'.repeat(40)).fetchImpl), null);
});

test('no successful run: do nothing', async () => {
  assert.equal(await candidate(fixture(null).fetchImpl), null);
});

test('a nominally successful workflow cannot bypass missing/failed checks', async () => {
  await assert.rejects(candidate(fixture(good, sha, 'failure').fetchImpl), /checks job/);
});

test('installed commit uses one API request per poll, within the public API rate limit', async () => {
  const f = fixture();
  assert.equal(await candidate(f.fetchImpl, sha), null);
  assert.equal(f.urls.length, 1);
});

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-poll-'));
  mkdirSync(join(dir, 'app'));mkdirSync(join(dir, 'deploy'));
  writeFileSync(join(dir, 'app/.installed-commit'), 'a'.repeat(40));
  return dir;
}

test('failed deployments are recorded and not retried endlessly; an explicit reset permits a retry', async () => {
  const dir = root();let attempts = 0;
  const deploy = async () => { attempts++;throw new DeploymentFailed('rolled back'); };
  await assert.rejects(poll(dir, fixture().fetchImpl, deploy), /rolled back/);
  assert.equal(readFileSync(join(dir, 'deploy/failed-sha'), 'utf8').trim(), sha);
  await poll(dir, fixture().fetchImpl, deploy);
  assert.equal(attempts, 1);
  writeFileSync(join(dir, 'deploy/failed-sha'), '');
  await assert.rejects(poll(dir, fixture().fetchImpl, deploy), /rolled back/);
  assert.equal(attempts, 2);
});

test('transient download errors can retry without recording a failed release', async () => {
  const dir = root();let attempts = 0;
  const deploy = async () => { attempts++;throw new Error('connection reset'); };
  await assert.rejects(poll(dir, fixture().fetchImpl, deploy), /connection reset/);
  await assert.rejects(poll(dir, fixture().fetchImpl, deploy), /connection reset/);
  assert.equal(attempts, 2);
});

test('a new green main revision proceeds after an older revision failed', async () => {
  const dir = root();writeFileSync(join(dir, 'deploy/failed-sha'), 'a'.repeat(40));
  let received: unknown;
  await poll(dir, fixture().fetchImpl, async (_, next) => { received = next; });
  assert.deepEqual(received, { sha, sequence: 456, runId: 123 });
});
