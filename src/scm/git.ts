import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { run, runOk } from '../exec.ts';
import type { Scm } from './types.ts';
import { scanSecrets, UnsafePushError } from '../secrets.ts';

/**
 * Settings forced on every orchestrator git command. Repository content (and anything an agent or a
 * validation command wrote into a worktree) must never be able to make the orchestrator execute code.
 */
const HARDENING = [
  '-c', 'core.hooksPath=/dev/null',     // no hooks (post-commit/reference-transaction ignore --no-verify)
  '-c', 'core.fsmonitor=false',         // fsmonitor runs a configured command on status/add
  '-c', 'core.untrackedCache=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'submodule.recurse=false',
  '-c', 'credential.helper=',
];

/** Minimal environment: no orchestrator secrets, no user/system git config. */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

export class WorktreeTamperedError extends Error {
  constructor(path: string, why: string) { super(`worktree git metadata was modified (${why}) in ${path}; refusing to run git there`); }
}

/** Trusted record of a worktree's git locations, written by the orchestrator before any agent runs. */
interface WorktreeRecord { repo: string; worktree: string; gitDir: string; commonDir: string }

/**
 * One cached clone per repo and one worktree per job, under workspaceDir. The orchestrator never lets git
 * discover its repository from a worktree: every command gets explicit --git-dir/--work-tree taken from
 * the trusted record in dataDir, after verifying the on-disk pointers still match.
 */
export class Workspaces {
  dataDir: string;
  workspaceDir: string;
  scm: Scm;
  private locks = new Map<string, Promise<unknown>>();
  constructor(dataDir: string, workspaceDir: string, scm: Scm) { this.dataDir = dataDir; this.workspaceDir = workspaceDir; this.scm = scm; }

  /** Serialize operations that touch a repo's shared clone (refs, packed-refs, worktree metadata). */
  withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(repo, next.catch(() => {}));
    return next;
  }

  repoDir(repo: string) { return join(this.workspaceDir, 'repos', repo.replace(/[^A-Za-z0-9._-]+/g, '__')); }
  worktreeDir(identifier: string) { return join(this.workspaceDir, 'worktrees', identifier); }
  private recordPath(worktree: string) { return join(this.dataDir, 'worktree-records', `${basename(worktree)}.json`); }
  private gitHome() { const h = join(this.dataDir, 'git-home'); mkdirSync(h, { recursive: true }); return h; }
  private isWorktreePath(abs: string) { return abs.startsWith(join(this.workspaceDir, 'worktrees') + sep); }

  /** The verified --git-dir/--work-tree arguments for `cwd`. Throws if cwd is unmanaged or tampered with. */
  gitDirArgs(cwd: string): string[] {
    const abs = resolve(cwd);
    if (this.isWorktreePath(abs)) {
      const rec = this.verifiedRecord(abs);
      return [`--git-dir=${rec.gitDir}`, `--work-tree=${rec.worktree}`];
    }
    // A clone owned by the orchestrator: a plain .git directory that agents and commands can never write.
    if (!abs.startsWith(join(this.workspaceDir, 'repos') + sep)) throw new Error(`refusing git in unmanaged directory ${abs}`);
    return [`--git-dir=${join(abs, '.git')}`];
  }

  /** Check every pointer git would follow against the trusted record. */
  verifiedRecord(worktree: string): WorktreeRecord {
    const abs = resolve(worktree);
    const recPath = this.recordPath(abs);
    if (!existsSync(recPath)) throw new WorktreeTamperedError(abs, 'no trusted record');
    const rec = JSON.parse(readFileSync(recPath, 'utf8')) as WorktreeRecord;
    const read = (p: string) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
    let real: string;
    try { real = realpathSync(abs); } catch { throw new WorktreeTamperedError(abs, 'worktree missing'); }
    if (rec.worktree !== real) throw new WorktreeTamperedError(abs, 'record/path mismatch');
    if (read(join(real, '.git')) !== `gitdir: ${rec.gitDir}`) throw new WorktreeTamperedError(abs, '.git pointer changed');
    if (read(join(rec.gitDir, 'gitdir')) !== join(rec.worktree, '.git')) throw new WorktreeTamperedError(abs, 'metadata back-link changed');
    const commondir = read(join(rec.gitDir, 'commondir'));
    let common: string | null = null;
    try { common = commondir ? realpathSync(resolve(rec.gitDir, commondir)) : null; } catch { /* missing */ }
    if (common !== rec.commonDir) throw new WorktreeTamperedError(abs, 'commondir changed');
    if (existsSync(join(rec.gitDir, 'config.worktree'))) throw new WorktreeTamperedError(abs, 'per-worktree config present');
    return rec;
  }

  /** Record a freshly created worktree (nothing else has run in it yet, so its pointer is trusted now). */
  private register(repo: string, worktree: string) {
    const real = realpathSync(worktree);
    const commonDir = realpathSync(join(this.repoDir(repo), '.git'));
    const pointer = readFileSync(join(real, '.git'), 'utf8').trim();
    if (!pointer.startsWith('gitdir: ')) throw new Error(`unexpected worktree pointer in ${real}`);
    const gitDir = realpathSync(resolve(real, pointer.slice(8)));
    if (!gitDir.startsWith(join(commonDir, 'worktrees') + sep)) throw new Error('new worktree metadata is outside its clone');
    if (readFileSync(join(gitDir, 'gitdir'), 'utf8').trim() !== join(real, '.git')) {
      // git records the path it was given; store the resolved form so later verification is exact.
      writeFileSync(join(gitDir, 'gitdir'), `${join(real, '.git')}\n`);
    }
    mkdirSync(join(this.dataDir, 'worktree-records'), { recursive: true });
    const rec: WorktreeRecord = { repo, worktree: real, gitDir, commonDir };
    writeFileSync(this.recordPath(real), JSON.stringify(rec));
    writeFileSync(join(real, '.git'), `gitdir: ${gitDir}\n`);
  }

  git(cwd: string, args: string[], auth = false, timeoutMs = 300_000, signal?: AbortSignal) {
    return runOk('git', [...HARDENING, ...(auth ? this.scm.gitAuthArgs() : []), ...this.gitDirArgs(cwd), ...args], { cwd, env: gitEnv(this.gitHome()), timeoutMs, signal });
  }
  gitRaw(cwd: string, args: string[], auth = false) {
    return run('git', [...HARDENING, ...(auth ? this.scm.gitAuthArgs() : []), ...this.gitDirArgs(cwd), ...args], { cwd, env: gitEnv(this.gitHome()), timeoutMs: 300_000 });
  }

  ensureClone(repo: string): Promise<string> {
    return this.withRepoLock(repo, () => this.ensureCloneUnlocked(repo));
  }

  private async ensureCloneUnlocked(repo: string): Promise<string> {
    const dir = this.repoDir(repo);
    if (existsSync(dir) && !existsSync(join(dir, '.git'))) rmSync(dir, { recursive: true, force: true }); // interrupted clone
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(join(this.workspaceDir, 'repos'), { recursive: true });
      await runOk('git', [...HARDENING, ...this.scm.gitAuthArgs(), 'clone', '--no-checkout', this.scm.cloneUrl(repo), dir], { env: gitEnv(this.gitHome()), timeoutMs: 900_000 });
      await this.git(dir, ['config', 'user.name', 'autodev[bot]']);
      await this.git(dir, ['config', 'user.email', 'autodev-bot@users.noreply.github.com']);
      // Per-job tool caches live in the worktree (outside the agent's denied HOME) and must never be committed.
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      appendFileSync(join(dir, '.git', 'info', 'exclude'), '\n/.autodev-cache/\n');
    } else {
      await this.git(dir, ['fetch', '--prune', 'origin'], true);
    }
    return dir;
  }

  async remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
    return (await this.gitRaw(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).code === 0;
  }

  /**
   * Create (or reuse) the job's worktree. Idempotent: an existing worktree is reused only if its git
   * pointers still match the trusted record; an existing remote branch is checked out rather than recreated.
   */
  ensureWorktree(repo: string, identifier: string, branch: string, base: string): Promise<{ path: string; reused: boolean }> {
    return this.withRepoLock(repo, () => this.ensureWorktreeUnlocked(repo, identifier, branch, base));
  }

  private async ensureWorktreeUnlocked(repo: string, identifier: string, branch: string, base: string): Promise<{ path: string; reused: boolean }> {
    const repoDir = await this.ensureCloneUnlocked(repo);
    const path = this.worktreeDir(identifier);
    if (existsSync(join(path, '.git'))) { this.verifiedRecord(path); return { path, reused: true }; }
    mkdirSync(join(this.workspaceDir, 'worktrees'), { recursive: true });
    await this.git(repoDir, ['worktree', 'prune']);
    const localExists = (await this.gitRaw(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    if (localExists) await this.git(repoDir, ['worktree', 'add', path, branch]);
    else if (await this.remoteBranchExists(repoDir, branch)) await this.git(repoDir, ['worktree', 'add', '-b', branch, path, `origin/${branch}`]);
    else await this.git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, path, `origin/${base}`]);
    this.register(repo, path);
    return { path, reused: localExists };
  }

  /** Detached research checkout (planning). */
  addDetachedWorktree(repo: string, name: string, ref: string): Promise<string> {
    return this.withRepoLock(repo, async () => {
      const path = this.worktreeDir(name);
      mkdirSync(join(this.workspaceDir, 'worktrees'), { recursive: true });
      await this.git(this.repoDir(repo), ['worktree', 'add', '--detach', path, ref]);
      this.register(repo, path);
      return path;
    });
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
    return this.withRepoLock(repo, () => this.removeUnlocked(repo, path, false));
  }

  /** Remove a research worktree regardless of local changes. */
  removeWorktreeForce(repo: string, path: string): Promise<boolean> {
    return this.withRepoLock(repo, () => this.removeUnlocked(repo, path, true));
  }

  private async removeUnlocked(repo: string, path: string, force: boolean): Promise<boolean> {
    if (!existsSync(path)) return true;
    if (!force && (await this.status(path)).trim()) return false;
    await this.gitRaw(this.repoDir(repo), ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    rmSync(this.recordPath(path), { force: true });
    return true;
  }
}
