// Shared domain types. Tracker/Scm/Runner implementations translate to and from these.

export const STATUSES = [
  'ideas', 'backlog', 'ready', 'in_progress', 'review', 'done', 'blocked', 'failed', 'canceled',
] as const;
export type Status = (typeof STATUSES)[number];

/** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface Ticket {
  id: string;
  identifier: string; // e.g. ENG-123
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  /** 1–5 complexity (Linear estimate), when set. */
  estimate: number | null;
  labels: string[];
  /** Project key from config this ticket belongs to (resolved by the tracker). */
  projectKey: string | null;
  /** IDs of tickets that block this one. */
  blockedBy: string[];
  /** IDs of tickets this one blocks. */
  blocks: string[];
  parentId: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTicket {
  projectKey: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  estimate?: number | null;
  labels?: string[];
  parentId?: string | null;
}

export interface TicketComment {
  id: string;
  body: string;
  /** True if written by the orchestrator's own identity. */
  byAutomation: boolean;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
}

export type CheckState = 'none' | 'pending' | 'success' | 'failure';

export interface CheckFailure {
  name: string;
  summary: string;
  detailsUrl?: string;
}

export interface CheckResult {
  state: CheckState;
  failures: CheckFailure[];
  /** Human-readable log excerpt for failing checks (bounded size). */
  logExcerpt: string;
}

export type JobStatus =
  | 'queued'        // claimed, waiting for an agent slot (or resuming after a pause)
  | 'running'       // a worker holds the lease and is executing stages
  | 'waiting_ci'    // pushed, waiting on CI; holds no agent slot
  | 'awaiting_merge'// in Review; waiting for a human to merge
  | 'blocked'       // waiting on a human decision
  | 'done' | 'failed' | 'canceled' | 'closed';

export const ACTIVE_JOB_STATUSES: JobStatus[] = ['queued', 'running', 'waiting_ci', 'awaiting_merge', 'blocked'];

export const STAGES = ['claimed', 'workspace', 'implement', 'validate', 'commit', 'push', 'pr', 'ci', 'review', 'handoff'] as const;
export type Stage = (typeof STAGES)[number];

export interface Job {
  id: string;
  ticket_id: string;
  ticket_identifier: string;
  project: string;
  repo: string;
  status: JobStatus;
  stage: Stage;
  branch: string | null;
  base_branch: string | null;
  worktree: string | null;
  pr_number: number | null;
  pr_url: string | null;
  session_id: string | null;
  attempts: number;
  fix_attempts: number;
  review_cycles: number;
  decision_count: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  cost_usd: number;
  /** Feedback queued for the next implement pass (validation logs, CI logs, review findings, human answer). */
  pending_feedback: string | null;
  blocked_reason: string | null;
  error: string | null;
  summary_json: string | null;
  created_at: number;
  updated_at: number;
}

export type AgentRole = 'planning' | 'coding' | 'decision' | 'review' | 'classify';
