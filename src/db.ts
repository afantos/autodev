import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  ts INTEGER NOT NULL, job_id TEXT, ticket_id TEXT, role TEXT NOT NULL, model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0, outcome TEXT
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);

-- Durable reservations are never expired automatically: a lost result may still
-- have incurred charges. Reconcile unknown spend before releasing a reservation.
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

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
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

const JOB_COLS = new Set(['status', 'stage', 'branch', 'base_branch', 'worktree', 'pr_number', 'pr_url', 'session_id', 'attempts', 'fix_attempts', 'review_cycles', 'decision_count', 'lease_owner', 'lease_expires_at', 'heartbeat_at', 'cost_usd', 'pending_feedback', 'blocked_reason', 'error', 'summary_json']);

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

export interface UsageRow { jobId?: string | null; ticketId?: string | null; role: AgentRole; model?: string | null; costUsd: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; durationMs?: number; outcome?: string }

export function recordUsage(db: Db, u: UsageRow) {
  db.prepare('INSERT INTO usage (ts, job_id, ticket_id, role, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, duration_ms, outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(now(), u.jobId ?? null, u.ticketId ?? null, u.role, u.model ?? null, u.costUsd, u.inputTokens ?? 0, u.outputTokens ?? 0, u.cacheReadTokens ?? 0, u.durationMs ?? 0, u.outcome ?? null);
  if (u.jobId) db.prepare('UPDATE jobs SET cost_usd = cost_usd + ? WHERE id = ?').run(u.costUsd, u.jobId);
}

export function spentSince(db: Db, sinceMs: number): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE ts >= ?').get(sinceMs) as { s: number };
  return r.s;
}

export function spentOnTicket(db: Db, ticketId: string): number {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage WHERE ticket_id = ?').get(ticketId) as { s: number };
  return r.s;
}
