import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
export async function runSandboxed(cmd: string, cwd: string, extra: Record<string, string>, timeoutMs: number, signal?: AbortSignal, inputs: { npmCacheDir?: string } = {}): Promise<ExecResult> {
  const worktree = realpathSync(cwd);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'autodev-command-')));
  const runtime = dirname(dirname(realpathSync(process.execPath)));
  try {
    const env = { ...commandEnv(extra), HOME: scratch, TMPDIR: scratch, npm_config_cache: join(scratch, 'npm') };
    // Copy only package cache data, never .npmrc, logs, auth files or the host HOME.
    // Symlinks remain symlinks and cannot escape the OS sandbox's read boundary.
    if (inputs.npmCacheDir) cpSync(join(inputs.npmCacheDir, '_cacache'), join(scratch, 'npm', '_cacache'), { recursive: true, dereference: false });
    if (process.platform === 'darwin') {
      const path = (p: string) => JSON.stringify(p);
      const readable = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/etc/localtime', runtime, worktree, scratch];
      const profile = `(version 1)
(deny default)
(allow process-exec process-fork signal sysctl-read mach-lookup)
(allow file-read-metadata)
(allow file-read* ${readable.map(p => `(subpath ${path(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-write* (subpath ${path(worktree)}) (subpath ${path(scratch)}) (literal "/dev/null"))`;
      return await run('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { cwd: worktree, env, timeoutMs, signal });
    }
    if (process.platform === 'linux') {
      const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
      for (const p of [...new Set(['/usr', '/bin', '/sbin', '/lib', '/lib64', runtime])]) {
        if (existsSync(p)) args.push('--ro-bind', p, p);
      }
      args.push('--bind', worktree, worktree, '--bind', scratch, scratch, '--chdir', worktree, '--clearenv');
      for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
      args.push('/bin/sh', '-c', cmd);
      return await run('bwrap', args, { cwd: worktree, env, timeoutMs, signal });
    }
    throw new Error(`No command sandbox for ${process.platform}; refusing repository execution`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
