import { readFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join, basename } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ProjectSchema = z.object({
  /** Short key used everywhere (labels, branch names, CLI). */
  key: z.string().regex(/^[a-z0-9-]+$/),
  /** "owner/name" for GitHub, or a local path for the local SCM backend. */
  repo: z.string(),
  /** Base/integration branch. Defaults to the repo's default branch. */
  baseBranch: z.string().optional(),
  linear: z.object({
    teamKey: z.string(),
    /** Optional Linear project name to scope tickets; otherwise label `project:<key>` is used. */
    projectName: z.string().optional(),
  }).optional(),
  /** Commands the orchestrator runs itself in the worktree before pushing (in order). */
  validate: z.array(z.string()).default([]),
  /** Commands run once after creating a worktree (e.g. npm ci). */
  setup: z.array(z.string()).default([]),
  /** Dedicated offline npm cache, populated by the operator; never use a credential directory. */
  npmCacheDir: z.string().optional(),
  /** Extra env for agents and validation. `{{jobId}}` and `{{port}}` are templated. Never put production secrets here. */
  env: z.record(z.string(), z.string()).default({}),
  /** Required GitHub check names; empty = all reported checks must pass. */
  requiredChecks: z.array(z.string()).default([]),
  maxConcurrent: z.number().int().min(1).default(1),
  /** Allow basing a ticket on an unmerged dependency's branch (stacked PRs). */
  stackedBranches: z.boolean().default(false),
  /** Dependencies (npm/pypi names) the decision agent may auto-approve. */
  approvedDependencies: z.array(z.string()).default([]),
  /**
   * Merge clean PRs without a human: CI green, Claude review approved, second (GPT) review approved, policy clean,
   * branch up to date with base. Requires secondReview.enabled and a reviewer GitHub account. Flagged PRs still wait.
   */
  autoMerge: z.boolean().default(false),
  /** Repo-relative path regexes whose changes always need human review (e.g. lint boundary rules). */
  humanReviewPaths: z.array(z.string()).default([]),
  /** Send removed/changed assertions and newly skipped tests in test files to human review. */
  protectTests: z.boolean().default(false),
  /** Docs the agents should read first (paths relative to repo root). */
  docs: z.array(z.string()).default(['CLAUDE.md', 'AGENTS.md', 'README.md', 'docs/adr', 'CONTRIBUTING.md']),
  adrDir: z.string().default('docs/adr'),
});

const ConfigSchema = z.object({
  dataDir: z.string().default('./data'),
  /**
   * Repository clones and job worktrees. Must be outside HOME, the config directory and dataDir: agents are
   * denied those whole trees, and a worktree beneath a denied directory cannot even resolve its own cwd.
   * Default: a sibling of the config directory (e.g. /opt/autodev/instance → /opt/autodev/instance-work).
   */
  workspaceDir: z.string().optional(),
  tracker: z.enum(['linear', 'local']).default('linear'),
  scm: z.enum(['github', 'local']).default('github'),
  runner: z.enum(['claude', 'fake']).default('claude'),
  projects: z.array(ProjectSchema).min(1),
  linear: z.object({
    /** Workflow state names in Linear for each internal status. */
    states: z.object({
      ideas: z.string().default('Ideas'),
      backlog: z.string().default('Backlog'),
      ready: z.string().default('Ready'),
      in_progress: z.string().default('In Progress'),
      review: z.string().default('In Review'),
      done: z.string().default('Done'),
      blocked: z.string().default('Blocked'),
      failed: z.string().default('Failed'),
      canceled: z.string().default('Canceled'),
    }).prefault({}),
    /** Only tickets with this label are touched by the orchestrator (empty = all Ready tickets in configured teams). */
    requireLabel: z.string().default(''),
    /**
     * Owner hold: while a ticket carries this label, auto-merge never approves or merges its PR. Labels survive status
     * changes and branch refreshes; the merge gate re-reads the ticket before every attempt, approval and merge.
     * Empty string disables it.
     */
    holdMergeLabel: z.string().default('hold-merge'),
  }).prefault({}),
  concurrency: z.object({
    global: z.number().int().min(1).default(2),
  }).prefault({}),
  loop: z.object({
    tickSeconds: z.number().default(30),
    leaseSeconds: z.number().default(300),
    heartbeatSeconds: z.number().default(30),
    ciPollSeconds: z.number().default(60),
    cancellationPollSeconds: z.number().positive().default(5),
    /**
     * After a successful push, how long the PR's reported head may lag behind (GitHub's API is eventually consistent).
     * Only the exact validated candidate is accepted; a mismatch that persists past this window blocks as tampering.
     */
    prHeadConvergeSeconds: z.number().positive().max(300).default(30),
  }).prefault({}),
  limits: z.object({
    maxAttempts: z.number().default(3),
    maxFixAttempts: z.number().default(3),
    maxReviewCycles: z.number().default(2),
    maxDecisionsPerTicket: z.number().default(3),
    maxAttemptsPerQuestion: z.number().default(2),
    agentMaxTurns: z.number().default(200),
    agentTimeoutMinutes: z.number().default(90),
    decisionTimeoutMinutes: z.number().default(15),
    ciTimeoutMinutes: z.number().default(60),
  }).prefault({}),
  budget: z.object({
    dailyUsd: z.number().default(25),
    monthlyUsd: z.number().default(300),
    perTicketUsd: z.number().default(15),
    /** Owner-approved per-ticket limits that replace perTicketUsd for those tickets only (by identifier, e.g. DEV-56). */
    perTicketOverrides: z.record(z.string(), z.number().positive()).default({}),
    perRunUsd: z.number().default(8),
    perDecisionUsd: z.number().default(1.5),
    /** What happens when a budget is exhausted: wait for the next period, or stay paused until `autodev resume`. */
    onExhausted: z.enum(['resume_next_period', 'manual']).default('resume_next_period'),
  }).prefault({}),
  models: z.object({
    planning: z.string().default('opus'),
    coding: z.string().default('sonnet'),
    codingComplex: z.string().default('opus'),
    decision: z.string().default('sonnet'),
    review: z.string().default('opus'),
    classify: z.string().default('haiku'),
    /** Complexity at or above which codingComplex is used. */
    complexThreshold: z.number().default(4),
  }).prefault({}),
  /** Independent second reviewer from another vendor; its spend is a separate ledger from Claude's budget. */
  secondReview: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['openai']).default('openai'),
    model: z.string().default('gpt-6.1-sol'),
    dailyUsd: z.number().positive().default(50),
    monthlyUsd: z.number().positive().default(300),
    /**
     * Standard-tier pricing (USD per 1M tokens) and the long-context rule, from the model's official pricing page
     * (gpt-6.1-sol, checked 2026-10-24): >272K input tokens bills the whole request at 2x input/cache and 1.5x output.
     * Cache writes are 1.25x (30m) / 2.5x (12h) input; requests disable caching, so they only bound the reservation.
     */
    pricing: z.object({
      inputUsdPerMTok: z.number().nonnegative().default(2),
      cachedInputUsdPerMTok: z.number().nonnegative().default(0.1),
      cacheWrite30mUsdPerMTok: z.number().nonnegative().default(2.5),
      cacheWrite12hUsdPerMTok: z.number().nonnegative().default(5),
      outputUsdPerMTok: z.number().nonnegative().default(10),
      longContextThresholdTokens: z.number().int().positive().default(272_000),
      longContextInputMultiplier: z.number().min(1).default(2),
      longContextOutputMultiplier: z.number().min(1).default(1.5),
    }).prefault({}),
    maxOutputTokens: z.number().int().positive().default(16_000),
    /** Cap on supplied docs + diff (characters); larger diffs go to a human instead of being truncated. */
    maxInputChars: z.number().int().positive().default(600_000), // bytes of the full request
    timeoutSeconds: z.number().positive().default(900),
    /**
     * Triage before asking a human (needs autoMerge on the project and this reviewer). Code limits what it may do:
     * clear keyword-only policy flags for the exact diff, answer factual questions with sandboxed checks, and sequence
     * fixes for defects using tickets suggested from the blocked ticket. Everything else goes to a human.
     */
    triage: z.object({
      enabled: z.boolean().default(true),
      /** Triage resolutions per job before every further blocker goes to a human. */
      maxPerJob: z.number().int().min(0).default(3),
      /** Checks per factual question, and the time limit for each. */
      maxChecks: z.number().int().min(1).max(10).default(6),
      checkTimeoutSeconds: z.number().int().positive().default(600),
      /** More keyword matches than this in one diff are not treated as incidental mentions. */
      maxKeywordMatches: z.number().int().positive().default(40),
      /** Diff characters sent as context for a blocker (truncated beyond; triage never approves code). */
      maxDiffChars: z.number().int().positive().default(200_000),
    }).prefault({}),
  }).prefault({}),
  policy: z.object({
    minAutoConfidence: z.number().default(0.7),
    /** Extra regexes (case-insensitive) that force human approval. */
    humanKeywords: z.array(z.string()).default([]),
  }).prefault({}),
  sandbox: z.object({
    enabled: z.boolean().default(true),
    failIfUnavailable: z.boolean().default(false),
    allowedDomains: z.array(z.string()).default([
      'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
      'github.com', 'codeload.github.com', 'objects.githubusercontent.com',
    ]),
  }).prefault({}),
  /** Optional path to anthropics/claude-code plugins/feature-dev (subagents only; its /feature-dev command is interactive). */
  featureDevPluginPath: z.string().optional(),
  dashboard: z.object({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().default(7777),
  }).prefault({}),
  report: z.object({
    /** Local hour (0–23) to generate the morning summary; -1 disables. */
    hour: z.number().default(7),
    timezone: z.string().default('America/New_York'),
    /** Optional Slack-compatible or ntfy webhook URL (set via AUTODEV_REPORT_WEBHOOK env). */
  }).prefault({}),
  /** Local CI command for the local SCM backend (simulation). */
  localCi: z.string().optional(),
});

export type Config = Omit<z.infer<typeof ConfigSchema>, 'workspaceDir'> & { configDir: string; workspaceDir: string };
export type ProjectConfig = z.infer<typeof ProjectSchema>;

export function loadConfig(path: string): Config {
  const abs = resolve(path);
  const raw = parse(readFileSync(abs, 'utf8'));
  return parseConfig(raw, dirname(abs));
}

export function parseConfig(raw: unknown, configDir: string): Config {
  const cfg = ConfigSchema.parse(raw);
  const dataDir = isAbsolute(cfg.dataDir) ? cfg.dataDir : resolve(configDir, cfg.dataDir);
  const workspaceDir = cfg.workspaceDir
    ? (isAbsolute(cfg.workspaceDir) ? cfg.workspaceDir : resolve(configDir, cfg.workspaceDir))
    : join(dirname(resolve(configDir)), `${basename(resolve(configDir))}-work`);
  const keys = new Set<string>();
  for (const p of cfg.projects) {
    if (keys.has(p.key)) throw new Error(`duplicate project key ${p.key}`);
    keys.add(p.key);
  }
  return { ...cfg, dataDir, configDir, workspaceDir };
}

export function projectFor(cfg: Config, key: string): ProjectConfig {
  const p = cfg.projects.find((x) => x.key === key);
  if (!p) throw new Error(`unknown project ${key}`);
  return p;
}

/** Secrets come only from the environment, never from the config file. */
export function secret(name: string, required = true): string | undefined {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing required env var ${name}`);
  return v;
}
