import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Job, JobStatus, Stage, AgentRole } from './types.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  ticket_identifier TEXT NOT NULL,
  project TEXT NOT NULL,
  repo TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  branch TEXT, base_branch TEXT, worktree TEXT,
  pr_number INTEGER, pr_url TEXT,
  session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  fix_attempts INTEGER NOT NULL DEFAULT 0,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  decision_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_expires_at INTEGER, heartbeat_at INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  pending_feedback TEXT, blocked_reason TEXT, error TEXT, summary_json TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- At most one active job per ticket: the DB itself forbids double claims.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_ticket ON jobs(ticket_id)
  WHERE status IN ('queued','running','waiting_ci','awaiting_merge','blocked');
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

-- Authoritative object stores and hashes are outside the agent-visible workspace.
CREATE TABLE IF NOT EXISTS git_states (
  worktree TEXT PRIMARY KEY, git_dir TEXT NOT NULL, base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT, ticket_identifier TEXT, repo TEXT NOT NULL,
  question TEXT NOT NULL, question_hash TEXT NOT NULL, context TEXT,
  category TEXT, alternatives_json TEXT, evidence_json TEXT,
  decision TEXT, reasoning TEXT, confidence REAL,
  authority TEXT NOT NULL,           -- auto | human | pending
  status TEXT NOT NULL,              -- resolved | pending_human | in_progress | failed | superseded
  attempt INTEGER NOT NULL DEFAULT 1,
  pr_number INTEGER, superseded_by TEXT, adr_path TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS decisions_hash ON decisions(repo, question_hash);
-- One in-flight decision per question.
CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_inflight ON decisions(repo, question_hash) WHERE status = 'in_progress';

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, idea TEXT NOT NULL,
  status TEXT NOT NULL,              -- draft | published | approved | rejected
  plan_json TEXT, parent_ticket_id TEXT, ticket_map_json TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, job_id TEXT, ticket_id TEXT, session_id TEXT, role TEXT NOT NULL, model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, outcome TEXT
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
-- Spend at other vendors (second reviewer). Never counted against Claude's budget, never mixed into usage.
CREATE TABLE IF NOT EXISTS external_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, job_id TEXT, ticket_id TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, outcome TEXT
);
CREATE INDEX IF NOT EXISTS external_usage_ts ON external_usage(provider, ts);

-- Durable reservations are never released without a charge: a lost result may still have incurred spend. A run that
-- ends without a usage total, or whose owner process died, is settled by charging the reservation (budget.ts).
CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, ticket_id TEXT, job_id TEXT,
  amount_usd REAL NOT NULL CHECK(amount_usd > 0), created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL,
  job_id TEXT, ticket_id TEXT, message TEXT NOT NULL, data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL);

-- Simulation backends (tracker=local, scm=local).
CREATE TABLE IF NOT EXISTS local_tickets (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL UNIQUE, project TEXT NOT NULL,
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0, estimate INTEGER, labels_json TEXT NOT NULL DEFAULT '[]',
  blocked_by_json TEXT NOT NULL DEFAULT '[]', parent_id TEXT,
  comments_json TEXT NOT NULL DEFAULT '[]', links_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS local_prs (
  number INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, head TEXT NOT NULL, base TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, draft INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;

export type Db = DatabaseSync;

/** Usage outcome of the conservative row that settles a reservation whose actual spend is unknown (see budget.ts). */
export const SETTLED_OUTCOME = 'usage_unknown_settled';

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const columns = new Set((db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(c => c.name));
  for (const name of ['base_sha', 'candidate_sha', 'validated_sha', 'reviewed_sha', 'candidate_worktree']) {
    if (!columns.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} TEXT`);
  }
  const usageColumns = db.prepare('PRAGMA table_info(usage)').all() as { name: string }[];
  if (!usageColumns.some(c => c.name === 'session_id')) db.exec('ALTER TABLE usage ADD COLUMN session_id TEXT');
  // Links a usage row to the budget reservation it settles; at most one conservative settlement row per reservation.
  if (!usageColumns.some(c => c.name === 'reservation_id')) db.exec('ALTER TABLE usage ADD COLUMN reservation_id TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS usage_one_settlement ON usage(reservation_id) WHERE outcome = '${SETTLED_OUTCOME}'`);
  const reservationColumns = new Set((db.prepare('PRAGMA table_info(budget_reservations)').all() as { name: string }[]).map(c => c.name));
  for (const name of ['role', 'model']) if (!reservationColumns.has(name)) db.exec(`ALTER TABLE budget_reservations ADD COLUMN ${name} TEXT`);
  return db;
}

export const now = () => Date.now();

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------------- events / audit ----------------

export function logEvent(db: Db, type: string, message: string, opts: { level?: 'info' | 'warn' | 'error'; jobId?: string | null; ticketId?: string | null; data?: unknown } = {}) {
  const level = opts.level ?? 'info';
  db.prepare('INSERT INTO events (ts, level, type, job_id, ticket_id, message, data_json) VALUES (?,?,?,?,?,?,?)')
    .run(now(), level, type, opts.jobId ?? null, opts.ticketId ?? null, message, opts.data === undefined ? null : JSON.stringify(opts.data));
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${type}${opts.jobId ? ` job=${opts.jobId.slice(0, 8)}` : ''}: ${message}`;
  if (process.env.AUTODEV_QUIET !== '1') (level === 'error' ? console.error : console.log)(line);
}

// ---------------- kv ----------------

export function kvGet(db: Db, k: string): string | null {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v ?? null;
}
/** Every kv entry whose key starts with `prefix` (compared literally, no LIKE wildcards). */
export function kvList(db: Db, prefix: string): { k: string; v: string }[] {
  return db.prepare('SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k').all(prefix.length, prefix) as { k: string; v: string }[];
}
export function kvSet(db: Db, k: string, v: string | null) {
  if (v === null) db.prepare('DELETE FROM kv WHERE k = ?').run(k);
  else db.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at').run(k, v, now());
}

/**
 * Single-instance lock: one orchestrator per state file. A stale lock (no refresh within ttl) can be taken over.
 */
export function acquireInstanceLock(db: Db, owner: string, ttlMs: number, isDead: (owner: string) => boolean = () => false): boolean {
  return tx(db, () => {
    const cur = db.prepare("SELECT v, updated_at FROM kv WHERE k = 'instance_lock'").get() as { v: string; updated_at: number } | undefined;
    if (cur && cur.v !== owner && now() - cur.updated_at < ttlMs && !isDead(cur.v)) return false;
    kvSet(db, 'instance_lock', owner);
    return true;
  });
}

/**
 * An owner string "host:pid:startTs" whose process no longer exists on this host. Owners on other hosts are never
 * judged dead (their liveness can't be checked here). With `self` (this process's owner), an owner that names this
 * process's pid but a different start is an earlier process whose pid was reused, so it is dead too.
 */
export function ownerDead(owner: string, self?: string): boolean {
  if (self && owner === self) return false;
  const [host, pid] = owner.split(':');
  if (host !== hostname() || !pid || !/^\d+$/.test(pid)) return false;
  if (self && Number(pid) === process.pid) return true;
  return !pidAlive(Number(pid));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function releaseInstanceLock(db: Db, owner: string) {
  db.prepare("DELETE FROM kv WHERE k = 'instance_lock' AND v = ?").run(owner);
}

// ---------------- jobs & leases ----------------

export function getJob(db: Db, id: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job | undefined;
}

export function activeJobForTicket(db: Db, ticketId: string): Job | undefined {
  return db.prepare(`SELECT * FROM jobs WHERE ticket_id = ? AND status IN ('queued','running','waiting_ci','awaiting_merge','blocked')`).get(ticketId) as unknown as Job | undefined;
}

export function jobsByStatus(db: Db, ...statuses: JobStatus[]): Job[] {
  const q = `SELECT * FROM jobs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`;
  return db.prepare(q).all(...statuses) as unknown as Job[];
}

export function allJobs(db: Db, limit = 200): Job[] {
  return db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as Job[];
}

/**
 * Atomically create a job for a ticket. Returns null if the ticket already has an active job
 * (enforced by a unique partial index, so this is safe under races and restarts).
 */
export function claimTicket(db: Db, t: { ticketId: string; identifier: string; project: string; repo: string }, owner: string, leaseMs: number): Job | null {
  const id = randomUUID();
  const ts = now();
  try {
    db.prepare(`INSERT INTO jobs (id, ticket_id, ticket_identifier, project, repo, status, stage, lease_owner, lease_expires_at, heartbeat_at, created_at, updated_at)
      VALUES (?,?,?,?,?,'running','claimed',?,?,?,?,?)`)
      .run(id, t.ticketId, t.identifier, t.project, t.repo, owner, ts + leaseMs, ts, ts, ts);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return null;
    throw e;
  }
  return getJob(db, id)!;
}

/** Take the lease on a non-running job (queued/waiting_ci/etc). Fails if someone else holds an unexpired lease. */
export function acquireLease(db: Db, jobId: string, owner: string, leaseMs: number, fromStatuses: JobStatus[]): boolean {
  const ts = now();
  const r = db.prepare(`UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
     WHERE id = ? AND status IN (${fromStatuses.map(() => '?').join(',')})
       AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at < ?)`)
    .run(owner, ts + leaseMs, ts, ts, jobId, ...fromStatuses, owner, ts);
  return Number(r.changes) === 1;
}

/** Extend the lease; returns false if we lost ownership (the worker must stop). */
export function heartbeat(db: Db, jobId: string, owner: string, leaseMs: number): boolean {
  const ts = now();
  const r = db.prepare(`UPDATE jobs SET lease_expires_at = ?, heartbeat_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`)
    .run(ts + leaseMs, ts, jobId, owner);
  return Number(r.changes) === 1;
}

/** Release the lease into a new status. Only the owner can do this. */
export function releaseLease(db: Db, jobId: string, owner: string, status: JobStatus, patch: Partial<Job> = {}): boolean {
  const ok = updateJob(db, jobId, { ...patch, status, lease_owner: null, lease_expires_at: null }, owner);
  return ok;
}

/** Running jobs whose lease expired (crashed worker / restarted orchestrator). */
export function expiredLeases(db: Db): Job[] {
  return db.prepare(`SELECT * FROM jobs WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`).all(now()) as unknown as Job[];
}

const JOB_COLS = new Set(['status', 'stage', 'branch', 'base_branch', 'worktree', 'pr_number', 'pr_url', 'session_id', 'attempts', 'fix_attempts', 'review_cycles', 'decision_count', 'lease_owner', 'lease_expires_at', 'heartbeat_at', 'cost_usd', 'pending_feedback', 'blocked_reason', 'error', 'summary_json', 'base_sha', 'candidate_sha', 'validated_sha', 'reviewed_sha', 'candidate_worktree']);

/** Update job fields. If `owner` is given, the update only applies while that owner holds the lease. */
export function updateJob(db: Db, id: string, patch: Partial<Job>, owner?: string): boolean {
  const keys = Object.keys(patch).filter((k) => JOB_COLS.has(k));
  if (!keys.length) return true;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => (patch as Record<string, unknown>)[k] as never);
  const where = owner ? 'id = ? AND lease_owner = ?' : 'id = ?';
  const args = owner ? [id, owner] : [id];
  const r = db.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE ${where}`).run(...vals, now(), ...args);
  return Number(r.changes) === 1;
}

export function setStage(db: Db, id: string, stage: Stage, owner: string) {
  if (!updateJob(db, id, { stage }, owner)) throw new LeaseLostError(id);
}

export class LeaseLostError extends Error {
  constructor(jobId: string) { super(`lease lost for job ${jobId}`); }
}

// ---------------- usage ----------------

/** `role` is 'unknown' only for settling a reservation made before reservations recorded their role. */
export interface UsageRow { jobId?: string | null; ticketId?: string | null; sessionId?: string | null; role: AgentRole | 'unknown'; model?: string | null; costUsd: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; durationMs?: number; outcome?: string; reservationId?: string | null }

export function recordUsage(db: Db, u: UsageRow) {
  db.prepare('INSERT INTO usage (ts, job_id, ticket_id, session_id, role, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, duration_ms, outcome, reservation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(now(), u.jobId ?? null, u.ticketId ?? null, u.sessionId ?? null, u.role, u.model ?? null, u.costUsd, u.inputTokens ?? 0, u.outputTokens ?? 0, u.cacheReadTokens ?? 0, u.durationMs ?? 0, u.outcome ?? null, u.reservationId ?? null);
  if (u.jobId) db.prepare('UPDATE jobs SET cost_usd = cost_usd + ? WHERE id = ?').run(u.costUsd, u.jobId);
}

export function spentSince(db: Db, sinceMs: number): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE ts >= ?').get(sinceMs) as { s: number };
  return r.s;
}

export function recordExternalUsage(db: Db, u: { provider: string; model: string; jobId?: string | null; ticketId?: string | null; costUsd: number; inputTokens?: number; outputTokens?: number; outcome?: string }): number {
  const r = db.prepare('INSERT INTO external_usage (ts, provider, model, job_id, ticket_id, cost_usd, input_tokens, output_tokens, outcome) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(now(), u.provider, u.model, u.jobId ?? null, u.ticketId ?? null, u.costUsd, u.inputTokens ?? 0, u.outputTokens ?? 0, u.outcome ?? null);
  return Number(r.lastInsertRowid);
}

/** Settle a pending (worst-case) row with the provider-reported usage. */
export function settleExternalUsage(db: Db, id: number, u: { model: string; costUsd: number; inputTokens: number; outputTokens: number; outcome: string }) {
  db.prepare('UPDATE external_usage SET model = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, outcome = ? WHERE id = ?')
    .run(u.model, u.costUsd, u.inputTokens, u.outputTokens, u.outcome, id);
}

export function externalSpentSince(db: Db, provider: string, sinceMs: number): number {
  return (db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM external_usage WHERE provider = ? AND ts >= ?').get(provider, sinceMs) as { s: number }).s;
}

export function spentOnTicket(db: Db, ticketId: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE ticket_id = ?').get(ticketId) as { s: number };
  return r.s;
}
