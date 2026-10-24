import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './exec.ts';
import type { ExecResult } from './exec.ts';

/** No host HOME, credential variables, sockets, or config directories. */
export function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${dirname(realpathSync(process.execPath))}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8', CI: 'true', NODE_ENV: 'test',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|^AWS_|^GOOGLE_|^AZURE_|^ANTHROPIC|^CLAUDE|^HOME$|^PATH$|^TMPDIR$|^NODE_OPTIONS$|^LD_|^DYLD_/i.test(k)) {
      throw new Error(`Refusing credential or process-control environment variable: ${k}`);
    }
    env[k] = v;
  }
  return env;
}

/** A filesystem allowlist: system runtime files, this worktree, and a private temporary HOME.
 * Networking is deliberately disabled. Setup must use offline dependencies/caches in the worktree.
 * No fallback is permitted when the OS sandbox is unavailable.
 */
export interface SandboxInputs {
  npmCacheDir?: string;
  /** Test seam only (not reachable from config): substitute the sandbox launcher to simulate it being unavailable. */
  launcherOverride?: string;
  /** Diagnostic callback; never reachable from project configuration or agent tools. */
  onProfile?: (profile: string, tag: string) => void;
}

/** Root is a literal directory grant, not a recursive read grant. On modern macOS,
 * dyld's libignition opens / as the base for openat (see Apple's dyld-support.sb).
 */
export function macosSandboxProfile(worktree: string, scratch: string, runtime: string, tag: string): string {
  const path = (p: string) => JSON.stringify(p);
  const readable = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/etc/localtime', runtime, worktree, scratch];
  const paths = readable.map(p => `(subpath ${path(p)})`).join(' ');
  return `(version 1)
(deny default (with message ${path(tag)}))
(allow process-exec process-fork signal sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* file-test-existence (literal "/"))
(allow file-read* ${paths} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-map-executable ${paths})
(allow file-write* (subpath ${path(worktree)}) (subpath ${path(scratch)}) (literal "/dev/null"))
(deny file-write* (literal ${path(join(worktree, '.git'))}))`;
}

export async function runSandboxed(cmd: string, cwd: string, extra: Record<string, string>, timeoutMs: number, signal?: AbortSignal, inputs: SandboxInputs = {}): Promise<ExecResult> {
  const worktree = realpathSync(cwd);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'autodev-command-')));
  const runtime = dirname(dirname(realpathSync(process.execPath)));
  try {
    const env = { ...commandEnv(extra), HOME: scratch, TMPDIR: scratch, npm_config_cache: join(scratch, 'npm') };
    // Copy only package cache data, never .npmrc, logs, auth files or the host HOME.
    // Symlinks remain symlinks and cannot escape the OS sandbox's read boundary.
    if (inputs.npmCacheDir) cpSync(join(inputs.npmCacheDir, '_cacache'), join(scratch, 'npm', '_cacache'), { recursive: true, dereference: false });
    if (process.platform === 'darwin') {
      const tag = `AUTODEV_${basename(scratch)}`;
      const profile = macosSandboxProfile(worktree, scratch, runtime, tag);
      inputs.onProfile?.(profile, tag);
      const result = await run(inputs.launcherOverride ?? '/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { cwd: worktree, env, timeoutMs, signal });
      if (result.code !== 0) result.stderr += `\nSandboxed command exited ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}. Seatbelt log tag: ${tag}. Run the no-AI diagnostic: node scripts/diagnose-sandbox.ts\n`;
      return result;
    }
    if (process.platform === 'linux') {
      const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
      for (const p of [...new Set(['/usr', '/bin', '/sbin', '/lib', '/lib64', runtime])]) {
        if (existsSync(p)) args.push('--ro-bind', p, p);
      }
      args.push('--bind', worktree, worktree, '--bind', scratch, scratch);
      // The worktree's git pointer is read-only: repository code must not redirect the orchestrator's git.
      if (existsSync(join(worktree, '.git'))) args.push('--ro-bind', join(worktree, '.git'), join(worktree, '.git'));
      args.push('--chdir', worktree, '--clearenv');
      for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
      args.push('/bin/sh', '-c', cmd);
      return await run(inputs.launcherOverride ?? 'bwrap', args, { cwd: worktree, env, timeoutMs, signal });
    }
    throw new Error(`No command sandbox for ${process.platform}; refusing repository execution`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
