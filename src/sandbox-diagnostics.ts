import { commandEnv, runSandboxed } from './command-sandbox.ts';
import type { SandboxInputs } from './command-sandbox.ts';
import { createServer, connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { run, shellQuote } from './exec.ts';
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

export interface NetworkIsolation {
  isolated: boolean;
  reason?: string;
  /** Host addresses of a real listener the sandboxed command tried to reach. */
  targets: string[];
  port: number;
  /** Positive control: the host itself reached each target before and after the probe. */
  hostReachBefore: Record<string, boolean>;
  hostReachAfter: Record<string, boolean>;
  /** Outcome per target inside the sandbox: CONNECTED, TIMEOUT or an errno code. */
  sandbox: Record<string, string>;
  /** Connections the listener accepted while the sandboxed probe ran (must be 0). */
  acceptedDuringProbe: number;
}

export type ProbeRunner = (cmd: string, cwd: string) => Promise<ExecResult>;

function hostReach(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

/**
 * Proves network isolation against a known-reachable listener rather than inferring it from an error code:
 * the host must reach the listener (on loopback and on a non-loopback interface when one exists) before and
 * after the probe, the sandboxed command must report a failure for every target, and the listener must
 * accept nothing while the sandboxed command runs. ECONNREFUSED alone proves nothing and is never sufficient.
 */
export async function probeNetworkIsolation(runner: ProbeRunner, cwd: string): Promise<NetworkIsolation> {
  let accepted = 0;
  const server = createServer((socket) => { accepted++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  const targets = ['127.0.0.1', ...(external ? [external] : [])];
  // Control connections are accepted asynchronously after the client sees 'connect'; wait until the listener
  // has accepted every one of them, so only connections made during the probe window are attributed to it.
  let controls = 0;
  const reachAll = async () => {
    const result = Object.fromEntries(await Promise.all(targets.map(async (t) => [t, await hostReach(t, port)] as const)));
    controls += Object.values(result).filter(Boolean).length;
    for (const deadline = Date.now() + 2000; accepted < controls && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 5));
    return result;
  };
  try {
    const hostReachBefore = await reachAll();
    const before = accepted;
    const script = `const net=require('node:net');const out={};let n=${targets.length};for(const h of ${JSON.stringify(targets)}){const s=net.connect({host:h,port:${port}});const fin=v=>{if(h in out)return;out[h]=v;s.destroy();if(--n===0)console.log('AUTODEV_NET '+JSON.stringify(out))};s.setTimeout(2000,()=>fin('TIMEOUT'));s.on('connect',()=>fin('CONNECTED'));s.on('error',e=>fin(e.code||'ERROR'))}`;
    const r = await runner(`${shellQuote(process.execPath)} -e ${shellQuote(script)}`, cwd);
    await new Promise((resolve) => setTimeout(resolve, 250)); // let in-flight accepts from the probe land in its window
    const acceptedDuringProbe = accepted - before;
    const hostReachAfter = await reachAll();
    const line = r.stdout.split('\n').find((l) => l.startsWith('AUTODEV_NET '));
    let sandbox: Record<string, string> = {};
    try { sandbox = line ? JSON.parse(line.slice('AUTODEV_NET '.length)) : {}; } catch { /* malformed */ }
    let reason: string | undefined;
    if (!targets.every((t) => hostReachBefore[t] && hostReachAfter[t])) reason = 'no positive control: the host could not reach its own listener';
    else if (acceptedDuringProbe > 0 || targets.some((t) => sandbox[t] === 'CONNECTED')) reason = 'the sandboxed command reached a host listener';
    else if (!targets.every((t) => typeof sandbox[t] === 'string')) reason = `the probe did not run inside the sandbox (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`;
    return { isolated: !reason, reason, targets, port, hostReachBefore, hostReachAfter, sandbox, acceptedDuringProbe };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
