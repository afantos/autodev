import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ZodRawShape } from 'zod';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '../types.ts';

export interface AgentTool {
  name: string;
  description: string;
  schema: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * readonly: research only (planning, decision); review: readonly + git inspection;
 * write: full edit + Bash inside the sandboxed worktree (coding).
 */
export type AgentMode = 'readonly' | 'review' | 'write';

export interface AgentRunSpec {
  role: AgentRole;
  prompt: string;
  systemAppend: string;
  cwd: string;
  model: string;
  mode: AgentMode;
  tools?: AgentTool[];
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  resume?: string | null;
  /** Extra env (project env). Merged into a scrubbed base env — orchestrator secrets are never passed. */
  env?: Record<string, string>;
  webResearch?: boolean;
  plugins?: string[];
  sandbox?: { enabled: boolean; failIfUnavailable: boolean; allowedDomains: string[] };
  onMessage?: (m: SDKMessage) => void;
  signal?: AbortSignal;
  protectedPaths?: string[];
  repository?: string;
  gitReadPaths?: string[];
}

export type AgentErrorKind = 'rate_limited' | 'budget' | 'max_turns' | 'timeout' | 'auth' | 'api' | 'structured_output' | 'other';

export interface AgentRunResult {
  ok: boolean;
  structured: unknown;
  text: string;
  sessionId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  numTurns: number;
  /** False when no terminal usage result was received; keep its budget reserved. */
  usageComplete?: boolean;
  error?: string;
  errorKind?: AgentErrorKind;
  /** Epoch ms when a usage limit resets (subscription rate limits). */
  resetsAt?: number;
}

export interface AgentRunner {
  run(spec: AgentRunSpec): Promise<AgentRunResult>;
}

/** Env vars an agent process may inherit. Everything else (GITHUB_TOKEN, LINEAR_API_KEY, cloud creds…) is dropped. */
const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'NVM_DIR', 'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { CI: 'true', AUTODEV_AGENT: '1', DISABLE_AUTOUPDATER: '1' };
  for (const k of ENV_ALLOW) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(extra)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(k) && !/^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/.test(k) && !/TEST|DUMMY|FAKE/i.test(k + v)) {
      throw new Error(`refusing to pass secret-looking env var ${k} to an agent; use a test value name containing TEST`);
    }
    env[k] = v;
  }
  return env;
}

/** Commands no agent may run, in any permission mode. */
export const DENY_ALWAYS = [
  'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)', 'Bash(git credential:*)',
  'Bash(gh:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(sudo:*)', 'Bash(su:*)',
  'Bash(npm publish:*)', 'Bash(docker:*)', 'Bash(kubectl:*)', 'Bash(terraform:*)', 'Bash(aws:*)', 'Bash(gcloud:*)',
  'Bash(vercel:*)', 'Bash(railway:*)', 'Bash(psql:*)', 'Bash(rm -rf /:*)', 'Bash(rm -rf ~:*)',
];

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git grep:*)', 'Bash(git status:*)', 'Bash(ls:*)', 'Bash(wc:*)'];
const WRITE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'TodoWrite', 'Task'];

/**
 * OS sandbox for the agent's Bash commands. Whole trees are denied (HOME, config, state) and the worktree
 * lives outside all of them, so ordinary commands can resolve their cwd. Git metadata is readable for
 * status/diff/log but nothing outside the worktree is writable, and the worktree's .git pointer is not.
 */
export function agentSandbox(spec: Pick<AgentRunSpec, 'cwd' | 'mode' | 'sandbox' | 'protectedPaths' | 'gitReadPaths'>): NonNullable<Options['sandbox']> {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: spec.mode === 'write',
    allowUnsandboxedCommands: false,
    network: { allowedDomains: spec.sandbox?.allowedDomains ?? [], strictAllowlist: true },
    filesystem: {
      denyRead: [...(spec.protectedPaths ?? [])],
      allowRead: [spec.cwd, ...(spec.gitReadPaths ?? []), runtimeRoot()],
      allowWrite: [],
      denyWrite: [join(spec.cwd, '.git')],
    },
    credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', mode: 'deny' }] },
  };
}

/** The Node runtime may live under a denied HOME (nvm); re-allow just its install tree. */
function runtimeRoot(): string {
  return dirname(dirname(realpathSync(process.execPath)));
}

/** Tool configuration that never touches the (denied) HOME: no user git/npm config, caches in the worktree's sibling. */
export function commandToolEnv(cwd: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    NPM_CONFIG_USERCONFIG: '/dev/null', npm_config_cache: join(cwd, '.autodev-cache', 'npm'), npm_config_update_notifier: 'false',
  };
}

export function classifyError(msg: string): AgentErrorKind {
  if (/rate.?limit|usage limit|limit reached|429|quota/i.test(msg)) return 'rate_limited';
  if (/401|403|unauthori[sz]ed|authentication|invalid api key|not logged in|login/i.test(msg)) return 'auth';
  if (/overloaded|529|50[0-9]|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(msg)) return 'api';
  return 'other';
}

export class ClaudeRunner implements AgentRunner {
  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const started = Date.now();
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (spec.signal?.aborted) abort.abort();
    spec.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort.abort(), spec.timeoutMs);
    const res: AgentRunResult = { ok: false, structured: null, text: '', sessionId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, durationMs: 0, numTurns: 0, usageComplete: false };
    if (!spec.sandbox?.enabled) {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', cancel);
      return { ...res, usageComplete: true, errorKind: 'other', error: 'Agent sandbox must be enabled; refusing unsandboxed execution' };
    }

    const mcpServers: Options['mcpServers'] = {};
    const mcpAllowed: string[] = [];
    if (spec.tools?.length) {
      mcpServers.autodev = createSdkMcpServer({
        name: 'autodev',
        version: '1.0.0',
        tools: spec.tools.map((t) => tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => ({
          content: [{ type: 'text' as const, text: await t.handler(args) }],
        }))),
      });
      for (const t of spec.tools) mcpAllowed.push(`mcp__autodev__${t.name}`);
    }

    const allowed = [...(spec.mode === 'write' ? WRITE_TOOLS : READ_TOOLS), ...mcpAllowed, ...(spec.webResearch ? ['WebSearch', 'WebFetch'] : [])];
    const disallowed = [...DENY_ALWAYS, ...(spec.mode === 'write' ? [] : ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']), ...(spec.webResearch ? [] : ['WebSearch', 'WebFetch'])];

    const options: Options = {
      cwd: spec.cwd,
      model: spec.model,
      permissionMode: 'dontAsk', // anything not explicitly allowed is denied; nobody is there to prompt
      allowedTools: allowed,
      disallowedTools: disallowed,
      maxTurns: spec.maxTurns,
      maxBudgetUsd: spec.maxBudgetUsd,
      abortController: abort,
      env: agentEnv({ ...commandToolEnv(spec.cwd), ...spec.env }),
      settingSources: [], // conventions are read explicitly; repository hooks/settings cannot widen permissions
      settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemAppend },
      mcpServers,
      resume: spec.resume ?? undefined,
      plugins: spec.plugins?.map((path) => ({ type: 'local' as const, path })),
    };
    if (spec.outputSchema) options.outputFormat = { type: 'json_schema', schema: spec.outputSchema };
    options.sandbox = agentSandbox(spec);

    try {
      for await (const m of query({ prompt: spec.prompt, options })) {
        spec.onMessage?.(m);
        if (m.type === 'system' && m.subtype === 'init') res.sessionId = m.session_id;
        if (m.type === 'rate_limit_event' && m.rate_limit_info.status === 'rejected') {
          res.errorKind = 'rate_limited';
          if (m.rate_limit_info.resetsAt) res.resetsAt = m.rate_limit_info.resetsAt * (m.rate_limit_info.resetsAt < 1e12 ? 1000 : 1);
        }
        if (m.type === 'result') {
          res.usageComplete = true;
          res.sessionId = m.session_id ?? res.sessionId;
          res.costUsd = m.total_cost_usd ?? 0;
          res.numTurns = m.num_turns;
          for (const u of Object.values(m.modelUsage ?? {})) {
            res.inputTokens += u.inputTokens; res.outputTokens += u.outputTokens; res.cacheReadTokens += u.cacheReadInputTokens;
          }
          if (m.subtype === 'success' && !m.is_error) {
            res.ok = true;
            res.text = m.result;
            res.structured = m.structured_output ?? null;
          } else {
            res.ok = false;
            res.error = m.subtype === 'success' ? m.result : m.subtype;
            res.errorKind = res.errorKind ?? (m.subtype === 'error_max_budget_usd' ? 'budget' : m.subtype === 'error_max_turns' ? 'max_turns'
              : m.subtype === 'error_max_structured_output_retries' ? 'structured_output' : classifyError(String(res.error)));
          }
        }
      }
    } catch (e) {
      res.ok = false;
      res.error = String((e as Error)?.message ?? e);
      res.errorKind = abort.signal.aborted ? 'timeout' : res.errorKind ?? classifyError(res.error);
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener('abort', cancel);
      res.durationMs = Date.now() - started;
    }
    if (res.ok && spec.outputSchema && res.structured == null) {
      // Fall back to parsing a JSON block from the text result.
      res.structured = extractJson(res.text);
      if (res.structured == null) { res.ok = false; res.errorKind = 'structured_output'; res.error = 'agent returned no structured output'; }
    }
    return res;
  }
}

export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch { /* next */ }
  }
  return null;
}
