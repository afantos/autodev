import { commandEnv, runSandboxed } from './command-sandbox.ts';
import type { SandboxInputs } from './command-sandbox.ts';
import { run } from './exec.ts';
import type { ExecResult } from './exec.ts';

const MARKER = 'AUTODEV_SANDBOX_READY';
export interface SandboxDiagnosis {
  status: 'ready' | 'host_unavailable' | 'profile_failed';
  baseline: ExecResult;
  probe?: ExecResult;
}

export function classifySandbox(baseline: ExecResult, probe?: ExecResult): SandboxDiagnosis {
  if (baseline.code !== 0) return { status: 'host_unavailable', baseline };
  if (!probe || probe.code !== 0 || probe.stdout.trim() !== MARKER) return { status: 'profile_failed', baseline, probe };
  return { status: 'ready', baseline, probe };
}

/** The baseline runs only a fixed, trusted true command. It does not execute repo code.
 * A working baseline plus a failing autodev profile is a failure, never a test skip.
 */
export async function diagnoseSandbox(cwd: string, inputs: SandboxInputs = {}): Promise<SandboxDiagnosis> {
  const env = commandEnv();
  const baseline = process.platform === 'darwin'
    ? await run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { cwd, env, timeoutMs: 5000 })
    : process.platform === 'linux'
      ? await run('bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { cwd, env, timeoutMs: 5000 })
      : { code: 1, stdout: '', stderr: `No command sandbox for ${process.platform}`, timedOut: false, truncated: false };
  if (baseline.code !== 0) return classifySandbox(baseline);
  const probe = await runSandboxed(`printf %s '${MARKER}'`, cwd, {}, 5000, undefined, inputs);
  return classifySandbox(baseline, probe);
}
