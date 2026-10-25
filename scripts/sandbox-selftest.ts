/**
 * Sandbox self-test: proves the command sandbox (bwrap on Linux, sandbox-exec on macOS) can start in the CURRENT
 * process environment. The systemd unit runs it as ExecStartPre, so it runs under the unit's exact hardening, and
 * prepare-host.sh runs it through systemd-run with the unit's settings before the unit is ever enabled.
 * Exit 0 = the sandbox works; exit 1 = it doesn't (the service must not start and fail tickets instead).
 * No credentials, network or config needed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSandboxed } from '../src/command-sandbox.ts';

const dir = mkdtempSync(join(tmpdir(), 'autodev-selftest-'));
try {
  // The Node runtime must work inside the sandbox, and on Linux so must the fresh /proc that bwrap mounts (the
  // ProtectKernelTunables failure). macOS has no /proc.
  const node = 'node -e "process.stdout.write(String(6 * 7))"';
  const r = await runSandboxed(process.platform === 'linux' ? `test -r /proc/self/status && ${node}` : node, dir, {}, 60_000);
  if (r.code !== 0 || r.stdout.trim() !== '42') {
    console.error(`sandbox self-test FAILED (exit ${r.code}${r.signal ? `, signal ${r.signal}` : ''}): ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
    process.exitCode = 1;
  } else {
    console.log('sandbox self-test OK');
  }
} catch (e) {
  console.error(`sandbox self-test FAILED: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
