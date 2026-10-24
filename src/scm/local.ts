import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from '../db.ts';
import { kvGet, kvSet, now } from '../db.ts';
import { run, runOk, tail } from '../exec.ts';
import type { CheckResult, PullRequest } from '../types.ts';
import type { Scm } from './types.ts';
import { runSandboxed } from '../command-sandbox.ts';

interface PrRow { number: number; repo: string; head: string; base: string; title: string; body: string; state: string; draft: number }

/**
 * Simulation SCM: `repo` is a path to a local bare repository, PRs live in SQLite,
 * and "CI" runs `localCi` in a scratch clone of the PR head.
 */
export class LocalScm implements Scm {
  db: Db;
  ciCommand: string | undefined;
  scratch: string;
  runCommand: typeof runSandboxed;
  constructor(db: Db, dataDir: string, ciCommand?: string, runCommand = runSandboxed) {
    this.db = db; this.ciCommand = ciCommand; this.scratch = join(dataDir, 'local-ci');
    this.runCommand = runCommand;
  }
  cloneUrl(repo: string) { return resolve(repo); }
  gitAuthArgs() { return []; }
  async defaultBranch(repo: string) {
    return (await runOk('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: resolve(repo) })).trim();
  }
  private async sha(repo: string, branch: string) {
    return (await runOk('git', ['rev-parse', `refs/heads/${branch}`], { cwd: resolve(repo) })).trim();
  }
  private async toPr(r: PrRow): Promise<PullRequest> {
    let state = r.state as PullRequest['state'];
    if (state === 'open' && (await this.branchMerged(r.repo, r.head, r.base))) {
      state = 'merged';
      this.db.prepare("UPDATE local_prs SET state = 'merged' WHERE number = ?").run(r.number);
    }
    const headSha = await this.sha(r.repo, r.head).catch(() => '');
    return { number: r.number, url: `local://pr/${r.number}`, headBranch: r.head, baseBranch: r.base, headSha, state, draft: !!r.draft };
  }
  async findPr(repo: string, head: string) {
    const r = this.db.prepare('SELECT * FROM local_prs WHERE repo = ? AND head = ? ORDER BY number DESC').get(repo, head) as unknown as PrRow | undefined;
    return r ? this.toPr(r) : null;
  }
  async getPr(_repo: string, number: number) {
    const r = this.db.prepare('SELECT * FROM local_prs WHERE number = ?').get(number) as unknown as PrRow;
    return this.toPr(r);
  }
  async createPr(repo: string, pr: { head: string; base: string; title: string; body: string; draft: boolean }) {
    const r = this.db.prepare("INSERT INTO local_prs (repo, head, base, title, body, state, draft, created_at) VALUES (?,?,?,?,?,'open',?,?)")
      .run(repo, pr.head, pr.base, pr.title, pr.body, pr.draft ? 1 : 0, now());
    return this.getPr(repo, Number(r.lastInsertRowid));
  }
  async updatePr(_repo: string, number: number, patch: { title?: string; body?: string; base?: string }) {
    if (patch.title) this.db.prepare('UPDATE local_prs SET title = ? WHERE number = ?').run(patch.title, number);
    if (patch.body) this.db.prepare('UPDATE local_prs SET body = ? WHERE number = ?').run(patch.body, number);
    if (patch.base) this.db.prepare('UPDATE local_prs SET base = ? WHERE number = ?').run(patch.base, number);
  }
  prBody(number: number): string {
    return (this.db.prepare('SELECT body FROM local_prs WHERE number = ?').get(number) as { body: string }).body;
  }
  async checks(repo: string, pr: PullRequest): Promise<CheckResult> {
    if (!this.ciCommand) return { state: 'none', failures: [], logExcerpt: '' };
    const key = `localci:${pr.headSha}`;
    const cached = kvGet(this.db, key);
    if (cached) return JSON.parse(cached);
    const dir = join(this.scratch, pr.headSha.slice(0, 12));
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(this.scratch, { recursive: true });
    await runOk('git', ['clone', '--quiet', '--branch', pr.headBranch, resolve(repo), dir]);
    const r = await this.runCommand(this.ciCommand, dir, {}, 600_000);
    rmSync(dir, { recursive: true, force: true });
    const res: CheckResult = r.code === 0
      ? { state: 'success', failures: [], logExcerpt: '' }
      : { state: 'failure', failures: [{ name: 'local-ci', summary: `exit ${r.code}` }], logExcerpt: tail(r.stdout + '\n' + r.stderr, 5000) };
    kvSet(this.db, key, JSON.stringify(res));
    return res;
  }
  async previewUrl() { return null; }
  async branchMerged(repo: string, branch: string, base: string) {
    const r = await run('git', ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`], { cwd: resolve(repo) });
    return r.code === 0;
  }
  async branchSha(repo: string, branch: string) { return this.sha(repo, branch); }
  async markReady(_repo: string, pr: PullRequest) { this.db.prepare('UPDATE local_prs SET draft = 0 WHERE number = ?').run(pr.number); }
  /** Records the approval (reviewer identity, exact sha) so tests can assert what was approved. */
  async approve(_repo: string, number: number, sha: string, body: string) {
    kvSet(this.db, `local-approval:${number}`, JSON.stringify({ sha, body }));
  }
  async mergePr(repo: string, number: number, sha: string) {
    const pr = await this.getPr(repo, number);
    if (pr.headSha !== sha) throw new Error(`head moved: expected ${sha}, PR head is ${pr.headSha}`);
    if (!kvGet(this.db, `local-approval:${number}`) || JSON.parse(kvGet(this.db, `local-approval:${number}`)!).sha !== sha) throw new Error('not approved at this sha');
    await this.merge(repo, number);
  }

  /** Test helper: simulate a human merging a PR (fast-forward or merge commit in the bare repo). */
  async merge(repo: string, number: number) {
    const pr = await this.getPr(repo, number);
    const dir = join(this.scratch, `merge-${number}`);
    rmSync(dir, { recursive: true, force: true });
    await runOk('git', ['clone', '--quiet', '--branch', pr.baseBranch, resolve(repo), dir]);
    await runOk('git', ['-c', 'user.name=human', '-c', 'user.email=h@example.com', 'merge', '--no-ff', '-m', `Merge PR #${number}`, `origin/${pr.headBranch}`], { cwd: dir });
    await runOk('git', ['push', 'origin', pr.baseBranch], { cwd: dir });
    rmSync(dir, { recursive: true, force: true });
    this.db.prepare("UPDATE local_prs SET state = 'merged' WHERE number = ?").run(number);
  }
}
