import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { run, runOk } from '../exec.ts';
import type { Scm } from './types.ts';
import { scanSecrets, UnsafePushError } from '../secrets.ts';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db.ts';

/**
 * Settings forced on every orchestrator git command. Repository content (and anything an agent or a
 * validation command wrote into a worktree) must never be able to make the orchestrator execute code.
 */
const HARDENING = [
  '--no-replace-objects',
  '-c', 'core.hooksPath=/dev/null',     // no hooks (post-commit/reference-transaction ignore --no-verify)
  '-c', 'core.fsmonitor=false',         // fsmonitor runs a configured command on status/add
  '-c', 'core.untrackedCache=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'submodule.recurse=false',
  '-c', 'credential.helper=',
  '-c', 'core.replaceRefs=false',
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
export interface GitState { worktree: string; git_dir: string; base_sha: string; head_sha: string }
interface CandidateRecord { source: string; path: string; sha: string; files: Record<string, string> }

/**
 * Agent-visible reference clones/worktrees live under workspaceDir and are untrusted.
 * Each worktree also has an independent private repository under dataDir. Orchestrator
 * commands verify the public pointers/refs, then use the private git directory and index.
 * Authoritative base/head hashes are held in SQLite; agent-writable objects are never imported.
 */
export class Workspaces {
  dataDir: string;
  workspaceDir: string;
  scm: Scm;
  db: Db;
  private locks = new Map<string, Promise<unknown>>();
  private clones = new Map<string, string>();
  constructor(dataDir: string, workspaceDir: string, scm: Scm, db: Db) { this.dataDir = dataDir; this.workspaceDir = workspaceDir; this.scm = scm; this.db = db; }

  /** Async contexts that currently hold a repo lock (so nested git calls re-enter instead of deadlocking). */
  private held = new AsyncLocalStorage<ReadonlySet<string>>();

  /**
   * Test seam only (never reachable from configuration): awaited after a reference-clone git command and
   * before its ref snapshot is recorded, i.e. while the clone is legitimately mid-update under the lock.
   */
  testHooks: { afterCloneCommand?: (args: string[]) => Promise<void> } = {};

  /**
   * Serialize operations that touch a repo's shared clone (refs, packed-refs, worktree metadata).
   * Re-entrant within one async context. Every ref verification also runs under this lock, so a check
   * never observes another worker's in-progress (legitimate) update as tampering.
   */
  withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const held = this.held.getStore();
    if (held?.has(repo)) return fn();
    const prev = this.locks.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.held.run(new Set([...(held ?? []), repo]), fn));
    this.locks.set(repo, next.catch(() => {}));
    return next;
  }

  /** Verify the reference clone's refs against the last orchestrator snapshot, under the repo lock. */
  verifyRefsLocked(repo: string): Promise<void> {
    return this.withRepoLock(repo, async () => this.verifyRefs(repo));
  }

  repoDir(repo: string) { const dir = join(this.workspaceDir, 'repos', repo.replace(/[^A-Za-z0-9._-]+/g, '__')); this.clones.set(resolve(dir), repo); return dir; }
  worktreeDir(identifier: string) { return join(this.workspaceDir, 'worktrees', identifier); }
  private recordPath(worktree: string) { return join(this.dataDir, 'worktree-records', `${basename(worktree)}.json`); }
  private gitHome() { const h = join(this.dataDir, 'git-home'); mkdirSync(h, { recursive: true }); return h; }
  private isWorktreePath(abs: string) { return abs.startsWith(join(this.workspaceDir, 'worktrees') + sep); }

  /** The verified --git-dir/--work-tree arguments for `cwd`. Throws if cwd is unmanaged or tampered with. */
  gitDirArgs(cwd: string): string[] {
    const abs = resolve(cwd);
    if (this.isWorktreePath(abs)) {
      // Ref verification happens in runGit, under the repo lock.
      const rec = this.verifiedRecord(abs);
      return [`--git-dir=${this.trustedState(abs).git_dir}`, `--work-tree=${rec.worktree}`];
    }
    // Disposable reference clones are used for worktree creation, never policy/scan/push ranges.
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

  trustedState(worktree: string): GitState {
    const state = this.db.prepare('SELECT * FROM git_states WHERE worktree = ?').get(realpathSync(worktree)) as unknown as GitState | undefined;
    if (!state || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state.base_sha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state.head_sha)) {
      throw new WorktreeTamperedError(worktree, 'missing trusted hashes; existing workspaces require explicit migration');
    }
    return state;
  }

  private refsPath(repo: string) { return join(this.dataDir, 'git-ref-records', `${createHash('sha256').update(repo).digest('hex')}.json`); }

  /** Hash raw ref files, never resolve them through agent-controlled git config. */
  private refsDigest(repo: string): string {
    const common = join(this.repoDir(repo), '.git');
    const records: string[][] = [];
    const visit = (p: string) => {
      const name = p.slice(common.length);
      const stat = lstatSync(p, { throwIfNoEntry: false });
      if (!stat) { records.push([name, 'missing']); return; }
      if (stat.isSymbolicLink()) throw new WorktreeTamperedError(common, 'symbolic link in ref metadata');
      if (stat.isDirectory()) { records.push([name, 'directory']); for (const n of readdirSync(p).sort()) visit(join(p, n)); }
      else if (stat.isFile()) records.push([name, 'file', createHash('sha256').update(readFileSync(p)).digest('hex')]);
      else throw new WorktreeTamperedError(common, 'non-file ref metadata');
    };
    for (const name of ['HEAD', 'packed-refs', 'refs']) visit(join(common, name));
    const worktrees = join(common, 'worktrees');
    if (existsSync(worktrees)) for (const name of readdirSync(worktrees).sort()) visit(join(worktrees, name, 'HEAD'));
    return createHash('sha256').update(JSON.stringify(records)).digest('hex');
  }

  private saveRefs(repo: string) {
    mkdirSync(join(this.dataDir, 'git-ref-records'), { recursive: true });
    writeFileSync(this.refsPath(repo), JSON.stringify({ digest: this.refsDigest(repo) }));
  }

  verifyRefs(repo: string) {
    if (!existsSync(this.refsPath(repo))) throw new WorktreeTamperedError(this.repoDir(repo), 'no trusted ref snapshot');
    const expected = JSON.parse(readFileSync(this.refsPath(repo), 'utf8')).digest;
    if (this.refsDigest(repo) !== expected) throw new WorktreeTamperedError(this.repoDir(repo), 'unexpected ref or HEAD change');
  }

  verifyAgentWorkspace(worktree: string): Promise<void> {
    const rec = this.verifiedRecord(worktree);
    return this.withRepoLock(rec.repo, async () => { this.verifiedRecord(worktree); this.verifyRefs(rec.repo); });
  }

  /** Independent authenticated clone: no hardlinks, alternates or imports from agent-writable objects. */
  private async provisionTrusted(repo: string, path: string, base: string, branch?: string) {
    const dir = join(this.dataDir, 'trusted-git', basename(path));
    if (existsSync(dir)) throw new WorktreeTamperedError(path, 'unregistered private object store already exists');
    mkdirSync(join(this.dataDir, 'trusted-git'), { recursive: true });
    await runOk('git', [...HARDENING, ...this.scm.gitAuthArgs(), 'clone', '--no-checkout', '--no-local', this.scm.cloneUrl(repo), dir], { env: gitEnv(this.gitHome()), timeoutMs: 900_000 });
    const gitDir = join(dir, '.git');
    const git = (args: string[]) => runOk('git', [...HARDENING, `--git-dir=${gitDir}`, `--work-tree=${path}`, ...args], { cwd: path, env: gitEnv(this.gitHome()), timeoutMs: 300_000 });
    const baseSha = (await git(['rev-parse', '--verify', `${base}^{commit}`])).trim();
    let headSha = baseSha;
    if (branch) {
      const remote = await run('git', [...HARDENING, `--git-dir=${gitDir}`, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], { env: gitEnv(this.gitHome()) });
      if (remote.code === 0) headSha = remote.stdout.trim();
      await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    }
    await git(['update-ref', 'HEAD', headSha]);
    await git(['config', 'user.name', 'autodev[bot]']);
    await git(['config', 'user.email', 'autodev-bot@users.noreply.github.com']);
    appendFileSync(join(gitDir, 'info', 'exclude'), '\n/.autodev-cache/\n');
    await git(['read-tree', '--reset', '-u', headSha]);
    this.db.prepare('INSERT INTO git_states VALUES (?,?,?,?)').run(realpathSync(path), gitDir, baseSha, headSha);
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
    return this.runGit(cwd, args, (dirArgs) => runOk('git', [...HARDENING, ...(auth ? this.scm.gitAuthArgs() : []), ...dirArgs, ...args], { cwd, env: gitEnv(this.gitHome()), timeoutMs, signal }));
  }
  gitRaw(cwd: string, args: string[], auth = false) {
    return this.runGit(cwd, args, (dirArgs) => run('git', [...HARDENING, ...(auth ? this.scm.gitAuthArgs() : []), ...dirArgs, ...args], { cwd, env: gitEnv(this.gitHome()), timeoutMs: 300_000 }));
  }

  /**
   * Reference-clone commands run entirely under the repo lock: verify refs, run, then record the new snapshot
   * (also after a failed command, whose partial ref changes are still the orchestrator's own). A failed
   * pre-check records nothing, so tampering stays detected. Worktree commands use the private store and only
   * need a quiescent, locked ref check first.
   */
  private async runGit<T>(cwd: string, args: string[], exec: (dirArgs: string[]) => Promise<T>): Promise<T> {
    const abs = resolve(cwd);
    const clone = this.clones.get(abs);
    if (clone) {
      return this.withRepoLock(clone, async () => {
        this.verifyRefs(clone);
        try {
          return await exec(this.gitDirArgs(cwd));
        } finally {
          await this.testHooks.afterCloneCommand?.(args);
          this.saveRefs(clone);
        }
      });
    }
    const dirArgs = this.gitDirArgs(cwd);
    if (this.isWorktreePath(abs)) await this.verifyRefsLocked(this.verifiedRecord(abs).repo);
    return exec(dirArgs);
  }

  ensureClone(repo: string): Promise<string> {
    return this.withRepoLock(repo, () => this.ensureCloneUnlocked(repo));
  }

  private async ensureCloneUnlocked(repo: string): Promise<string> {
    const dir = this.repoDir(repo);
    if (existsSync(dir) && !existsSync(join(dir, '.git'))) rmSync(dir, { recursive: true, force: true }); // interrupted clone
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(join(this.workspaceDir, 'repos'), { recursive: true });
      await runOk('git', [...HARDENING, ...this.scm.gitAuthArgs(), 'clone', '--no-checkout', '--no-local', this.scm.cloneUrl(repo), dir], { env: gitEnv(this.gitHome()), timeoutMs: 900_000 });
      this.saveRefs(repo);
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
    if (existsSync(join(path, '.git'))) { this.verifiedRecord(path); this.trustedState(path); return { path, reused: true }; }
    mkdirSync(join(this.workspaceDir, 'worktrees'), { recursive: true });
    await this.git(repoDir, ['worktree', 'prune']);
    const localExists = (await this.gitRaw(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
    if (localExists) await this.git(repoDir, ['worktree', 'add', path, branch]);
    else if (await this.remoteBranchExists(repoDir, branch)) await this.git(repoDir, ['worktree', 'add', '-b', branch, path, `origin/${branch}`]);
    else await this.git(repoDir, ['worktree', 'add', '--no-track', '-b', branch, path, `origin/${base}`]);
    this.register(repo, path);
    await this.provisionTrusted(repo, path, `origin/${base}`, branch);
    return { path, reused: localExists };
  }

  /** Detached research checkout (planning). */
  addDetachedWorktree(repo: string, name: string, ref: string): Promise<string> {
    return this.withRepoLock(repo, async () => {
      const path = this.worktreeDir(name);
      mkdirSync(join(this.workspaceDir, 'worktrees'), { recursive: true });
      await this.git(this.repoDir(repo), ['worktree', 'add', '--detach', path, ref]);
      this.register(repo, path);
      await this.provisionTrusted(repo, path, ref);
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
    const head = (await this.git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    this.db.prepare('UPDATE git_states SET head_sha = ? WHERE worktree = ?').run(head, realpathSync(path));
    return true;
  }

  async headSha(path: string): Promise<string> {
    const rec = this.verifiedRecord(path);
    await this.verifyRefsLocked(rec.repo);
    return this.trustedState(path).head_sha;
  }

  async aheadOf(path: string, base: string): Promise<number> {
    const state = this.trustedState(path);
    return Number((await this.git(path, ['rev-list', '--count', `${state.base_sha}..${state.head_sha}`])).trim());
  }

  async fetch(path: string) { await this.git(path, ['fetch', 'origin'], true); }

  /** Push without force. Returns false (and the message) if the remote rejected the push. */
  async push(path: string, branch: string, repo?: string, control: { signal?: AbortSignal; beforePush?: () => Promise<unknown>; expectedSha?: string } = {}): Promise<void> {
    const doPush = async () => {
      const sha = await this.headSha(path);
      if (!control.expectedSha || control.expectedSha !== sha) throw new WorktreeTamperedError(path, 'push does not match the validated candidate');
      await this.assertCandidate(path, sha);
      // Scan every outgoing commit, including secrets subsequently removed. Pin the
      // scanned SHA so a concurrent HEAD change cannot swap in unscanned content.
      const commits = (await this.git(path, ['rev-list', `${this.trustedState(path).base_sha}..${sha}`])).trim().split('\n').filter(Boolean);
      for (const commit of commits) {
        const patch = await this.git(path, ['show', '--format=', '--root', '--diff-merges=separate', '--no-ext-diff', '--no-textconv', commit]);
        const secrets = scanSecrets(patch);
        if (secrets.length) throw new UnsafePushError(secrets);
      }
      control.signal?.throwIfAborted();
      await control.beforePush?.();
      await this.assertCandidate(path, sha);
      control.signal?.throwIfAborted();
      await this.git(path, ['push', '--set-upstream', 'origin', `${sha}:refs/heads/${branch}`], true, 300_000, control.signal);
    };
    await (repo ? this.withRepoLock(repo, doPush) : doPush());
  }

  async diff(path: string, base: string, stat = false): Promise<string> {
    const state = this.trustedState(path);
    return this.git(path, ['diff', '--no-ext-diff', '--no-textconv', ...(stat ? ['--stat'] : []), `${state.base_sha}...${state.head_sha}`]);
  }

  async changedFiles(path: string, base: string): Promise<string[]> {
    const state = this.trustedState(path);
    return (await this.git(path, ['diff', '--name-only', `${state.base_sha}...${state.head_sha}`])).split('\n').filter(Boolean);
  }

  async assertCandidate(path: string, sha: string): Promise<void> {
    const state = this.trustedState(path);
    if (state.head_sha !== sha || (await this.status(path)).trim()) throw new WorktreeTamperedError(path, 'candidate or working files changed after capture');
    const head = (await this.git(path, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (head !== sha) throw new WorktreeTamperedError(path, 'private HEAD differs from trusted candidate');
  }

  private candidateRecordPath(path: string) { return join(this.dataDir, 'candidate-records', `${basename(path)}.json`); }

  private fileDigest(path: string): string {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `link:${createHash('sha256').update(readlinkSync(path, { encoding: 'buffer' })).digest('hex')}`;
    if (!stat.isFile()) throw new WorktreeTamperedError(path, 'candidate path is not a regular file or symlink');
    return `file:${stat.mode & 0o111}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  }

  /** Checkout from private objects, without .git or shared metadata. The coder cannot write this sibling. */
  async candidateSnapshot(source: string, sha: string): Promise<string> {
    await this.assertCandidate(source, sha);
    const path = join(this.workspaceDir, 'candidates', `${basename(source)}-${sha}`);
    if (existsSync(path)) { await this.assertSnapshot(path, source, sha); return path; }
    mkdirSync(path, { recursive: true });
    const entries = (await this.git(source, ['ls-tree', '-r', '-z', sha])).split('\0').filter(Boolean);
    const names: string[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t');
      const [mode, type] = entry.slice(0, tab).split(' ');
      const name = entry.slice(tab + 1);
      if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode) || name.split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) {
        throw new WorktreeTamperedError(source, 'unsupported candidate tree entry (including submodules)');
      }
      names.push(name);
    }
    await this.git(source, ['checkout-index', '--all', '--force', `--prefix=${path}${sep}`]);
    const files: Record<string, string> = {};
    for (const name of names) files[name] = this.fileDigest(join(path, name));
    const record: CandidateRecord = { source: realpathSync(source), path: realpathSync(path), sha, files };
    mkdirSync(join(this.dataDir, 'candidate-records'), { recursive: true });
    writeFileSync(this.candidateRecordPath(path), JSON.stringify(record));
    return path;
  }

  verifySnapshot(path: string, source: string, sha: string): void {
    try {
      const record = JSON.parse(readFileSync(this.candidateRecordPath(path), 'utf8')) as CandidateRecord;
      if (record.path !== realpathSync(path) || record.source !== realpathSync(source) || record.sha !== sha) throw new Error('candidate provenance mismatch');
      for (const [name, digest] of Object.entries(record.files)) {
        let parent = path;
        for (const part of name.split('/').slice(0, -1)) {
          parent = join(parent, part);
          const stat = lstatSync(parent);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`candidate directory changed: ${name}`);
        }
        if (this.fileDigest(join(path, name)) !== digest) throw new Error(`candidate file changed: ${name}`);
      }
      if (lstatSync(join(path, '.git'), { throwIfNoEntry: false })) throw new Error('git metadata in candidate snapshot');
    } catch (e) { throw new WorktreeTamperedError(path, `candidate snapshot invalid: ${String((e as Error).message)}`); }
  }

  async assertSnapshot(path: string, source: string, sha: string): Promise<void> {
    this.verifySnapshot(path, source, sha);
    // Detect additional source/config inputs as well as edits to tracked files.
    // Build outputs and dependency caches must be ignored by the approved tree.
    const changes = await this.git(source, [`--work-tree=${path}`, 'status', '--porcelain', '--untracked-files=all']);
    if (changes.trim()) throw new WorktreeTamperedError(path, `candidate snapshot invalid: unexpected files or index changes: ${changes.slice(0, 500)}`);
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
    const canonical = realpathSync(path);
    if (!force && (await this.status(path)).trim()) return false;
    const records = join(this.dataDir, 'candidate-records');
    if (existsSync(records)) for (const name of readdirSync(records)) {
      const file = join(records, name);
      const rec = JSON.parse(readFileSync(file, 'utf8')) as CandidateRecord;
      if (rec.source !== canonical) continue;
      try { this.verifySnapshot(rec.path, path, rec.sha); }
      catch { continue; } // preserve an unexpectedly modified snapshot for inspection
      rmSync(rec.path, { recursive: true, force: true });
      rmSync(file);
    }
    await this.gitRaw(this.repoDir(repo), ['worktree', 'remove', '--force', path]);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    rmSync(this.recordPath(path), { force: true });
    const state = this.db.prepare('SELECT * FROM git_states WHERE worktree = ?').get(canonical) as unknown as GitState | undefined;
    if (state) { rmSync(resolve(state.git_dir, '..'), { recursive: true, force: true }); this.db.prepare('DELETE FROM git_states WHERE worktree = ?').run(canonical); }
    return true;
  }
}
