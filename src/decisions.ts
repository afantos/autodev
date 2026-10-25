import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { runAgent, RunGateClosed } from './context.ts';
import { logEvent, now, updateJob } from './db.ts';
import { DECISION_SYSTEM, docsHint, ticketBlock, untrusted } from './agents/prompts.ts';
import { DecisionSchema, jsonSchema } from './agents/schemas.ts';
import type { Decision } from './agents/schemas.ts';
import { authorize } from './policy.ts';
import type { Job, Ticket } from './types.ts';
import { slugify } from './exec.ts';

export interface DecisionRow {
  id: string; ticket_id: string | null; ticket_identifier: string | null; repo: string; question: string; question_hash: string;
  context: string | null; category: string | null; alternatives_json: string | null; evidence_json: string | null;
  decision: string | null; reasoning: string | null; confidence: number | null; authority: string; status: string;
  attempt: number; pr_number: number | null; superseded_by: string | null; adr_path: string | null; created_at: number; resolved_at: number | null;
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|a|an|should|we|i|to|for|of|in|on|or|and|is|be)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
export const questionHash = (q: string) => createHash('sha256').update(normalizeQuestion(q)).digest('hex').slice(0, 16);

export function recentDecisions(ctx: Ctx, repo: string, limit = 25): DecisionRow[] {
  return ctx.db.prepare(`SELECT * FROM decisions WHERE repo = ? AND status = 'resolved' AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ?`).all(repo, limit) as unknown as DecisionRow[];
}

export function getDecision(ctx: Ctx, id: string): DecisionRow | undefined {
  return ctx.db.prepare('SELECT * FROM decisions WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as unknown as DecisionRow | undefined;
}

export function decisionsForTicket(ctx: Ctx, ticketId: string): DecisionRow[] {
  return ctx.db.prepare('SELECT * FROM decisions WHERE ticket_id = ? ORDER BY created_at').all(ticketId) as unknown as DecisionRow[];
}

export type QuestionOutcome =
  | { kind: 'answered'; decisionId: string; text: string }
  | { kind: 'blocked'; decisionId: string | null; reason: string; question: string; options: string[]; recommendation: string | null };

/**
 * Full decision workflow for a coding agent's question. Never returns an "answered" outcome for something
 * the policy says needs a human.
 */
export async function resolveQuestion(ctx: Ctx, args: { job: Job; ticket: Ticket; project: ProjectConfig; worktree: string; question: string; context: string; options: string[]; signal?: AbortSignal }): Promise<QuestionOutcome> {
  const { job, ticket, project, question } = args;
  const hash = questionHash(question);
  const db = ctx.db;

  // 1. Prior decisions (same repo, same question) — reuse instead of asking again.
  const prior = db.prepare(`SELECT * FROM decisions WHERE repo = ? AND question_hash = ? AND superseded_by IS NULL ORDER BY created_at DESC`).all(job.repo, hash) as unknown as DecisionRow[];
  const resolved = prior.find((d) => d.status === 'resolved');
  if (resolved) {
    logEvent(db, 'decision.reused', `reused ${resolved.id.slice(0, 8)} for "${question.slice(0, 80)}"`, { jobId: job.id, ticketId: ticket.id });
    return { kind: 'answered', decisionId: resolved.id, text: `DECIDED (previously, ${resolved.authority} decision ${resolved.id.slice(0, 8)}): ${resolved.decision}\nReasoning: ${resolved.reasoning}` };
  }
  const pendingHuman = prior.find((d) => d.status === 'pending_human');
  if (pendingHuman) return { kind: 'blocked', decisionId: pendingHuman.id, reason: 'this question is already waiting for a human decision', question, options: JSON.parse(pendingHuman.alternatives_json ?? '[]').map((o: { name: string }) => o.name), recommendation: pendingHuman.decision };

  // 2. Limits.
  const lim = ctx.cfg.limits;
  if (job.decision_count >= lim.maxDecisionsPerTicket) return { kind: 'blocked', decisionId: null, reason: `decision limit (${lim.maxDecisionsPerTicket}) reached for this ticket`, question, options: args.options, recommendation: null };
  const failedAttempts = prior.filter((d) => d.status === 'failed').length;
  if (failedAttempts >= lim.maxAttemptsPerQuestion) return { kind: 'blocked', decisionId: null, reason: `question could not be resolved after ${failedAttempts} attempts`, question, options: args.options, recommendation: null };

  // 3. One in-flight decision per question (unique index).
  const id = randomUUID();
  try {
    db.prepare(`INSERT INTO decisions (id, ticket_id, ticket_identifier, repo, question, question_hash, context, authority, status, attempt, created_at) VALUES (?,?,?,?,?,?,?,'pending','in_progress',?,?)`)
      .run(id, ticket.id, ticket.identifier, job.repo, question, hash, args.context, failedAttempts + 1, now());
  } catch (e) {
    if (String(e).includes('UNIQUE')) return { kind: 'blocked', decisionId: null, reason: 'another agent is already researching this question; retry later', question, options: args.options, recommendation: null };
    throw e;
  }
  job.decision_count += 1;
  updateJob(db, job.id, { decision_count: job.decision_count });

  // 4. Research.
  const history = recentDecisions(ctx, job.repo).map((d) => `- [${d.id.slice(0, 8)}] (${d.authority}) Q: ${d.question}\n  A: ${d.decision}`).join('\n') || '(none)';
  const prompt = `${docsHint(project)}
A coding agent working on the ticket below asked a question. Research and decide.

${ticketBlock(ticket)}

Question from the coding agent:
${untrusted('coding-agent', `${question}\n\nContext: ${args.context}\n\nOptions it sees: ${args.options.join(' | ') || '(none given)'}`)}

Prior decisions in this repository (stay consistent; cite them as evidence where relevant):
${history}

Project-approved dependencies: ${project.approvedDependencies.join(', ') || '(none listed)'}.
Return the structured decision.`;
  let decision: Decision | null = null;
  let failure = '';
  try {
    const res = await runAgent(ctx, {
      role: 'decision', prompt, systemAppend: DECISION_SYSTEM, cwd: args.worktree, model: ctx.cfg.models.decision, mode: 'readonly',
      webResearch: true, outputSchema: jsonSchema(DecisionSchema), maxTurns: 40, maxBudgetUsd: ctx.cfg.budget.perDecisionUsd,
      timeoutMs: lim.decisionTimeoutMinutes * 60_000, sandbox: ctx.cfg.sandbox,
      signal: args.signal,
    }, { jobId: job.id, ticketId: ticket.id });
    const parsed = DecisionSchema.safeParse(res.structured);
    if (res.ok && parsed.success) decision = parsed.data;
    else failure = res.error ?? parsed.error?.message ?? 'invalid decision output';
  } catch (e) {
    failure = e instanceof RunGateClosed ? `run gate closed: ${e.why}` : String(e);
  }
  if (!decision) {
    db.prepare(`UPDATE decisions SET status = 'failed', reasoning = ?, resolved_at = ? WHERE id = ?`).run(failure.slice(0, 2000), now(), id);
    const exhausted = failedAttempts + 1 >= lim.maxAttemptsPerQuestion;
    logEvent(db, 'decision.failed', failure.slice(0, 300), { jobId: job.id, ticketId: ticket.id, level: 'warn' });
    return exhausted
      ? { kind: 'blocked', decisionId: id, reason: `decision research failed: ${failure.slice(0, 200)}`, question, options: args.options, recommendation: null }
      : { kind: 'answered', decisionId: id, text: `DECISION UNAVAILABLE (${failure.slice(0, 200)}). You may call request_decision once more, or call report_blocker.` };
  }

  // 5. Authorization — code, not the model, decides.
  const pol = authorize(decision, question, project, ctx.cfg, args.worktree);
  const status = pol.authority === 'auto' ? 'resolved' : 'pending_human';
  db.prepare(`UPDATE decisions SET category = ?, alternatives_json = ?, evidence_json = ?, decision = ?, reasoning = ?, confidence = ?, authority = ?, status = ?, resolved_at = ? WHERE id = ?`)
    .run(decision.category, JSON.stringify(decision.options), JSON.stringify(decision.evidence), decision.recommendation,
      decision.reasoning + (pol.reasons.length ? `\nEscalated: ${pol.reasons.join('; ')}` : ''), decision.confidence,
      pol.authority === 'auto' ? 'auto' : 'pending', status, pol.authority === 'auto' ? now() : null, id);
  logEvent(db, `decision.${pol.authority}`, `${decision.category}: ${question.slice(0, 100)} → ${decision.recommendation.slice(0, 100)}${pol.reasons.length ? ` [${pol.reasons.join('; ')}]` : ''}`, { jobId: job.id, ticketId: ticket.id });

  if (pol.authority === 'human') {
    return { kind: 'blocked', decisionId: id, reason: `needs human approval: ${pol.reasons.join('; ')}`, question, options: decision.options.map((o) => o.name), recommendation: decision.recommendation };
  }
  let adrNote = '';
  if (decision.significantArchitecture) {
    const p = writeAdr(args.worktree, project.adrDir, question, decision, id);
    db.prepare('UPDATE decisions SET adr_path = ? WHERE id = ?').run(p, id);
    adrNote = `\nAn ADR was written to ${p}; commit it with your changes.`;
  }
  return { kind: 'answered', decisionId: id, text: `DECIDED (auto, decision ${id.slice(0, 8)}): ${decision.recommendation}\nReasoning: ${decision.reasoning}${adrNote}` };
}

/** Record a human answer to a pending decision (from Linear comment or CLI). Supersedes nothing; it resolves the pending row. */
export function recordHumanDecision(ctx: Ctx, decisionId: string | null, answer: string, meta: { ticket?: Ticket; repo: string; question?: string }): string {
  if (decisionId && getDecision(ctx, decisionId)) {
    ctx.db.prepare(`UPDATE decisions SET decision = ?, reasoning = COALESCE(reasoning,'') || ?, authority = 'human', status = 'resolved', resolved_at = ? WHERE id = ?`)
      .run(answer, '\nHuman answer recorded.', now(), getDecision(ctx, decisionId)!.id);
    return getDecision(ctx, decisionId)!.id;
  }
  const id = randomUUID();
  const q = meta.question ?? `Blocker on ${meta.ticket?.identifier ?? 'ticket'}`;
  ctx.db.prepare(`INSERT INTO decisions (id, ticket_id, ticket_identifier, repo, question, question_hash, decision, reasoning, authority, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?, 'human','resolved',?,?)`)
    .run(id, meta.ticket?.id ?? null, meta.ticket?.identifier ?? null, meta.repo, q, questionHash(q), answer, 'Human answer', now(), now());
  return id;
}

/**
 * A blocker resolved by autodev triage (second-review model under code-enforced limits). Recorded with authority
 * 'triage', never 'human': anything that requires a human decision (e.g. option B's superseding requirement) ignores it.
 */
export function recordTriageDecision(ctx: Ctx, job: { ticket_id: string; ticket_identifier: string; repo: string }, question: string, answer: string, model: string): string {
  const id = randomUUID();
  ctx.db.prepare(`INSERT INTO decisions (id, ticket_id, ticket_identifier, repo, question, question_hash, decision, reasoning, authority, status, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?, 'triage','resolved',?,?)`)
    .run(id, job.ticket_id, job.ticket_identifier, job.repo, question, questionHash(question), answer, `Triage by ${model}`, now(), now());
  return id;
}

export function supersedeDecision(ctx: Ctx, oldId: string, newId: string) {
  ctx.db.prepare(`UPDATE decisions SET superseded_by = ?, status = 'superseded' WHERE id = ?`).run(newId, oldId);
}

function writeAdr(worktree: string, adrDir: string, question: string, d: Decision, id: string): string {
  const dir = join(worktree, adrDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const nums = readdirSync(dir).map((f) => Number(f.match(/^(\d{3,4})-/)?.[1] ?? 0));
  const n = String(Math.max(0, ...nums) + 1).padStart(4, '0');
  const rel = join(adrDir, `${n}-${slugify(question, 50)}.md`);
  writeFileSync(join(worktree, rel), `# ${n}. ${question}

- Status: Accepted (autonomous decision ${id.slice(0, 8)}, autodev)
- Date: ${new Date().toISOString().slice(0, 10)}

## Context
${d.reasoning}

## Options considered
${d.options.map((o) => `### ${o.name}\n- Pros: ${o.pros.join('; ') || '—'}\n- Cons: ${o.cons.join('; ') || '—'}`).join('\n\n')}

## Decision
${d.recommendation}

## Evidence
${d.evidence.map((e) => `- ${e}`).join('\n')}
`);
  return rel;
}
