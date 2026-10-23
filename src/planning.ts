import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Ctx } from './context.ts';
import { runAgent } from './context.ts';
import { logEvent, now } from './db.ts';
import { PLANNING_SYSTEM, docsHint, untrusted } from './agents/prompts.ts';
import { PlanSchema, jsonSchema } from './agents/schemas.ts';
import type { Plan, PlanTicket } from './agents/schemas.ts';
import { recentDecisions } from './decisions.ts';
import type { Priority, Ticket } from './types.ts';
import { LABEL_MANAGED, LABEL_PLAN } from './tracker/types.ts';

export interface PlanRow { id: string; project: string; idea: string; status: string; plan_json: string | null; parent_ticket_id: string | null; ticket_map_json: string | null; cost_usd: number; created_at: number; updated_at: number }

export function getPlan(ctx: Ctx, id: string): PlanRow | undefined {
  return ctx.db.prepare('SELECT * FROM plans WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as unknown as PlanRow | undefined;
}

/** Empty scratch directory for repo-less agent calls; never inside the protected config/state trees. */
function classifyDir(ctx: Ctx): string {
  const dir = join(ctx.cfg.workspaceDir, 'scratch');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Route an idea to a project: explicit key, single project, or a cheap classification call. */
async function pickProject(ctx: Ctx, idea: string, projectKey?: string): Promise<string> {
  if (projectKey) return projectKey;
  if (ctx.cfg.projects.length === 1) return ctx.cfg.projects[0].key;
  const list = ctx.cfg.projects.map((p) => `- ${p.key}: ${p.repo}`).join('\n');
  const res = await runAgent(ctx, {
    role: 'classify', model: ctx.cfg.models.classify, mode: 'readonly', cwd: classifyDir(ctx), maxTurns: 2, timeoutMs: 120_000,
    systemAppend: 'Classify which project an idea belongs to. Answer only with the structured output.',
    prompt: `Projects:\n${list}\n\nIdea:\n${untrusted('user-idea', idea)}\n\nWhich project key? Use "unknown" if unclear.`,
    outputSchema: jsonSchema(z.object({ projectKey: z.string(), confidence: z.number() })), maxBudgetUsd: 0.1,
    sandbox: ctx.cfg.sandbox,
  }, {});
  const out = res.structured as { projectKey?: string; confidence?: number } | null;
  if (!out?.projectKey || !ctx.cfg.projects.some((p) => p.key === out.projectKey) || (out.confidence ?? 0) < 0.6) {
    throw new Error(`could not determine the project for this idea; pass --project (one of ${ctx.cfg.projects.map((p) => p.key).join(', ')})`);
  }
  return out.projectKey;
}

function existingTicketsSummary(tickets: Ticket[]): string {
  return tickets.filter((t) => t.status !== 'canceled').slice(0, 150)
    .map((t) => `- ${t.identifier} [${t.status}] ${t.title} — ${t.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n') || '(no existing tickets)';
}

/** Research the repo and produce a draft plan. Nothing is written to the tracker yet. */
export async function draftPlan(ctx: Ctx, idea: string, projectKey?: string): Promise<{ id: string; plan: Plan; markdown: string; path: string }> {
  const key = await pickProject(ctx, idea, projectKey);
  const project = ctx.cfg.projects.find((p) => p.key === key)!;
  const id = randomUUID();
  ctx.db.prepare(`INSERT INTO plans (id, project, idea, status, created_at, updated_at) VALUES (?,?,?,'drafting',?,?)`).run(id, key, idea, now(), now());

  await ctx.ws.ensureClone(project.repo);
  const base = project.baseBranch ?? (await ctx.scm.defaultBranch(project.repo));
  const wt = await ctx.ws.addDetachedWorktree(project.repo, `_plan-${id.slice(0, 8)}`, `origin/${base}`);
  try {
    const existing = await ctx.tracker.listTickets({ projectKey: key });
    const decisions = recentDecisions(ctx, project.repo).map((d) => `- Q: ${d.question} → ${d.decision}`).join('\n') || '(none)';
    const prompt = `${docsHint(project)}
Project key: ${key} (repo ${project.repo}, integration branch ${base}).

Idea to plan:
${untrusted('user-idea', idea)}

Existing tickets in this project (check for duplicates, overlap, shared dependencies, already-done work):
${untrusted('linear', existingTicketsSummary(existing))}

Prior technical decisions in this repo:
${decisions}

Research the codebase thoroughly, then return the structured plan. Reference real files.`;
    const res = await runAgent(ctx, {
      role: 'planning', prompt, systemAppend: PLANNING_SYSTEM, cwd: wt, model: ctx.cfg.models.planning, mode: 'readonly',
      repository: project.repo,
      webResearch: true, outputSchema: jsonSchema(PlanSchema), maxTurns: 120, timeoutMs: 45 * 60_000, sandbox: ctx.cfg.sandbox,
      maxBudgetUsd: ctx.cfg.budget.perRunUsd,
    }, {});
    const parsed = PlanSchema.safeParse(res.structured);
    ctx.db.prepare('UPDATE plans SET cost_usd = ? WHERE id = ?').run(res.costUsd, id);
    if (!res.ok || !parsed.success) {
      ctx.db.prepare(`UPDATE plans SET status = 'failed', updated_at = ? WHERE id = ?`).run(now(), id);
      throw new Error(`planning failed: ${res.error ?? parsed.error?.message}`);
    }
    const plan = { ...parsed.data, projectKey: key };
    validatePlanGraph(plan);
    const markdown = renderPlan(id, idea, plan, project.repo);
    ctx.db.prepare(`UPDATE plans SET status = 'draft', plan_json = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(plan), now(), id);
    const dir = join(ctx.cfg.dataDir, 'plans');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id.slice(0, 8)}.md`);
    writeFileSync(path, markdown);
    logEvent(ctx.db, 'plan.drafted', `${plan.tickets.length} tickets for "${idea.slice(0, 80)}" (${key})`);
    return { id, plan, markdown, path };
  } finally {
    await ctx.ws.removeWorktreeForce(project.repo, wt).catch(() => {});
  }
}

/** Reject cycles and dangling dependency keys. */
export function validatePlanGraph(plan: Plan) {
  const keys = new Set(plan.tickets.map((t) => t.key));
  for (const t of plan.tickets) for (const d of t.dependsOn) if (!keys.has(d)) throw new Error(`ticket ${t.key} depends on unknown ${d}`);
  const visiting = new Set<string>(); const done = new Set<string>();
  const byKey = new Map(plan.tickets.map((t) => [t.key, t]));
  const visit = (k: string) => {
    if (done.has(k)) return;
    if (visiting.has(k)) throw new Error(`dependency cycle at ${k}`);
    visiting.add(k);
    for (const d of byKey.get(k)!.dependsOn) visit(d);
    visiting.delete(k); done.add(k);
  };
  plan.tickets.forEach((t) => visit(t.key));
}

export function ticketDescription(t: PlanTicket, plan: Plan, repo: string, planId: string, keyToIdentifier: Map<string, string>): string {
  const deps = t.dependsOn.map((k) => keyToIdentifier.get(k) ?? k);
  return `## Objective
${t.objective}

## Problem
${t.problem}

## Technical context
${t.technicalContext}

## Acceptance criteria
${t.acceptanceCriteria.map((a) => `- [ ] ${a}`).join('\n')}

## Testing requirements
${t.testing.map((a) => `- ${a}`).join('\n')}

## Dependencies
${deps.length ? deps.map((d) => `- ${d}`).join('\n') : '- none'}

## Relevant files
${t.relevantFiles.length ? t.relevantFiles.map((f) => `- \`${f}\``).join('\n') : '- (to be discovered)'}

## Security & architecture
${t.security}

## Definition of done
${t.definitionOfDone.map((a) => `- [ ] ${a}`).join('\n')}

---
Project: ${plan.projectKey} · Repo: ${repo} · Complexity: ${t.complexity}/5 · Parallelizable: ${t.parallelizable ? 'yes' : 'no'} · Plan: ${planId.slice(0, 8)}`;
}

export function renderPlan(id: string, idea: string, plan: Plan, repo: string): string {
  const order = topoOrder(plan);
  return `# Plan ${id.slice(0, 8)}: ${idea.split('\n')[0].slice(0, 100)}

**Project:** ${plan.projectKey} (${repo})

## Summary
${plan.summary}

## Approach
${plan.approach}

## Reuse
${plan.reuse.map((r) => `- ${r}`).join('\n') || '- none identified'}

## Requirements
${plan.requirements.map((r) => `- ${r}`).join('\n')}

## Risks
${plan.risks.map((r) => `- ${r}`).join('\n') || '- none identified'}

## Open questions (need your input — approving the plan accepts the recommendations unless you comment otherwise)
${plan.openQuestions.map((q) => `- ${q.blocking ? '**[blocking]** ' : ''}${q.question}\n  - options: ${q.options.join(' / ')}\n  - recommendation: ${q.recommendation}`).join('\n') || '- none'}

## Duplicates / overlap with existing work
${plan.duplicates.map((d) => `- ${d.existingIdentifier} (${d.relation}): ${d.note}`).join('\n') || '- none found'}

## Tickets (execution order; ⇉ = can run in parallel)
| Key | Title | Pri | Cx | Depends on |
|---|---|---|---|---|
${order.map((t) => `| ${t.key}${t.parallelizable ? ' ⇉' : ''} | ${t.title} | ${t.priority} | ${t.complexity} | ${t.dependsOn.join(', ') || '—'} |`).join('\n')}

${order.map((t) => `### ${t.key}: ${t.title}\n${t.objective}\n\nAcceptance criteria:\n${t.acceptanceCriteria.map((a) => `- ${a}`).join('\n')}`).join('\n\n')}

---
Approve: move the [Plan] issue to **Ready** in Linear, or run \`autodev plan-approve ${id.slice(0, 8)}\`. Answer open questions as comments on the [Plan] issue first — agents read them. Edit or delete individual tickets in Linear first if needed.
`;
}

function topoOrder(plan: Plan): PlanTicket[] {
  const out: PlanTicket[] = []; const seen = new Set<string>();
  const byKey = new Map(plan.tickets.map((t) => [t.key, t]));
  const visit = (t: PlanTicket) => { if (seen.has(t.key)) return; seen.add(t.key); t.dependsOn.forEach((d) => visit(byKey.get(d)!)); out.push(t); };
  plan.tickets.forEach(visit);
  return out;
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
export function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Write a draft plan to the tracker: a [Plan] umbrella issue plus child tickets in Backlog with dependencies.
 * Idempotent: a retry skips tickets already created (ticket_map_json).
 */
export async function publishPlan(ctx: Ctx, planId: string): Promise<{ parent: Ticket; created: Ticket[]; skipped: string[] }> {
  const row = getPlan(ctx, planId);
  if (!row?.plan_json) throw new Error(`plan ${planId} not found or not drafted`);
  if (row.status === 'approved') throw new Error('plan already approved');
  const plan = JSON.parse(row.plan_json) as Plan;
  const project = ctx.cfg.projects.find((p) => p.key === row.project)!;
  const map = new Map<string, string>(Object.entries(JSON.parse(row.ticket_map_json ?? '{}')));
  const save = () => ctx.db.prepare('UPDATE plans SET ticket_map_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(Object.fromEntries(map)), now(), row.id);

  let parent: Ticket | null = row.parent_ticket_id ? await ctx.tracker.getTicket(row.parent_ticket_id) : null;
  if (!parent) {
    parent = await ctx.tracker.createTicket({
      projectKey: row.project, title: `[Plan] ${row.idea.split('\n')[0].slice(0, 90)}`, status: 'backlog', priority: 0,
      description: renderPlan(row.id, row.idea, plan, project.repo), labels: [LABEL_PLAN],
    });
    ctx.db.prepare('UPDATE plans SET parent_ticket_id = ? WHERE id = ?').run(parent.id, row.id);
  }

  const existing = (await ctx.tracker.listTickets({ projectKey: row.project })).filter((t) => !['canceled'].includes(t.status) && t.parentId !== parent!.id);
  const created: Ticket[] = []; const skipped: string[] = [];
  const keyToIdentifier = new Map<string, string>();
  for (const t of topoOrder(plan)) {
    if (map.has(t.key)) { const tk = await ctx.tracker.getTicket(map.get(t.key)!); if (tk) keyToIdentifier.set(t.key, tk.identifier); continue; }
    const dup = existing.find((e) => similarity(e.title, t.title) >= 0.75);
    if (dup) {
      skipped.push(`${t.key} "${t.title}" ≈ existing ${dup.identifier} "${dup.title}"`);
      map.set(t.key, dup.id); keyToIdentifier.set(t.key, dup.identifier); save();
      continue;
    }
    const tk = await ctx.tracker.createTicket({
      projectKey: row.project, title: t.title, status: 'backlog', priority: t.priority as Priority, estimate: t.complexity,
      description: ticketDescription(t, plan, project.repo, row.id, keyToIdentifier), labels: [LABEL_MANAGED], parentId: parent.id,
    });
    map.set(t.key, tk.id); keyToIdentifier.set(t.key, tk.identifier); save();
    created.push(tk);
  }
  for (const t of plan.tickets) {
    const id = map.get(t.key);
    if (!id) continue;
    const current = await ctx.tracker.getTicket(id);
    // Repair links on retries, but never change an external deduplicated ticket.
    if (!current || current.parentId !== parent.id) continue;
    for (const d of t.dependsOn) {
      const dep = map.get(d);
      if (dep && !current.blockedBy.includes(dep)) await ctx.tracker.addBlockedBy(id, dep);
    }
  }
  ctx.db.prepare(`UPDATE plans SET status = 'published', updated_at = ? WHERE id = ?`).run(now(), row.id);
  logEvent(ctx.db, 'plan.published', `plan ${row.id.slice(0, 8)}: ${created.length} tickets created, ${skipped.length} deduplicated`, { ticketId: parent.id });
  return { parent, created, skipped };
}

/**
 * Human approval: move the plan's Backlog tickets to Ready. Only invoked by a human (CLI) or when a human
 * moved the [Plan] issue to Ready.
 */
export async function approvePlan(ctx: Ctx, planId: string, approver: string): Promise<string[]> {
  const row = getPlan(ctx, planId);
  if (!row) throw new Error(`plan ${planId} not found`);
  if (row.status === 'draft') await publishPlan(ctx, row.id);
  const fresh = getPlan(ctx, row.id)!;
  const ids = Object.values(JSON.parse(fresh.ticket_map_json ?? '{}')) as string[];
  const moved: string[] = [];
  for (const id of ids) {
    const t = await ctx.tracker.getTicket(id);
    if (t && ['backlog', 'ideas'].includes(t.status) && t.parentId === fresh.parent_ticket_id) {
      await ctx.tracker.setStatus(id, 'ready');
      moved.push(t.identifier);
    }
  }
  if (fresh.parent_ticket_id) {
    await ctx.tracker.setStatus(fresh.parent_ticket_id, 'in_progress');
    await ctx.tracker.comment(fresh.parent_ticket_id, `✅ Plan approved by ${approver}. Moved to Ready: ${moved.join(', ') || '(none)'}.`);
  }
  ctx.db.prepare(`UPDATE plans SET status = 'approved', updated_at = ? WHERE id = ?`).run(now(), fresh.id);
  logEvent(ctx.db, 'plan.approved', `plan ${fresh.id.slice(0, 8)} approved by ${approver}: ${moved.join(', ')}`);
  return moved;
}
