import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run, runOk } from '../exec.ts';
import type { Scm } from './types.ts';
import { scanSecrets, UnsafePushError } from '../secrets.ts';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };

/** Manages one cached clone per repo and one worktree per job under dataDir. */
export class Workspaces {
  dataDir: string;
  scm: Scm;
  private locks = new Map<string, Promise<unknown>>();
  constructor(dataDir: string, scm: Scm) { this.dataDir = dataDir; this.scm = scm; }

  /** Serialize operations that touch a repo's shared clone (refs, packed-refs, worktree metadata). */
  withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(repo, next.catch(() => {}));
    return next;
  }

  repoDir(repo: string) { return join(this.dataDir, 'repos', repo.replace(/[^A-Za-z0-9._-]+/g, '__')); }
  worktreeDir(identifier: string) { return join(this.dataDir, 'worktrees', identifier); }

  git(cwd: string, args: string[], auth = false, timeoutMs = 300_000, signal?: AbortSignal) {
    return runOk('git', [...(auth ? this.scm.gitAuthArgs() : []), ...args], { cwd, env: GIT_ENV, timeoutMs, signal });
  }
  gitRaw(cwd: string, args: string[], auth = false) {
    return run('git', [...(auth ? this.scm.gitAuthArgs() : []), ...args], { cwd, env: GIT_ENV, timeoutMs: 300_000 });
  }

  ensureClone(repo: string): Promise<string> {
    return this.withRepoLock(repo, () => this.ensureCloneUnlocked(repo));
  }

  private async ensureCloneUnlocked(repo: string): Promise<string> {
    const dir = this.repoDir(repo);
    if (existsSync(dir) && !existsSync(join(dir, '.git'))) rmSync(dir, { recursive: true, force: true }); // interrupted clone
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(join(this.dataDir, 'repos'), { recursive: true });
      await runOk('git', [...this.scm.gitAuthArgs(), 'clone', '--no-checkout', this.scm.cloneUrl(repo), dir], { env: GIT_ENV, timeoutMs: 900_000 });
      await this.git(dir, ['config', 'user.name', 'autodev[bot]']);
      await this.git(dir, ['config', 'user.email', 'autodev-bot@users.noreply.github.com']);
    } else {
      await this.git(dir, ['fetch', '--prune', 'origin'], true);
    }
    return dir;
  }

  async remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
    return (await this.gitRaw(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;
  }

  /**
   * Create (or reuse) the job's worktree. Idempotent: an existing worktree is reused untouched,
   * an existing remote branch is checked out rather than recreated.
   */
  ensureWorktree(repo: string, identifier: string, branch: string, base: string): Promise<{ path: string; reused: boolean }> {
    return this.withRepoLock(repo, () => this.ensureWorktreeUnlocked(repo, identifier, branch, base));
  }

  private async ensureWorktreeUnlocked(repo: string, identifier: string, branch: string, base: string): Promise<{ path: string; reused: boolean }> {
    const repoDir = await this.ensureCloneUnlocked(repo);
    const path = this.worktreeDir(identifier);
    if (existsSync(join(path, '.git'))) return { path, reused: true };
    mkdirSync(join(this.dataDir, 'worktrees'), { recursive: true });
    await this.git(repoDir, ['worktree', 'prune']);
    const localExists = (await this.gitRaw(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    if (localExists) await this.git(repoDir, ['worktree', 'add', path, branch]);
    else if (await this.remoteBranchExists(repoDir, branch)) await this.git(repoDir, ['worktree', 'add', '-b', branch, path, `origin/${branch}`]);
    else await this.git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, path, `origin/${base}`]);
    return { path, reused: localExists };
  }

  async status(path: string): Promise<string> {
    return this.git(path, ['status', '--porcelain']);
  }

  async commitAll(path: string, message: string): Promise<boolean> {
    if (!(await this.status(path)).trim()) return false;
    await this.git(path, ['add', '-A']);
    await this.git(path, ['commit', '-m', message, '--no-verify']);
    return true;
  }

  async headSha(path: string): Promise<string> { return (await this.git(path, ['rev-parse', 'HEAD'])).trim(); }

  async aheadOf(path: string, base: string): Promise<number> {
    return Number((await this.git(path, ['rev-list', '--count', `origin/${base}..HEAD`])).trim());
  }

  async fetch(path: string) { await this.git(path, ['fetch', 'origin'], true); }

  /** Push without force. Returns false (and the message) if the remote rejected the push. */
  async push(path: string, branch: string, repo?: string, control: { signal?: AbortSignal; beforePush?: () => Promise<unknown> } = {}): Promise<void> {
    const doPush = async () => {
      const sha = await this.headSha(path);
      // Scan every outgoing commit, including secrets subsequently removed. Pin the
      // scanned SHA so a concurrent HEAD change cannot swap in unscanned content.
      const commits = (await this.git(path, ['rev-list', sha, '--not', '--remotes=origin'])).trim().split('\n').filter(Boolean);
      for (const commit of commits) {
        const patch = await this.git(path, ['show', '--format=', '--root', '--diff-merges=separate', '--no-ext-diff', '--no-textconv', commit]);
        const secrets = scanSecrets(patch);
        if (secrets.length) throw new UnsafePushError(secrets);
      }
      control.signal?.throwIfAborted();
      await control.beforePush?.();
      control.signal?.throwIfAborted();
      await this.git(path, ['push', '--set-upstream', 'origin', `${sha}:refs/heads/${branch}`], true, 300_000, control.signal);
    };
    await (repo ? this.withRepoLock(repo, doPush) : doPush());
  }

  async diff(path: string, base: string, stat = false): Promise<string> {
    return this.git(path, ['diff', ...(stat ? ['--stat'] : []), `origin/${base}...HEAD`]);
  }

  async changedFiles(path: string, base: string): Promise<string[]> {
    return (await this.git(path, ['diff', '--name-only', `origin/${base}...HEAD`])).split('\n').filter(Boolean);
  }

  /** Remove a worktree only when it has no uncommitted changes. Never deletes unfinished work. */
  removeWorktreeIfClean(repo: string, path: string): Promise<boolean> {
    return this.withRepoLock(repo, () => this.removeUnlocked(repo, path));
  }

  private async removeUnlocked(repo: string, path: string): Promise<boolean> {
    if (!existsSync(path)) return true;
    if ((await this.status(path)).trim()) return false;
    const repoDir = this.repoDir(repo);
    await this.gitRaw(repoDir, ['worktree', 'remove', path]);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    return true;
  }
}
