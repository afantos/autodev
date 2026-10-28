import type { z } from 'zod';
import type { Ctx } from './context.ts';
import { externalSpentSince, kvGet, kvSet, logEvent, recordExternalUsage, settleExternalUsage, tx } from './db.ts';
import { startOfDay, startOfMonth } from './budget.ts';
import type { Job } from './types.ts';

// Shared budget and caching rules for every call to the second-review provider (merge review, test-integrity review,
// triage). Moved out of automerge.ts unchanged so triage can't diverge from them.

export type ReviewRun<T> = { value: T; model: string; costUsd: number | null; inputTokens: number; outputTokens: number; outcome: string; summary: string };

/** Reuse a cached verdict only if it validates against the current schema; otherwise drop it so the review runs again. */
export function cachedVerdict<T>(ctx: Ctx, job: Job, key: string, schema: z.ZodType<T>, event: string): T | null {
  const cached = kvGet(ctx.db, key);
  if (!cached) return null;
  let raw: unknown = null;
  try { raw = JSON.parse(cached); } catch { /* unreadable → invalid */ }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  kvSet(ctx.db, key, null);
  logEvent(ctx.db, `${event}.cache_invalidated`, `${job.ticket_identifier}: cached verdict for ${key.split(':').at(-1)!.slice(0, 12)} doesn't match the current schema; reviewing again`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
  return null;
}

/**
 * Run one second-reviewer call under the shared budget rules: reserve the worst case as a pending ledger row inside a
 * transaction (counts against the caps while it runs; stays charged if usage is unknown or the process dies), then
 * settle to the provider-reported cost. Used by both the code review and the test-integrity review.
 */
export async function reservedReview<T>(ctx: Ctx, job: Job, sha: string, event: string, failPrefix: string, worst: number, call: () => Promise<ReviewRun<T>>):
  Promise<{ kind: 'ok'; value: T } | { kind: 'waiting' } | { kind: 'failed'; failures: number; message: string }> {
  const { db, cfg } = ctx;
  const reviewer = ctx.secondReviewer!;
  const failKey = `${failPrefix}:${job.id}:${sha}`;
  // A terminal failure must remain terminal across polling ticks and restarts, before reserving or spending again.
  const previousFailures = Number(kvGet(db, failKey) ?? 0);
  if (previousFailures >= 3) return { kind: 'failed', failures: previousFailures, message: kvGet(db, `${failKey}:message`) ?? 'retry limit reached for this candidate' };
  const reservation = tx(db, () => {
    const day = externalSpentSince(db, reviewer.provider, startOfDay());
    const month = externalSpentSince(db, reviewer.provider, startOfMonth());
    if (day + worst > cfg.secondReview.dailyUsd || month + worst > cfg.secondReview.monthlyUsd) return { ok: false as const, day, month };
    return { ok: true as const, id: recordExternalUsage(db, { provider: reviewer.provider, model: reviewer.model, jobId: job.id, ticketId: job.ticket_id, costUsd: worst, outcome: 'pending' }) };
  });
  if (!reservation.ok) {
    const key = `second-review-budget:${startOfDay()}`;
    if (!kvGet(db, key)) {
      kvSet(db, key, '1');
      logEvent(db, 'second_review.budget', `second-review budget reached (today $${reservation.day.toFixed(2)}/$${cfg.secondReview.dailyUsd}, month $${reservation.month.toFixed(2)}/$${cfg.secondReview.monthlyUsd}, next review up to $${worst.toFixed(2)}); waiting`, { level: 'warn' });
    }
    return { kind: 'waiting' };
  }
  try {
    const out = await call();
    // Unknown usage keeps the worst-case reservation; known usage settles to the tier-priced cost.
    if (out.costUsd === null) settleExternalUsage(db, reservation.id, { model: out.model, costUsd: worst, inputTokens: 0, outputTokens: 0, outcome: `${out.outcome}-usage-unknown` });
    else settleExternalUsage(db, reservation.id, { model: out.model, costUsd: out.costUsd, inputTokens: out.inputTokens, outputTokens: out.outputTokens, outcome: out.outcome });
    logEvent(db, event, `${job.ticket_identifier}: ${out.outcome} (${out.model}, ${out.costUsd === null ? `usage unknown, charged $${worst.toFixed(3)}` : `$${out.costUsd.toFixed(3)}`}): ${out.summary.slice(0, 200)}`, { jobId: job.id, ticketId: job.ticket_id });
    return { kind: 'ok', value: out.value };
  } catch (e) {
    const err = e as Error & { costUsd?: number; inputTokens?: number; outputTokens?: number };
    // Known usage → settle to it. Unknown (network error, timeout, unreadable body) → keep the worst-case charge.
    if (typeof err.costUsd === 'number') settleExternalUsage(db, reservation.id, { model: reviewer.model, costUsd: err.costUsd, inputTokens: err.inputTokens ?? 0, outputTokens: err.outputTokens ?? 0, outcome: 'error' });
    else settleExternalUsage(db, reservation.id, { model: reviewer.model, costUsd: worst, inputTokens: 0, outputTokens: 0, outcome: 'error-usage-unknown' });
    const failures = Number(kvGet(db, failKey) ?? 0) + 1;
    kvSet(db, failKey, String(failures));
    kvSet(db, `${failKey}:message`, err.message.slice(0, 500));
    logEvent(db, `${event}.error`, `${job.ticket_identifier}: ${err.message.slice(0, 300)}`, { jobId: job.id, ticketId: job.ticket_id, level: 'warn' });
    return failures >= 3 ? { kind: 'failed', failures, message: err.message } : { kind: 'waiting' };
  }
}
