import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; signal?: NodeJS.Signals | null }

/**
 * Run a command without a shell unless `shell` is set. Output is capped to keep memory bounded.
 * Never throws for non-zero exit; callers inspect `code`.
 */
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shell?: boolean; input?: string; maxOutput?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  const max = opts.maxOutput ?? 2_000_000;
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve({ code: 130, stdout: '', stderr: 'aborted', timedOut: false, truncated: false }); return; }
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, shell: opts.shell ?? false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    const cap = (s: string, d: string) => { if (s.length + d.length > max) { truncated = true; return (s + d).slice(-max); } return s + d; };
    child.stdout.on('data', (d) => (stdout = cap(stdout, d.toString())));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d.toString())));
    const kill = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    opts.signal?.addEventListener('abort', kill, { once: true });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : null;
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ code: code ?? (timedOut ? 124 : signal ? 128 + (constants.signals[signal] ?? 0) : 1), stdout, stderr, timedOut, truncated, signal });
    });
    if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Run and throw on failure. */
export async function runOk(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  const safeArgs = args.map(a => a.replace(/(AUTHORIZATION:\s*(?:basic|bearer)\s+)\S+/ig, '$1[REDACTED]')).join(' ');
  if (r.code !== 0) throw new Error(`${cmd} ${safeArgs} failed (${r.code}${r.signal ? `, signal ${r.signal}` : ''}${r.timedOut ? ', timed out' : ''}): ${(r.stderr || r.stdout).slice(-2000)}`);
  if (r.truncated) throw new Error(`${cmd} output exceeded the safety limit; refusing to use incomplete output`);
  return r.stdout;
}

export function tail(s: string, n = 6000): string {
  return s.length > n ? '…(truncated)…\n' + s.slice(-n) : s;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function slugify(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max).replace(/-$/, '');
}
