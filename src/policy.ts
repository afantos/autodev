import { existsSync, readFileSync } from 'node:fs';
import { analyzeTestUpdate } from './test-updates.ts';
import type { TestUpdateAnalysis } from './test-updates.ts';
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

export const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
/** Added test code that can disable, skip, focus or short-circuit tests, or replace assertions. */
const WEAKENING_ADDED: [RegExp, string][] = [
  [/\.\s*(?:skip|only|todo)\b/, 'skips, focuses or marks a test todo'],
  [/\b(?:skip|only|todo)\s*:/, 'sets a skip/only/todo test option'],
  [/\bprocess\s*(?:\??\.\s*(?:exit|abort|kill|exitCode|reallyExit)\b|(?:\?\.\s*)?\[)/, 'can end the test process early'],
  // Indirect routes to the same thing. Heuristic, so it errs towards a human: computed or optional access through the
  // global object (globalThis['process']['exit']), aliasing or passing `process` (Reflect.get(process, 'exit')),
  // unicode-escaped identifiers (\u0070rocess), dynamic code (eval, Function, a constructor chain) and modules that
  // can end or replace the process.
  [new RegExp([
    String.raw`\b(?:globalThis|global|self|window)\b\s*(?:\?\.\s*)?(?:\[|\.\s*process\b|[,)])`,
    String.raw`(?:[=(,:]|\?\?|\|\||&&|\.\.\.)\s*process\b(?!\s*\.\s*env\b)`,
    String.raw`\bprocess\s*\)`,
    // Member access only (x.constructor(...), [].constructor.constructor): a class's own `constructor(...)` is fine.
    String.raw`\beval\s*\(|\bFunction\s*\(|\bnew\s+Function\b|\.\s*constructor\s*(?:\(|\.\s*constructor\b)|\[\s*['"\x60]constructor['"\x60]\s*\]`,
    String.raw`(?:\b(?:require|import)\s*\(\s*|\bfrom\s+|\bimport\s+)['"\x60](?:node:)?(?:process|vm|child_process|worker_threads|cluster|module|inspector)['"\x60]`,
  ].join('|')), 'reaches the process object or runs dynamic code'],
  // Dotted, computed and optional member writes (assert.equal =, assert["equal"] =, assert?.strict.equal +=), the
  // reflective ways to do the same, and aliasing or passing `assert` itself somewhere it could be rewritten.
  [new RegExp([
    String.raw`\bassert\s*(?:(?:\?\.|\.)\s*[\w$]+|(?:\?\.\s*)?\[[^\]]*\])*\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])`,
    String.raw`\b(?:mock\s*\.\s*method|Object\s*\.\s*(?:defineProperty|defineProperties|assign|setPrototypeOf)|Reflect\s*\.\s*(?:set|defineProperty|setPrototypeOf|deleteProperty))\s*\(\s*assert\b`,
    String.raw`(?:[=(,:]|\?\?|\|\||&&|\.\.\.)\s*assert\s*(?:[;,)}\]]|$)`,
  ].join('|')), 'replaces assertion functions'],
  [/--test-(?:skip-pattern|name-pattern|only)\b/, 'filters which tests run'],
];

/**
 * Unicode-escaped identifiers (\u0070rocess.exit, pro\u0063ess): checked on the line with string-literal contents
 * removed, because inside a string an escape is just data (a control-character test case such as 'Ann\u0000').
 */
const ESCAPED_IDENTIFIER = /\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})(?=[\w$]{2})|[A-Za-z_$]{2}\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})|(?:^|[^\w$'"\x60\\])\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})/;

/**
 * The line with only proven string data blanked: the contents of '...' and "..." literals and the literal text of
 * `...` templates. Code inside ${...} interpolations is kept as written (including any strings nested in it). Returns
 * null when the line is ambiguous for a one-line scan: a '/' in code (regex literal, division or comment), an
 * unterminated literal or template (multi-line), or unbalanced braces. Callers then check the raw line.
 */
export function withoutStringContents(line: string): string | null {
  let out = '';
  // Stack of contexts: 'code' (with a brace depth for ${...} bodies), or a quote char for a literal/template.
  const stack: { kind: 'code' | "'" | '"' | '`'; depth: number }[] = [{ kind: 'code', depth: 0 }];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const top = stack[stack.length - 1]!;
    if (top.kind === "'" || top.kind === '"') {
      if (c === '\\') { i++; continue; }
      if (c === top.kind) { stack.pop(); out += c; }
      continue; // literal contents are data: blanked
    }
    if (top.kind === '`') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); out += c; continue; }
      if (c === '$' && line[i + 1] === '{') { stack.push({ kind: 'code', depth: 0 }); out += '${'; i++; continue; }
      continue; // template text is data: blanked
    }
    // code
    if (c === '/') return null; // regex literal, division or comment: not provable on one line
    if (c === "'" || c === '"' || c === '`') { stack.push({ kind: c, depth: 0 }); out += c; continue; }
    if (c === '{') top.depth++;
    if (c === '}') {
      if (top.depth > 0) top.depth--;
      else if (stack.length > 1) { stack.pop(); out += c; continue; } // end of a ${...} body
      else return null; // unbalanced
    }
    out += c;
  }
  return stack.length === 1 && stack[0]!.depth >= 0 ? out : null; // inside a literal, template or ${ at end of line
}
/**
 * Conservative test-weakening check for one changed test file. Any change to a file that existed on the base
 * (edit, insertion, deletion) goes to a human: position-based exceptions (import header, end of file) were
 * bypassable, e.g. a block comment opened before an existing test and closed after it. New test files are allowed,
 * but every added line is scanned for code that disables tests or replaces assertions.
 */
export function testWeakening(file: string, addedLines: string[], existedOnBase: boolean): string[] {
  const out = new Set<string>();
  if (existedOnBase) out.add(existingTestReason(file));
  for (const l of addedLines) {
    for (const [re, why] of WEAKENING_ADDED) if (re.test(l)) out.add(`${file}: added test code ${why}`);
    if (ESCAPED_IDENTIFIER.test(withoutStringContents(l) ?? l)) out.add(`${file}: added test code reaches the process object or runs dynamic code`);
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
export interface PolicyInspection {
  hash: string;
  reasons: string[];
  /** Existing test files changed in this diff, each with its narrow-update analysis (option B). */
  testUpdates: (TestUpdateAnalysis & { file: string })[];
  /** Added code lines that matched a HUMAN_PATTERNS topic (the source of each "diff touches …" reason), for triage. */
  keywordMatches: { category: string; file: string; text: string }[];
  /** Fingerprint of the change itself, independent of where the base is; null when it can't be trusted (see diffFingerprint). */
  fingerprint: string | null;
}

const KEYWORD_REASON = 'diff touches ';

/**
 * True when every finding comes from the HUMAN_PATTERNS keyword heuristic and each has its matching lines on record.
 * Only these may be cleared by triage; paths, dependencies, CI, tests, removals, configured keywords and schema changes
 * never qualify.
 */
export function onlyKeywordFindings(r: PolicyInspection): boolean {
  if (!r.reasons.length) return false;
  return r.reasons.every((reason) => reason.startsWith(KEYWORD_REASON) && r.keywordMatches.some((m) => `${KEYWORD_REASON}${m.category}` === reason));
}

/**
 * Like `git patch-id`: a hash of the diff with index lines and hunk positions removed, so the same change on a moved
 * base fingerprints the same, while any change to its content or surrounding context does not.
 * Null when the diff shows any file as binary (a real binary, or a text file marked -diff in .gitattributes): its
 * content is then only identified by the abbreviated blob hash on the stripped index line, so two different payloads
 * would fingerprint the same. Such changes never carry an approval over.
 */
export function diffFingerprint(diff: string): string | null {
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(diff)) return null;
  const normalized = diff.split('\n').filter((l) => !l.startsWith('index ')).map((l) => (l.startsWith('@@') ? '@@' : l)).join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

/** The reason string the protectTests rule emits for an edited existing test file. */
export const existingTestReason = (file: string) => `${file}: existing test file changed`;

/**
 * True when the ONLY policy findings are edits to existing test files and every one of them is an eligible narrow update.
 * Any other finding (dependencies, CI, protected paths, deletions, skips, security keywords...) keeps the human gate.
 */
export function onlyNarrowTestUpdates(r: PolicyInspection): boolean {
  if (!r.reasons.length || !r.testUpdates.length) return false;
  const eligible = new Set(r.testUpdates.filter((u) => u.eligible).map((u) => existingTestReason(u.file)));
  return r.testUpdates.every((u) => u.eligible) && r.reasons.every((reason) => eligible.has(reason));
}

export async function inspectChanges(ws: Workspaces, worktree: string, base: string, project: ProjectConfig, cfg: Config): Promise<PolicyInspection> {
  const state = ws.trustedState(worktree);
  const ref = state.base_sha;
  const head = state.head_sha;
  const diff = await ws.diff(worktree, base);
  const files = (await ws.git(worktree, ['diff', '--name-only', '-z', '--no-renames', `${ref}...${head}`])).split('\0').filter(Boolean);
  const removed = (await ws.git(worktree, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', `${ref}...${head}`])).split('\0').filter(Boolean);
  const reasons: string[] = [];
  // Paths come from NUL-delimited listings and are used literally, never parsed from quoted diff headers.
  const trees = new Map<string, Set<string>>();
  const exists = async (revision: string, file: string): Promise<boolean> => {
    if (!trees.has(revision)) trees.set(revision, new Set((await ws.git(worktree, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', revision])).split('\0').filter(Boolean)));
    return trees.get(revision)!.has(file);
  };
  const content = async (revision: string, file: string): Promise<string | null> =>
    (await exists(revision, file)) ? ws.git(worktree, ['cat-file', 'blob', `${revision}:${file}`]) : null;
  const addedLines = async (file: string): Promise<string[]> => {
    const d = await ws.git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', `${ref}...${head}`, '--', `:(literal)${file}`]);
    const lines = d.split('\n');
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    return firstHunk === -1 ? [] : lines.slice(firstHunk).filter((l) => l.startsWith('+')).map((l) => l.slice(1));
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
  // Exclude documentation from semantic keyword rules, but inspect every code file's added lines.
  const added: string[] = [];
  const keywordMatches: PolicyInspection['keywordMatches'] = [];
  const testUpdates: PolicyInspection['testUpdates'] = [];
  for (const f of files) {
    const lines = await addedLines(f);
    if (!/\.(md|txt|snap)$/.test(f)) {
      added.push(...lines);
      for (const line of lines) for (const [pattern, reason] of HUMAN_PATTERNS) if (pattern.test(line)) keywordMatches.push({ category: reason, file: f, text: line.trim().slice(0, 300) });
    }
    if (project.protectTests && TEST_FILE.test(f)) {
      const existed = await exists(ref, f);
      reasons.push(...testWeakening(f, lines, existed));
      if (existed) {
        const before = await content(ref, f);
        const after = await content(head, f);
        testUpdates.push({ file: f, ...(before === null || after === null ? { eligible: false, why: 'existing test file removed', changes: [] } : analyzeTestUpdate(before, after, f)) });
      }
    }
  }
  const text = added.join('\n');
  for (const [pattern, reason] of HUMAN_PATTERNS) if (pattern.test(text)) reasons.push(`diff touches ${reason}`);
  if (/\b(?:DROP\s+(?:TABLE|COLUMN|DATABASE)|TRUNCATE\s+|dropTable\s*\(|dropColumn\s*\()/i.test(text)) reasons.push('destructive schema change');
  for (const keyword of cfg.policy.humanKeywords) if (new RegExp(keyword, 'i').test(diff)) reasons.push(`diff matches configured keyword /${keyword}/`);
  // Include the complete tree, since binary changes can have identical textual diffs.
  const hash = createHash('sha256').update(ref).update(await ws.git(worktree, ['rev-parse', `${head}^{tree}`])).update(diff).digest('hex');
  return { hash, reasons: [...new Set(reasons)], testUpdates, keywordMatches, fingerprint: diffFingerprint(diff) };
}
