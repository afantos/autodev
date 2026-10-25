import type { AgentRunResult } from './agents/runner.ts';
import type { Db } from './db.ts';
import { kvGet, kvSet, logEvent } from './db.ts';

const fields = ['costUsd', 'inputTokens', 'outputTokens', 'cacheReadTokens'] as const;
type Totals = Pick<AgentRunResult, typeof fields[number]>;
const valid = (v: Totals) => fields.every(k => typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0 && (k === 'costUsd' || Number.isSafeInteger(v[k])));

/**
 * Convert SDK session totals to this call's usage. Must run in the SAME transaction as recordUsage and reservation
 * settlement: a crash must not advance the baseline without recording spend, or record spend without the baseline.
 * Session keys survive service restarts and are independent of job/model/role. Each fresh review has its own session.
 */
export function sessionUsageDelta(db: Db, result: AgentRunResult, resumed: boolean, meta: { jobId?: string | null; ticketId?: string | null } = {}): AgentRunResult {
  if (result.usageScope !== 'session' || result.usageComplete === false) return result;
  const unknown = (why: string): AgentRunResult => {
    logEvent(db, 'budget.session_usage_unknown', `Cannot settle session ${result.sessionId ?? '(missing)'}: ${why}; keeping the run reservation`, { ...meta, level: 'warn' });
    return { ...result, ok: false, usageComplete: false, errorKind: 'other', error: why, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  };
  if (!result.sessionId || !valid(result)) return unknown('missing session ID or invalid session usage');
  const key = `agent-session-usage:${result.sessionId}`;
  const saved = kvGet(db, key);
  const prior: Totals | null = saved ? JSON.parse(saved) : null;
  if (prior && !valid(prior)) return unknown('invalid saved session baseline');
  // /clear starts a new session ID. A regression for the SAME ID can instead be a zeroed crash/startup result;
  // never reset the baseline or release its reservation on that evidence.
  if (prior && fields.some(k => result[k] + (k === 'costUsd' ? 1e-9 : 0) < prior[k])) return unknown('session totals decreased');
  if (!prior && resumed) {
    // An upgrade can encounter sessions whose previous runs predate this ledger. Without a trustworthy baseline,
    // charge the full reported total once, conservatively; never infer session identities from old usage rows.
    logEvent(db, 'budget.session_baseline_missing', `No saved baseline for resumed session ${result.sessionId}; charging its full reported total once. Historical usage is unchanged.`, { ...meta, level: 'warn' });
  }
  const delta = { ...result, usageScope: 'run' as const };
  const totals = {} as Totals;
  for (const k of fields) {
    totals[k] = result[k];
    delta[k] = Math.max(0, result[k] - (prior?.[k] ?? 0));
  }
  kvSet(db, key, JSON.stringify(totals));
  return delta;
}
