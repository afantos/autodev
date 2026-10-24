import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, ProjectConfig } from './config.ts';
import { AUTO_CATEGORIES } from './agents/schemas.ts';
import type { Decision } from './agents/schemas.ts';
import type { Workspaces } from './scm/git.ts';
import { createHash } from 'node:crypto';

/** Topics that always need a human, regardless of what the Decision Agent says. */
const HUMAN_PATTERNS: [RegExp, string][] = [
  [/\b(pric(e|es|ing)|billing|invoice|refund|charge customers?|plan limits?|subscription (tier|plan|price))\b/i, 'pricing/billing policy'],
  [/\b(auth(entication|orization)? (policy|model|flow change)|permission model|access control policy|who can access|role[- ]based access|sso|mfa policy)\b/i, 'auth policy'],
  [/\b(gdpr|ccpa|hipaa|pii|personal data|privacy|consent|data retention|compliance)\b/i, 'privacy/compliance'],
  [/\b(drop (table|column|database)|truncate|delete (all|existing|user|customer) (data|records|rows)|destructive|irreversible|data loss|purge)\b/i, 'destructive data operation'],
  [/\b(production|prod (db|database|deploy)|deploy(ment)? to prod|live environment)\b/i, 'production system'],
  [/\b(paid (service|plan|tier|api)|new (vendor|saas|service account)|purchase|monthly cost|infrastructure cost)\b/i, 'paid service/infrastructure'],
  [/\b(remove|deprecate|delete) (the )?(existing )?(feature|endpoint|page|functionality)\b/i, 'feature removal'],
];

const INSTALL_RE = /\b(?:npm (?:i|install)|pnpm add|yarn add|bun add|pip install|poetry add|uv add|cargo add|go get)[ \t]+((?:-{1,2}[\w-]+[ \t]+)*)([@\w./-]+(?:[ \t]+[@\w./-]+)*)/gi;

export interface PolicyResult {
  authority: 'auto' | 'human';
  reasons: string[];
}

/** Packages already declared in the worktree's manifests count as existing (not new) dependencies. */
export function existingDependencies(worktree: string | null): Set<string> {
  const out = new Set<string>();
  if (!worktree) return out;
  const pkg = join(worktree, 'package.json');
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, 'utf8'));
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) Object.keys(j[k] ?? {}).forEach((d) => out.add(d));
    } catch { /* ignore */ }
  }
  for (const f of ['requirements.txt', 'pyproject.toml']) {
    const p = join(worktree, f);
    if (existsSync(p)) for (const m of readFileSync(p, 'utf8').matchAll(/^\s*"?([A-Za-z0-9_.-]+)/gm)) out.add(m[1].toLowerCase());
  }
  return out;
}

export function mentionedInstalls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INSTALL_RE)) {
    for (const name of m[2].split(/[ \t]+/)) {
      if (!name || name.startsWith('-')) continue;
      out.push(name.replace(/@[\d^~<>=.*x-]+$/, '').replace(/==.*$/, ''));
    }
  }
  return out;
}

/**
 * Decide whether a Decision Agent recommendation may be applied autonomously.
 * This function can only escalate: any single reason makes it human-only.
 */
export function authorize(d: Decision, question: string, project: ProjectConfig, cfg: Config, worktree: string | null): PolicyResult {
  const reasons: string[] = [];
  if (d.requiresHuman) reasons.push('decision agent flagged requiresHuman');
  if (!(AUTO_CATEGORIES as readonly string[]).includes(d.category)) reasons.push(`category "${d.category}" requires human approval`);
  if (d.confidence < cfg.policy.minAutoConfidence) reasons.push(`confidence ${d.confidence} < ${cfg.policy.minAutoConfidence}`);
  const text = `${question}\n${d.recommendation}\n${d.reasoning}`;
  for (const [re, why] of HUMAN_PATTERNS) if (re.test(text)) reasons.push(`touches ${why}`);
  for (const k of cfg.policy.humanKeywords) if (new RegExp(k, 'i').test(text)) reasons.push(`matches configured keyword /${k}/`);
  const existing = existingDependencies(worktree);
  for (const dep of mentionedInstalls(text)) {
    if (!existing.has(dep) && !project.approvedDependencies.includes(dep)) reasons.push(`new dependency "${dep}" not approved`);
  }
  return { authority: reasons.length ? 'human' : 'auto', reasons };
}

const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Added test code that can disable, skip, focus or short-circuit tests, or replace assertions. */
const WEAKENING_ADDED: [RegExp, string][] = [
  [/\.\s*(?:skip|only|todo)\b/, 'skips, focuses or marks a test todo'],
  [/\b(?:skip|only|todo)\s*:/, 'sets a skip/only/todo test option'],
  [/\bprocess\s*(?:\.\s*(?:exit|abort|kill|exitCode|reallyExit)\b|\[)/, 'can end the test process early'],
  [/\bassert(?:\s*\.\s*\w+)*\s*=(?!=)|\b(?:mock\s*\.\s*method|Object\s*\.\s*(?:defineProperty|assign|setPrototypeOf))\s*\(\s*assert\b/, 'replaces assertion functions'],
  [/--test-(?:skip-pattern|name-pattern|only)\b/, 'filters which tests run'],
];
/** Leading lines of a test file before its first statement: imports, comments, blank lines. */
const HEADER_LINE = /^\s*(?:$|import\b|\/\/|\/\*|\*|['"]use strict['"])/;

/**
 * Conservative test-weakening check for one file's hunks. Any modified or removed line of an existing test file,
 * and any insertion other than in its import header or at its end, is ambiguous and goes to a human. Every added
 * line, in new and existing test files alike, is scanned for code that disables tests or replaces assertions.
 */
export function testWeakening(file: string, lines: string[], oldText: string | null): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    if (!l.startsWith('+')) continue;
    for (const [re, why] of WEAKENING_ADDED) if (re.test(l.slice(1))) out.add(`${file}: added test code ${why}`);
  }
  if (oldText === null) return [...out];
  const old = oldText.split('\n');
  if (old.at(-1) === '') old.pop();
  const headerEnd = old.findIndex((l) => !HEADER_LINE.test(l)); // 0-based index of the first statement
  const lastHeader = headerEnd === -1 ? old.length : headerEnd;
  let cur = 0; // old lines consumed so far
  for (const l of lines) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(l);
    if (h) { cur = h[2] === '0' ? Number(h[1]) : Number(h[1]) - 1; continue; }
    if (l.startsWith('\\')) continue;
    if (l.startsWith('-')) { out.add(`${file}: existing test code modified or removed`); cur++; continue; }
    if (l.startsWith('+')) {
      if (!(cur <= lastHeader || cur >= old.length)) out.add(`${file}: lines inserted inside existing test code`);
      continue;
    }
    cur++;
  }
  return [...out];
}

function withoutApprovedDeps(manifest: Record<string, unknown>, approved: string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...manifest };
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = manifest[field];
    if (deps && typeof deps === 'object') {
      const kept = Object.fromEntries(Object.entries(deps).filter(([name]) => !approved.includes(name)));
      if (Object.keys(kept).length) copy[field] = kept; else delete copy[field];
    }
  }
  return copy;
}

/** Mandatory check of committed changes against the trusted integration branch.
 * Semantic checks are conservative heuristics; they do not replace human review.
 */
export async function inspectChanges(ws: Workspaces, worktree: string, base: string, project: ProjectConfig, cfg: Config): Promise<{ hash: string; reasons: string[] }> {
  const state = ws.trustedState(worktree);
  const ref = state.base_sha;
  const head = state.head_sha;
  const diff = await ws.diff(worktree, base);
  const files = (await ws.git(worktree, ['diff', '--name-only', '-z', '--no-renames', `${ref}...${head}`])).split('\0').filter(Boolean);
  const removed = (await ws.git(worktree, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', `${ref}...${head}`])).split('\0').filter(Boolean);
  const reasons: string[] = [];
  const content = async (revision: string, file: string): Promise<string | null> => {
    const present = await ws.git(worktree, ['ls-tree', '-z', revision, '--', file]);
    if (!present) return null;
    return ws.git(worktree, ['show', `${revision}:${file}`]);
  };
  for (const file of files) {
    if (/(^|\/)package\.json$/.test(file)) {
      try {
        const before = JSON.parse(await content(ref, file) ?? '{}');
        const after = JSON.parse(await content(head, file) ?? '{}');
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const name of new Set([...Object.keys(before[field] ?? {}), ...Object.keys(after[field] ?? {})])) {
            if (JSON.stringify(before[field]?.[name]) !== JSON.stringify(after[field]?.[name]) && !project.approvedDependencies.includes(name)) {
              reasons.push(`${file}: unapproved dependency change ${name}`);
            }
          }
        }
        // Scripts, workspaces, exports, config ... decide what validation actually runs: any other change needs a human.
        if (JSON.stringify(withoutApprovedDeps(before, project.approvedDependencies)) !== JSON.stringify(withoutApprovedDeps(after, project.approvedDependencies))) {
          reasons.push(`${file}: manifest changed beyond approved dependencies (scripts, workspaces or other fields)`);
        }
      } catch { reasons.push(`${file}: dependency manifest cannot be safely inspected`); }
    } else if (/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|requirements[^/]*\.txt|pyproject\.toml|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(?:\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(?:\.kts)?)$/.test(file)) {
      reasons.push(`${file}: dependency changes require human review`);
    }
    if (/(^|\/)(\.github|\.claude|deploy|infrastructure|terraform)(\/|$)|(^|\/)(auth|permissions|privacy|pricing|billing)(\/|[._-])/i.test(file)) {
      reasons.push(`${file}: security, product policy or deployment configuration changed`);
    }
    if (removed.includes(file) && !/\.(md|txt|snap)$/.test(file)) reasons.push(`${file}: source or configuration file removed`);
    for (const pattern of project.humanReviewPaths) if (new RegExp(pattern).test(file)) reasons.push(`${file}: protected path (/${pattern}/) changed`);
  }
  // Exclude documentation from semantic keyword rules, but inspect every code hunk.
  let file = ''; let header = false; const added: string[] = [];
  const hunks = new Map<string, string[]>();
  for (const line of diff.split('\n')) {
    // File headers only appear between `diff --git` and the first hunk; content lines may also start with ---/+++.
    if (line.startsWith('diff --git ')) { header = true; continue; }
    if (header) {
      if (line.startsWith('--- a/')) file = line.slice(6);
      if (line.startsWith('+++ b/')) file = line.slice(6);
      if (!line.startsWith('@@')) continue;
      header = false;
    }
    if (!hunks.has(file)) hunks.set(file, []);
    hunks.get(file)!.push(line);
    if (line.startsWith('+') && !/\.(md|txt|snap)$/.test(file)) added.push(line.slice(1));
  }
  if (project.protectTests) {
    for (const [f, lines] of hunks) if (TEST_FILE.test(f)) reasons.push(...testWeakening(f, lines, await content(ref, f)));
  }
  const text = added.join('\n');
  for (const [pattern, reason] of HUMAN_PATTERNS) if (pattern.test(text)) reasons.push(`diff touches ${reason}`);
  if (/\b(?:DROP\s+(?:TABLE|COLUMN|DATABASE)|TRUNCATE\s+|dropTable\s*\(|dropColumn\s*\()/i.test(text)) reasons.push('destructive schema change');
  for (const keyword of cfg.policy.humanKeywords) if (new RegExp(keyword, 'i').test(diff)) reasons.push(`diff matches configured keyword /${keyword}/`);
  // Include the complete tree, since binary changes can have identical textual diffs.
  const hash = createHash('sha256').update(ref).update(await ws.git(worktree, ['rev-parse', `${head}^{tree}`])).update(diff).digest('hex');
  return { hash, reasons: [...new Set(reasons)] };
}
