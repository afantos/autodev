import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { SETTLED_OUTCOME, kvGet, kvSet, logEvent, now, ownerDead, recordUsage, spentOnTicket, spentSince, tx } from './db.ts';
import type { AgentRole } from './types.ts';

export function startOfDay(t = new Date()): number {
  const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime();
}
export function startOfMonth(t = new Date()): number {
  const d = new Date(t); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime();
}

export interface Gate {
  ok: boolean;
  reason?: string;
  /** Max USD the next run may spend. */
  allowanceUsd: number;
  /** The per-ticket limit (not a global one) refused the run. */
  ticketScoped?: boolean;
}

/**
 * Global gate for starting any agent run: manual pause, usage-limit pause, daily/monthly budgets.
 * Never bypasses a limit — it only decides whether to wait.
 */
/** The ticket's spending limit: an owner-approved override for its identifier, else perTicketUsd. */
export function perTicketLimit(db: Db, cfg: Config, ticketId: string): number {
  const row = db.prepare('SELECT ticket_identifier AS id FROM jobs WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 1').get(ticketId) as { id: string } | undefined;
  return (row && cfg.budget.perTicketOverrides[row.id]) ?? cfg.budget.perTicketUsd;
}

export function canStartRun(db: Db, cfg: Config, ticketId?: string | null): Gate {
  if (kvGet(db, 'manual_pause')) return { ok: false, reason: `paused manually: ${kvGet(db, 'manual_pause')}`, allowanceUsd: 0 };
  const until = Number(kvGet(db, 'paused_until') ?? 0);
  if (until > now()) return { ok: false, reason: `usage limit pause until ${new Date(until).toISOString()}`, allowanceUsd: 0 };
  const reserved = (db.prepare('SELECT COALESCE(SUM(amount_usd),0) s FROM budget_reservations').get() as { s: number }).s;
  const daySpent = spentSince(db, startOfDay());
  const monthSpent = spentSince(db, startOfMonth());
  const day = daySpent + reserved;
  const month = monthSpent + reserved;
  if (monthSpent >= cfg.budget.monthlyUsd) return exhausted(db, cfg, `monthly budget $${cfg.budget.monthlyUsd} reached ($${monthSpent.toFixed(2)})`);
  if (daySpent >= cfg.budget.dailyUsd) return exhausted(db, cfg, `daily budget $${cfg.budget.dailyUsd} reached ($${daySpent.toFixed(2)})`);
  if (month >= cfg.budget.monthlyUsd || day >= cfg.budget.dailyUsd) return { ok: false, reason: 'remaining daily/monthly budget is reserved by active or unsettled runs', allowanceUsd: 0 };
  let allowance = Math.min(cfg.budget.perRunUsd, cfg.budget.dailyUsd - day, cfg.budget.monthlyUsd - month);
  if (ticketId) {
    const limit = perTicketLimit(db, cfg, ticketId);
    const t = spentOnTicket(db, ticketId) + (db.prepare('SELECT COALESCE(SUM(amount_usd),0) s FROM budget_reservations WHERE ticket_id = ?').get(ticketId) as { s: number }).s;
    // Ticket-scoped: unlike daily/monthly limits this never clears by waiting, so callers block instead of requeueing.
    if (t >= limit) return { ok: false, reason: `ticket budget $${limit} reached ($${t.toFixed(2)})`, allowanceUsd: 0, ticketScoped: true };
    allowance = Math.min(allowance, limit - t);
    if (allowance <= 0 && limit - t <= 0) return { ok: false, reason: `ticket budget $${limit} reached ($${t.toFixed(2)})`, allowanceUsd: 0, ticketScoped: true };
  }
  return { ok: allowance > 0, allowanceUsd: Math.max(0, allowance), reason: allowance > 0 ? undefined : 'no budget remaining' };
}

export function reserveBudget(db: Db, cfg: Config, owner: string, meta: { ticketId?: string | null; jobId?: string | null }, requested: number, run: { role?: AgentRole; model?: string } = {}): Gate & { reservationId?: string } {
  return tx(db, () => {
    const gate = canStartRun(db, cfg, meta.ticketId);
    if (!gate.ok) return gate;
    const amount = Math.min(requested, gate.allowanceUsd);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid run budget', allowanceUsd: 0 };
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO budget_reservations (id, owner, ticket_id, job_id, amount_usd, created_at, role, model) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, owner, meta.ticketId ?? null, meta.jobId ?? null, amount, now(), run.role ?? null, run.model ?? null);
    return { ok: true, allowanceUsd: amount, reservationId: id };
  });
}

// ---------------- settling reservations whose spend is unknown

interface ReservationRow { id: string; owner: string; ticket_id: string | null; job_id: string | null; amount_usd: number; created_at: number; role: string | null; model: string | null }
export interface Settlement { reservationId: string; owner: string; jobId: string | null; ticketId: string | null; reservedUsd: number; recordedUsd: number; chargedUsd: number }

/**
 * Settle one reservation whose run ended without a trustworthy usage total (runner threw, aborted, incomplete usage) or
 * whose owner process died: charge the reservation minus the usage already recorded for that run, never below 0, as a
 * usage row with outcome SETTLED_OUTCOME, and delete the reservation. The run's cap (maxBudgetUsd) is the reservation, so
 * this is the most it could have spent. Must run inside a transaction: the row and the deletion commit together.
 * Idempotent by reservation id: a reservation already settled (or gone) returns null and charges nothing.
 */
export function settleReservationIn(db: Db, id: string): Settlement | null {
  const r = db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(id) as ReservationRow | undefined;
  if (!r) return null;
  if (db.prepare('SELECT 1 FROM usage WHERE reservation_id = ? AND outcome = ?').get(id, SETTLED_OUTCOME)) {
    db.prepare('DELETE FROM budget_reservations WHERE id = ?').run(id);
    return null;
  }
  let recorded = (db.prepare('SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) s FROM usage WHERE reservation_id = ?').get(id) as { n: number; s: number });
  if (!recorded.n && (r.job_id || r.ticket_id)) {
    // Reservations made before usage rows carried reservation_id: the partial usage row of the same run is the earliest
    // unlinked 'usage_unknown' row of its job (or ticket) since the reservation. Link it so no other reservation counts it.
    const legacy = db.prepare(`SELECT id, cost_usd FROM usage WHERE reservation_id IS NULL AND outcome = 'usage_unknown' AND ts >= ?
      AND ${r.job_id ? 'job_id = ?' : 'job_id IS NULL AND ticket_id = ?'} ORDER BY ts, id LIMIT 1`).get(r.created_at, r.job_id ?? r.ticket_id) as { id: number; cost_usd: number } | undefined;
    if (legacy) {
      db.prepare('UPDATE usage SET reservation_id = ? WHERE id = ?').run(id, legacy.id);
      recorded = { n: 1, s: legacy.cost_usd };
    }
  }
  const charged = Math.max(0, r.amount_usd - recorded.s);
  recordUsage(db, {
    jobId: r.job_id, ticketId: r.ticket_id, role: (r.role as AgentRole | null) ?? 'unknown', model: r.model, costUsd: charged,
    outcome: SETTLED_OUTCOME, reservationId: id,
  });
  db.prepare('DELETE FROM budget_reservations WHERE id = ?').run(id);
  return { reservationId: id, owner: r.owner, jobId: r.job_id, ticketId: r.ticket_id, reservedUsd: r.amount_usd, recordedUsd: recorded.s, chargedUsd: charged };
}

export function logSettlement(db: Db, s: Settlement, why: string) {
  logEvent(db, 'budget.settled', `Reservation ${s.reservationId} ($${s.reservedUsd.toFixed(2)}, owner ${s.owner}) settled: ${why}; charged $${s.chargedUsd.toFixed(3)} as ${SETTLED_OUTCOME} ($${s.recordedUsd.toFixed(3)} already recorded)`,
    { jobId: s.jobId, ticketId: s.ticketId, level: 'warn', data: s });
}

/** Settle one reservation in its own transaction and log it. */
export function settleReservation(db: Db, id: string, why: string): Settlement | null {
  const s = tx(db, () => settleReservationIn(db, id));
  if (s) logSettlement(db, s, why);
  return s;
}

/**
 * Startup recovery: settle every reservation whose owner process is dead (a crash or restart mid-run). Reservations of
 * this process, of live processes (e.g. a CLI planning run) and of other hosts are kept. Safe to repeat.
 */
export function settleDeadOwnerReservations(db: Db, self: string, isDead: (owner: string) => boolean = (o) => ownerDead(o, self)): Settlement[] {
  const rows = db.prepare('SELECT id, owner FROM budget_reservations ORDER BY created_at, id').all() as { id: string; owner: string }[];
  const out: Settlement[] = [];
  for (const r of rows) {
    if (!isDead(r.owner)) continue;
    const s = settleReservation(db, r.id, `owner process ${r.owner} is gone`);
    if (s) out.push(s);
  }
  return out;
}

function exhausted(db: Db, cfg: Config, reason: string): Gate {
  if (cfg.budget.onExhausted === 'manual' && !kvGet(db, 'manual_pause')) {
    kvSet(db, 'manual_pause', reason);
    logEvent(db, 'budget.exhausted', `${reason}; paused until 'autodev resume'`, { level: 'warn' });
  } else if (kvGet(db, 'budget_notice') !== `${startOfDay()}:${reason}`) {
    kvSet(db, 'budget_notice', `${startOfDay()}:${reason}`);
    logEvent(db, 'budget.exhausted', `${reason}; not starting new agent runs until the next period`, { level: 'warn' });
  }
  return { ok: false, reason, allowanceUsd: 0 };
}

/** Called when Claude reports a usage/rate limit. Uses the reported reset time or exponential backoff. */
export function pauseForUsageLimit(db: Db, resetsAt?: number) {
  const prevStreak = Number(kvGet(db, 'rate_limit_streak') ?? 0);
  const backoff = Math.min(15 * 60_000 * 2 ** prevStreak, 4 * 3600_000);
  const until = resetsAt && resetsAt > now() ? resetsAt + 60_000 : now() + backoff;
  kvSet(db, 'rate_limit_streak', String(prevStreak + 1));
  kvSet(db, 'paused_until', String(until));
  logEvent(db, 'usage.limited', `Claude usage limit hit; pausing new runs until ${new Date(until).toISOString()}`, { level: 'warn' });
}

export function clearUsageLimitStreak(db: Db) {
  if (kvGet(db, 'rate_limit_streak')) kvSet(db, 'rate_limit_streak', null);
}

/** API outages: short global pause with backoff so we don't hammer a failing service. */
export function pauseForApiError(db: Db) {
  const streak = Number(kvGet(db, 'api_error_streak') ?? 0);
  const until = now() + Math.min(60_000 * 2 ** streak, 30 * 60_000);
  kvSet(db, 'api_error_streak', String(streak + 1));
  kvSet(db, 'paused_until', String(until));
  logEvent(db, 'api.error', `API errors; backing off until ${new Date(until).toISOString()}`, { level: 'warn' });
}
export function clearApiErrorStreak(db: Db) {
  if (kvGet(db, 'api_error_streak')) kvSet(db, 'api_error_streak', null);
}
