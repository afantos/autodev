import type { Config } from './config.ts';
import type { Job, Ticket } from './types.ts';
import { LABEL_PLAN } from './tracker/types.ts';

export interface Candidate {
  ticket: Ticket;
  score: number;
  reasons: string[];
  /** When stacking on an unmerged dependency: the dependency's branch to base on. */
  baseBranchOverride?: string;
}

export interface Skipped { ticket: Ticket; reason: string }

export interface SchedulerInput {
  ready: Ticket[];
  /** All known tickets by id (for dependency resolution and unblock counting). */
  byId: Map<string, Ticket>;
  activeJobs: Job[];
  cfg: Config;
  /** Projects worked on recently (warm caches/context). */
  recentProjects?: Set<string>;
  /** Average historic cost per complexity point, if known. */
  costPerPoint?: number;
}

/** Files a ticket declares under a "Relevant files" heading (bulleted, optionally in backticks). */
export function relevantFiles(t: Ticket): string[] {
  const m = t.description.match(/#+\s*Relevant files[^\n]*\n([\s\S]*?)(?:\n#+\s|$)/i);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*[-*]\s*`?([^`\s]+)`?/gm)].map((x) => x[1].replace(/:\d+$/, ''));
}

function overlaps(a: string[], b: string[]): string | null {
  for (const x of a) for (const y of b) {
    if (x === y || x.startsWith(y.endsWith('/') ? y : y + '/') || y.startsWith(x.endsWith('/') ? x : x + '/')) return x;
  }
  return null;
}

const PRIORITY_WEIGHT: Record<number, number> = { 1: 40, 2: 30, 3: 20, 4: 10, 0: 12 };

/** Count of tickets transitively unblocked when this one is done. */
function unblockValue(t: Ticket, byId: Map<string, Ticket>, seen = new Set<string>()): number {
  let n = 0;
  for (const id of t.blocks) {
    if (seen.has(id)) continue;
    seen.add(id);
    const b = byId.get(id);
    if (!b || ['done', 'canceled'].includes(b.status)) continue;
    n += 1 + 0.5 * unblockValue(b, byId, seen);
  }
  return n;
}

/**
 * Rank Ready tickets. Hard filters: dependencies satisfied, no active job, project capacity, no file conflicts
 * with running work. Soft score: priority, unblocking value, small size, warm context, age, expected cost.
 */
export function rank(input: SchedulerInput): { eligible: Candidate[]; skipped: Skipped[] } {
  const { cfg, byId, activeJobs } = input;
  const eligible: Candidate[] = [];
  const skipped: Skipped[] = [];
  const activeTicketIds = new Set(activeJobs.map((j) => j.ticket_id));
  const working = activeJobs.filter((j) => ['running', 'queued', 'waiting_ci'].includes(j.status));
  const perProject = new Map<string, number>();
  for (const j of working) perProject.set(j.project, (perProject.get(j.project) ?? 0) + 1);

  for (const t of input.ready) {
    if (!t.projectKey) { skipped.push({ ticket: t, reason: 'no project mapping' }); continue; }
    if (t.labels.includes(LABEL_PLAN)) continue; // plan umbrella issues are not implementable
    if (activeTicketIds.has(t.id)) continue;
    const project = cfg.projects.find((p) => p.key === t.projectKey)!;
    if ((perProject.get(project.key) ?? 0) >= project.maxConcurrent) { skipped.push({ ticket: t, reason: `project ${project.key} at capacity` }); continue; }

    // Dependencies: "done" means merged and verified. A dependency in Review is implemented but NOT on the integration branch.
    let depProblem: string | null = null;
    let stackBase: string | undefined;
    const unmerged: Ticket[] = [];
    for (const id of t.blockedBy) {
      const dep = byId.get(id);
      if (!dep) { depProblem = `dependency ${id} not visible`; break; }
      if (dep.status === 'done') continue;
      if (dep.status === 'canceled') { depProblem = `dependency ${dep.identifier} was canceled (needs human)`; break; }
      unmerged.push(dep);
    }
    if (!depProblem && unmerged.length) {
      const depJob = unmerged.length === 1 ? activeJobs.find((j) => j.ticket_id === unmerged[0].id && j.status === 'awaiting_merge' && j.branch) : undefined;
      if (project.stackedBranches && depJob) stackBase = depJob.branch!;
      else depProblem = `waiting for ${unmerged.map((d) => `${d.identifier} (${d.status})`).join(', ')} to merge`;
    }
    if (depProblem) { skipped.push({ ticket: t, reason: depProblem }); continue; }

    // Avoid concurrent edits to the same files in the same repo.
    const files = relevantFiles(t);
    let conflict: string | null = null;
    for (const j of working.filter((j) => j.repo === project.repo)) {
      const other = byId.get(j.ticket_id);
      const hit = other ? overlaps(files, relevantFiles(other)) : null;
      if (hit) { conflict = `file conflict with ${j.ticket_identifier} on ${hit}`; break; }
    }
    if (conflict) { skipped.push({ ticket: t, reason: conflict }); continue; }

    const reasons: string[] = [];
    let score = PRIORITY_WEIGHT[t.priority] ?? 12;
    reasons.push(`priority ${t.priority}: +${score}`);
    const unblocks = unblockValue(t, byId);
    if (unblocks) { score += unblocks * 8; reasons.push(`unblocks ${unblocks.toFixed(1)}: +${(unblocks * 8).toFixed(0)}`); }
    const complexity = t.estimate ?? 3;
    score -= complexity * 3; reasons.push(`complexity ${complexity}: -${complexity * 3}`);
    if (input.recentProjects?.has(project.key)) { score += 3; reasons.push('warm project context: +3'); }
    const ageDays = (Date.now() - Date.parse(t.createdAt)) / 86_400_000;
    const age = Math.min(5, ageDays * 0.25);
    if (age > 0.5) { score += age; reasons.push(`age ${ageDays.toFixed(0)}d: +${age.toFixed(1)}`); }
    if (input.costPerPoint) { const c = input.costPerPoint * complexity; score -= c * 0.5; reasons.push(`est. cost $${c.toFixed(2)}: -${(c * 0.5).toFixed(1)}`); }
    if (stackBase) { score -= 4; reasons.push(`stacked on ${stackBase}: -4`); }
    eligible.push({ ticket: t, score, reasons, baseBranchOverride: stackBase });
  }
  eligible.sort((a, b) => b.score - a.score || a.ticket.createdAt.localeCompare(b.ticket.createdAt));
  return { eligible, skipped };
}
