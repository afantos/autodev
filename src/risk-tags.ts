import type { Ctx } from './context.ts';
import type { Job } from './types.ts';
import type { ProjectConfig } from './config.ts';

export const RISK_TAGS = ['payments_prizes', 'user_data_security', 'github_settings', 'deployment_secrets', 'budget_increase', 'spec_change'] as const;

/** Risk classification. In continue these tags only affect audit ordering; they never authorize or block an action. */
export function riskReasons(text: string, files: string[] = [], category?: string, project?: ProjectConfig): string[] {
  const reasons = new Set<string>();
  if (['billing_pricing', 'paid_service'].includes(category ?? '')) reasons.add('payments or budget');
  if (['auth_policy', 'privacy_compliance', 'destructive_data', 'security'].includes(category ?? '')) reasons.add('user data or security');
  if (category === 'production_deploy') reasons.add('deployment');
  const patterns: [RegExp, string][] = [
    [/\b(payment|payments|payout|payouts|prize|prizes|refund|billing|pricing)\b/i, 'payments and prizes'],
    [/\b(user data|personal data|customer data|pii|privacy|consent|data retention|security|vulnerability|access control|authentication policy|authorization policy|credential|credentials)\b/i, 'user data and security'],
    [/\b(github settings|branch protection|repository settings|rulesets?)\b/i, 'GitHub settings'],
    [/\b(deploy|deployment|deployments|secrets?|production configuration|MAIL_POSTAL_ADDRESS|SITE_URL)\b/i, 'deployment and secrets'],
    [/\b(increase|raise|raising|higher|expand)\b.{0,50}\b(budget|spend|spending|cost limit)\b|\bbudget (increase|override)\b/i, 'budget increases'],
    [/\b(change|edit|update|relax|rewrite|amend|modify)\w*\s+(?:the\s+)?(?:product\s+)?(?:spec|specification|requirements)\b/i, 'spec changes'],
  ];
  for (const [pattern, reason] of patterns) if (pattern.test(text)) reasons.add(reason);
  for (const file of files) {
    if (/(^|\/)(?:product-spec|specification|specs?)(?:\.md|\/|$)/i.test(file)) reasons.add(`spec changes: ${file}`);
    if (/(^|\/)(?:payments?|prizes?|payouts?)(?:[/. _-]|$)/i.test(file)) reasons.add(`payments and prizes: ${file}`);
    if (/(^|\/)(?:auth|security|user-data|customer-data)(?:[/. _-]|$)/i.test(file)) reasons.add(`user data and security: ${file}`);
    if (/^\.github\//.test(file)) reasons.add(`GitHub settings: ${file}`);
    if (/(^|\/)(?:deploy|deployment|infra|terraform)(\/|\.)|(^|\/)\.env(?:\.|$)|(^|\/)(?:vercel|wrangler)\.(?:jsonc?|toml)$|(^|\/)compose\.ya?ml$/i.test(file)) reasons.add(`deployment and secrets: ${file}`);
    if (project?.alwaysHumanPaths.some(pattern => new RegExp(pattern).test(file))) reasons.add(`alwaysHumanPaths: ${file}`);
  }
  return [...reasons];
}

export function changedPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)].flatMap(m => [m[1], m[2]]);
}

export function diffRiskTags(diff: string, project: ProjectConfig, files = changedPaths(diff)): string[] {
  const edits = diff.split('\n').filter(line => /^[+-]/.test(line) && !/^([+]{3}|[-]{3})/.test(line)).join('\n');
  return riskReasons(edits, files, undefined, project);
}

/** NUL-delimited trusted Git paths cover renames, quoted names and deleted protected files. */
export async function candidateRiskTags(ctx: Ctx, job: Job, project: ProjectConfig, diff: string): Promise<string[]> {
  if (!job.worktree) throw new Error('Missing worktree for protected-path inspection');
  const state = ctx.ws.trustedState(job.worktree);
  const files = (await ctx.ws.git(job.worktree, ['diff', '--no-renames', '--name-only', '-z', `${state.base_sha}...${state.head_sha}`])).split('\0').filter(Boolean);
  return diffRiskTags(diff, project, files);
}
