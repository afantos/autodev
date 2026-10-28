import { createWriteStream, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const api = 'https://api.github.com/repos/afantos/autodev';
export type Candidate = { sha: string; sequence: number; runId: number };
export class DeploymentFailed extends Error {}

/** Public, read-only GitHub API: no instance or operator credentials are needed. */
async function json(path: string, fetchImpl: typeof fetch): Promise<any> {
  const r = await fetchImpl(`${api}${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'autodev-deploy' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub ${r.status} reading ${path}`);
  return r.json();
}

export async function candidate(fetchImpl: typeof fetch = fetch, installed = '', failed = ''): Promise<Candidate | null> {
  const runs = await json('/actions/workflows/check.yml/runs?branch=main&event=push&status=success&per_page=1', fetchImpl);
  const run = runs.workflow_runs?.[0];
  if (!run) return null;
  if (run.event !== 'push' || run.head_branch !== 'main' || run.conclusion !== 'success' || run.status !== 'completed'
    || run.path !== '.github/workflows/check.yml' || run.head_repository?.full_name !== 'afantos/autodev'
    || !/^[0-9a-f]{40}$/.test(run.head_sha ?? '') || !Number.isSafeInteger(run.run_number) || run.run_number <= 0
    || !Number.isSafeInteger(run.id) || run.id <= 0) throw new Error('invalid CI run provenance');
  if (run.head_sha === installed || run.head_sha === failed) return null; // normal steady state: one unauthenticated API call per poll
  const branch = await json('/branches/main', fetchImpl);
  if (branch.commit?.sha !== run.head_sha) return null; // main moved: wait for its CI, never deploy an older green commit
  const jobs = await json(`/actions/runs/${run.id}/jobs?per_page=100`, fetchImpl);
  if (!jobs.jobs?.some((j: any) => j.name === 'checks' && j.status === 'completed' && j.conclusion === 'success')) throw new Error('required checks job did not pass');
  return { sha: run.head_sha, sequence: run.run_number, runId: run.id };
}

async function install(root: string, next: Candidate): Promise<void> {
  const incoming = mkdtempSync(join(root, 'incoming/poll.'));
  const archive = join(incoming, 'release.tar.gz');
  const r = await fetch(`${api}/tarball/${next.sha}`, { headers: { 'User-Agent': 'autodev-deploy' }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok || !r.body || new URL(r.url).hostname !== 'codeload.github.com') throw new Error('GitHub archive download failed');
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(archive, { mode: 0o600 }));
  execFileSync('/usr/bin/python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1]) as t: t.extractall(sys.argv[2],filter="data")', archive, incoming]);
  const dirs = readdirSync(incoming, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (dirs.length !== 1) throw new Error('unexpected GitHub archive layout');
  // Recheck main after the download, immediately before starting the host transaction.
  if ((await json('/branches/main', fetch)).commit?.sha !== next.sha) { console.log('Main moved during download; waiting for its CI'); return; }
  try {
    execFileSync(join(root, 'deploy/ci-deploy.sh'), [next.sha, String(next.sequence), join(incoming, dirs[0].name)], { stdio: 'inherit' });
  } catch { throw new DeploymentFailed(`Deployment transaction failed for ${next.sha}; inspect journalctl -u autodev-deploy`); }
}

export async function poll(root: string, fetchImpl: typeof fetch = fetch, deploy: (root: string, next: Candidate) => Promise<void> = install): Promise<void> {
  const installed = readFileSync(join(root, 'app/.installed-commit'), 'utf8').trim();
  const failureFile = join(root, 'deploy/failed-sha');
  const failed = existsSync(failureFile) ? readFileSync(failureFile, 'utf8').trim() : '';
  const next = await candidate(fetchImpl, installed, failed);
  if (!next) { console.log('No new successful CI commit on current main'); return; }
  try {
    await deploy(root, next);
  } catch (e) {
    // Network/API failures before candidate selection can retry; a selected release failure stops automatic churn.
    if (e instanceof DeploymentFailed) writeFileSync(failureFile, `${next.sha}\n`);
    throw e;
  }
  if (existsSync(failureFile)) unlinkSync(failureFile);
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  await poll(process.env.AUTODEV_DEPLOY_ROOT ?? '/opt/autodev');
}
