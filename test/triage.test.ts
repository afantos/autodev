import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import type { SecondReviewer, SecondReviewVerdict } from '../src/agents/second-review.ts';
import type { Clearance, Evidence, KeywordMatch, StructuredTask, Triage } from '../src/agents/triage.ts';
import type { FakeBehavior } from '../src/agents/fake.ts';
import { clearanceAccepted } from '../src/triage.ts';
import { diffFingerprint, onlyKeywordFindings } from '../src/policy.ts';
import { kvGet } from '../src/db.ts';
import type { PolicyInspection } from '../src/policy.ts';

const APPROVE: SecondReviewVerdict = { verdict: 'approve', summary: 'Correct.', findings: [], specConformance: 'ok' };

/** Second reviewer with programmable triage answers, keyed by task name; records every request. */
class TriageReviewer implements SecondReviewer {
  readonly provider = 'openai';
  readonly model = 'gpt-6.1-sol';
  asked: { name: string; prompt: string }[] = [];
  answers: Record<string, unknown[]>;
  constructor(answers: Record<string, unknown[]> = {}) { this.answers = answers; }
  maxCostUsd() { return 0.2; }
  maxTestUpdateCostUsd() { return 0.2; }
  maxAskCostUsd() { return 0.1; }
  async review() { return { verdict: APPROVE, model: this.model, costUsd: 0.03, inputTokens: 1, outputTokens: 1 }; }
  async reviewTestUpdate(): Promise<never> { throw new Error('unexpected test-integrity review'); }
  async ask<T>(task: StructuredTask<T>) {
    this.asked.push({ name: task.name, prompt: task.prompt });
    const q = this.answers[task.name] ?? [];
    const v = q.length > 1 ? q.shift() : q[0];
    if (v === undefined) throw new Error(`no answer for ${task.name}`);
    return { value: task.parser.parse(v), model: this.model, costUsd: 0.01, inputTokens: 1, outputTokens: 1 };
  }
  count(name: string) { return this.asked.filter((a) => a.name === name).length; }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' } });
function pushToMain(repo: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  git(dir, 'clone', '-q', repo, '.');
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'main moves'); git(dir, 'push', '-q', 'origin', 'HEAD:main');
}

/** A coding agent that writes fixed files (plus a per-ticket note so tickets don't conflict). */
const writes = (files: Record<string, string>): FakeBehavior => async (spec) => {
  const id = spec.prompt.match(/# ([A-Z0-9]+-\d+):/)?.[1] ?? 'ticket';
  const all = { ...files, [`notes/${id}.txt`]: `${id}\n` };
  for (const [p, c] of Object.entries(all)) { mkdirSync(join(spec.cwd, p, '..'), { recursive: true }); writeFileSync(join(spec.cwd, p), c); }
  return { structured: { status: 'completed', summary: 'done', filesChanged: Object.keys(all), testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
};
const APPROVED_REVIEW = { structured: { outcome: 'approved', summary: 'Looks good.', acceptanceCriteria: [], findings: [], followUps: [] } };
const blockingReview = (question: string, followUps: { title: string; description: string }[] = []) => ({ structured: { outcome: 'blocked', summary: 'The code is fine; one open question.', acceptanceCriteria: [], findings: [], followUps, blockingQuestion: question } });

function env(reviewer: SecondReviewer, behaviors: Record<string, FakeBehavior>, opts: { project?: Record<string, unknown>; secondReview?: Record<string, unknown> } = {}) {
  const e = makeEnv({ secondReviewer: reviewer, project: { autoMerge: true, ...opts.project }, config: { secondReview: { enabled: true, ...opts.secondReview } }, behaviors });
  pushToMain(e.repo, { 'CHANGES.md': 'changes\n' });
  return e;
}
async function cycles(e: ReturnType<typeof makeEnv>, n: number) { for (let i = 0; i < n; i++) await e.cycle(); }
const ticket = (e: ReturnType<typeof makeEnv>, title = 'Add the debug toggle') => e.tracker.createTicket({ projectKey: 'demo', title, description: 'Implement it.', status: 'ready', priority: 2 });
const merged = async (e: ReturnType<typeof makeEnv>, id: string) => { const pr = job(e, id)?.pr_number; return !!pr && (await e.scm.getPr(e.repo, pr)).state === 'merged'; };
const events = (e: ReturnType<typeof makeEnv>, type: string) => e.ctx.db.prepare('SELECT message FROM events WHERE type = ? ORDER BY id').all(type).map((r) => (r as { message: string }).message);
const comments = async (e: ReturnType<typeof makeEnv>, id: string) => (await e.tracker.listComments(id)).map((c) => c.body).join('\n---\n');

const PROD_COMMENT = { 'src/main.js': '// the production build drops the debug toggle\nexport const debug = false;\n' };
const CLEAR: Clearance = { verdict: 'clear', matches: [{ id: 'm1', restricted: false, explanation: 'A comment about the build mode; no deployment change.' }], summary: 'Mention only.' };

// ---------------------------------------------------------------- keyword-flag clearance

test('keyword-only flag (a comment saying "production") is cleared by triage for the exact diff and the PR auto-merges', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [CLEAR] });
  const e = env(reviewer, { coding: writes(PROD_COMMENT) });
  const t = await ticket(e);
  await cycles(e, 6);
  assert.equal(await merged(e, t.identifier), true);
  assert.equal(events(e, 'job.blocked').length, 0);
  assert.equal(events(e, 'triage.policy_cleared').length, 1);
  assert.equal(reviewer.count('keyword_flag_clearance'), 1, 'cleared once; the merge gate reuses the clearance for the same diff hash');
  assert.match(reviewer.asked[0]!.prompt, /m1 \[production system\] src\/main\.js: "\/\/ the production build drops the debug toggle"/);
  assert.match(await comments(e, t.id), /Triage \(gpt-6\.1-sol\)\*\* cleared the diff-policy keyword flag\(s\) \[production system\]/);
  assert.match(await comments(e, t.id), /policy \(keyword flag\(s\) cleared by triage as mentions only\)/);
});

test('a keyword match the model judges restricted goes to a human, with its explanation', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [{ verdict: 'escalate', matches: [{ id: 'm1', restricted: true, explanation: 'This configures the live deployment.' }], summary: 'Real deployment change.' }] });
  const e = env(reviewer, { coding: writes({ 'src/main.js': 'export const target = "production"; // deploy to prod\n' }) });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(await comments(e, t.id), /\*\*Triage:\*\* gpt-6\.1-sol did not clear the flag\(s\): Real deployment change\.\n- m1 restricted: This configures the live deployment\./);
  assert.equal(events(e, 'triage.policy_cleared').length, 0);
});

test('code enforces the clearance: "clear" with a restricted, missing, unknown or duplicate match is not accepted', () => {
  const matches: KeywordMatch[] = [{ id: 'm1', category: 'production system', file: 'a.js', text: 'x' }, { id: 'm2', category: 'production system', file: 'b.js', text: 'y' }];
  const ok = (id: string) => ({ id, restricted: false, explanation: '' });
  assert.equal(clearanceAccepted({ verdict: 'clear', matches: [ok('m1'), ok('m2')], summary: '' }, matches), true);
  assert.equal(clearanceAccepted({ verdict: 'clear', matches: [ok('m1'), { ...ok('m2'), restricted: true }], summary: '' }, matches), false);
  assert.equal(clearanceAccepted({ verdict: 'clear', matches: [ok('m1')], summary: '' }, matches), false);
  assert.equal(clearanceAccepted({ verdict: 'clear', matches: [ok('m1'), ok('m3')], summary: '' }, matches), false);
  assert.equal(clearanceAccepted({ verdict: 'clear', matches: [ok('m1'), ok('m1')], summary: '' }, matches), false);
  assert.equal(clearanceAccepted({ verdict: 'escalate', matches: [ok('m1'), ok('m2')], summary: '' }, matches), false);
});

test('e2e: a model that says "clear" while marking a match restricted does not clear it', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [{ ...CLEAR, matches: [{ id: 'm1', restricted: true, explanation: 'contradiction' }] }] });
  const e = env(reviewer, { coding: writes(PROD_COMMENT) });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(await merged(e, t.identifier), false);
});

test('only keyword findings qualify: a deployment path next to the keyword never reaches triage', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [CLEAR] });
  const e = env(reviewer, { coding: writes({ ...PROD_COMMENT, 'deploy/run.sh': 'echo hi\n' }) });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.asked.length, 0);
});

test('onlyKeywordFindings: every reason must be a keyword reason with matched lines on record', () => {
  const base: PolicyInspection = { hash: 'h', reasons: ['diff touches production system'], testUpdates: [], keywordMatches: [{ category: 'production system', file: 'a', text: 'x' }], fingerprint: 'f' };
  assert.equal(onlyKeywordFindings(base), true);
  assert.equal(onlyKeywordFindings({ ...base, reasons: [...base.reasons, 'a: protected path (/x/) changed'] }), false);
  assert.equal(onlyKeywordFindings({ ...base, keywordMatches: [] }), false);
  assert.equal(onlyKeywordFindings({ ...base, reasons: ['diff matches configured keyword /x/'] }), false);
  assert.equal(onlyKeywordFindings({ ...base, reasons: [] }), false);
});

test('triage is off without auto-merge, when disabled in config, or without a reviewer that supports it', async () => {
  for (const opts of [{ project: { autoMerge: false } }, { secondReview: { triage: { enabled: false } } }]) {
    const reviewer = new TriageReviewer({ keyword_flag_clearance: [CLEAR] });
    const e = env(reviewer, { coding: writes(PROD_COMMENT) }, opts);
    const t = await ticket(e);
    await cycles(e, 3);
    assert.equal(job(e, t.identifier).status, 'blocked', JSON.stringify(opts));
    assert.equal(reviewer.asked.length, 0, JSON.stringify(opts));
  }
  const plain: SecondReviewer = { provider: 'openai', model: 'm', maxCostUsd: () => 0.1, maxTestUpdateCostUsd: () => 0.1, review: async () => ({ verdict: APPROVE, model: 'm', costUsd: 0, inputTokens: 0, outputTokens: 0 }), reviewTestUpdate: async () => { throw new Error('x'); } };
  const e = env(plain, { coding: writes(PROD_COMMENT) });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
});

test('triage spend counts against the second-review caps: over budget, the flag goes to a human', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [CLEAR] });
  const e = env(reviewer, { coding: writes(PROD_COMMENT) }, { secondReview: { dailyUsd: 0.05 } });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.asked.length, 0);
  assert.match(await comments(e, t.id), /\*\*Triage:\*\* triage unavailable \(second-review budget reached\)/);
});

// ---------------------------------------------------------------- approval carry-over

test('a human approval carries over to the same change on a moved base (no second ask); a changed diff would not', async () => {
  const reviewer = new TriageReviewer();
  const e = env(reviewer, { coding: writes(PROD_COMMENT) }, { secondReview: { triage: { enabled: false } } });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  e.tracker.humanComment(t.id, '/answer approve - comment only');
  await e.tracker.setStatus(t.id, 'ready');
  await cycles(e, 4);
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', 'approved flagged diffs wait for a human merge');
  pushToMain(e.repo, { 'other.txt': 'unrelated\n' });
  await cycles(e, 5);
  assert.equal(events(e, 'policy.approval_carried').length, 1);
  assert.equal(events(e, 'job.blocked').length, 1, 'only the original block; the refreshed same change did not ask again');
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  assert.equal(await merged(e, t.identifier), false, 'still a human merge');
});

test('diffFingerprint: the same change on a moved base matches; different content or context does not', () => {
  const a = 'diff --git a/x b/x\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n ctx\n+added\n tail\n';
  const moved = a.replace('index 111..222', 'index 333..444').replace('@@ -1,2 +1,3 @@', '@@ -10,2 +10,3 @@');
  assert.equal(diffFingerprint(a), diffFingerprint(moved));
  assert.notEqual(diffFingerprint(a), diffFingerprint(a.replace('+added', '+added!')));
  assert.notEqual(diffFingerprint(a), diffFingerprint(a.replace(' ctx', ' other')));
});

// ---------------------------------------------------------------- factual questions

const FACTUAL: Triage = {
  kind: 'factual', summary: 'A grep settles it.', claim: 'CHANGES.md does not mention the toggle.',
  checks: [{ purpose: 'count mentions', command: 'grep -c toggle CHANGES.md; touch TRIAGE_RAN; echo checked' }],
  fixTickets: [], newTicket: null, instructions: '', recommendation: 'Answer with the grep count.',
};
const CONCLUSIVE: Evidence = { conclusive: true, answer: 'CHANGES.md has 0 mentions of the toggle (grep -c printed 0).', summary: 'Decisive.' };

test('a factual review question is answered with sandboxed checks on a copy of the candidate; the work resumes and merges', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [FACTUAL], evidence_evaluation: [CONCLUSIVE] });
  const e = env(reviewer, { coding: writes({ 'src/a.js': 'export const a = 1;\n' }), review: async (_s, n) => (n === 1 ? blockingReview('Does CHANGES.md mention the toggle?') : APPROVED_REVIEW) });
  const t = await ticket(e);
  await cycles(e, 3);
  const j = job(e, t.identifier);
  assert.equal(events(e, 'triage.checks').length, 1);
  assert.equal(existsSync(join(j.worktree, 'TRIAGE_RAN')), false, 'checks never run in the job worktree');
  assert.deepEqual(readdirSync(join(e.root, 'work', 'triage')), [], 'the throwaway copy is removed');
  const evidencePrompt = reviewer.asked.find((a) => a.name === 'evidence_evaluation')!.prompt;
  assert.match(evidencePrompt, /\$ grep -c toggle CHANGES\.md; touch TRIAGE_RAN; echo checked\nexit 0/);
  assert.match(evidencePrompt, /checked/);
  await cycles(e, 6);
  assert.equal(await merged(e, t.identifier), true);
  assert.equal(events(e, 'job.blocked').length, 0);
  const decision = e.ctx.db.prepare("SELECT authority, decision FROM decisions WHERE ticket_id = ? AND authority = 'triage'").get(t.id) as { authority: string; decision: string };
  assert.match(decision.decision, /^Verified by autodev triage \(gpt-6\.1-sol\) on candidate [0-9a-f]{12}:\nCHANGES\.md has 0 mentions/);
  const coding = e.runner.calls.filter((c) => c.role === 'coding');
  assert.match(coding[1]!.prompt, /Autodev triage answered a blocking question/);
  const text = await comments(e, t.id);
  assert.match(text, /autodev triage \(gpt-6\.1-sol\) resolved a blocking question/);
  assert.match(text, /Evidence \(commands run in the sandbox\):\*\*\n```\nCandidate [0-9a-f]{12}:\n\$ grep -c toggle CHANGES\.md/);
});

test('inconclusive evidence goes to a human with the evidence and the model\'s recommendation', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [FACTUAL], evidence_evaluation: [{ conclusive: false, answer: '', summary: 'The grep ran on the wrong file.' }] });
  const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Does CHANGES.md mention the toggle?') });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  const text = await comments(e, t.id);
  assert.match(text, /The checks were not conclusive: The grep ran on the wrong file\.\nCandidate [0-9a-f]{12}:\n\$ grep -c toggle/);
  assert.match(text, /\*\*Recommendation:\*\* Answer with the grep count\./);
});

test('checks are validated before anything runs: multi-line or too many commands go to a human', async () => {
  for (const checks of [[{ purpose: 'x', command: 'echo a\nrm -rf /' }], Array.from({ length: 7 }, () => ({ purpose: 'x', command: 'true' }))]) {
    const reviewer = new TriageReviewer({ blocker_triage: [{ ...FACTUAL, checks }], evidence_evaluation: [CONCLUSIVE] });
    const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Q?') });
    const t = await ticket(e);
    await cycles(e, 3);
    assert.equal(job(e, t.identifier).status, 'blocked');
    assert.equal(events(e, 'triage.checks').length, 0);
    assert.equal(reviewer.count('evidence_evaluation'), 0);
  }
});

test('an evidence "answer" that reads as an approval is refused', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [FACTUAL], evidence_evaluation: [{ ...CONCLUSIVE, answer: 'Approve the change; the checks pass.' }] });
  const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Q?') });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(await comments(e, t.id), /reads as an approval, which triage may not give/);
});

test('limits: the same question is triaged once; the next time it goes to a human', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [FACTUAL], evidence_evaluation: [CONCLUSIVE] });
  const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Does CHANGES.md mention the toggle?') });
  const t = await ticket(e);
  await cycles(e, 6);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.count('blocker_triage'), 1);
  assert.match(await comments(e, t.id), /triage already handled this same question once/);
});

test('limits: at most maxPerJob resolutions per job', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [FACTUAL], evidence_evaluation: [CONCLUSIVE] });
  let q = 0;
  const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview(`Question ${++q}?`) }, { secondReview: { triage: { maxPerJob: 1 } } });
  const t = await ticket(e);
  await cycles(e, 6);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.count('blocker_triage'), 1);
  assert.match(await comments(e, t.id), /triage already resolved 1 blocker\(s\) on this job \(limit 1\)/);
});

// ---------------------------------------------------------------- defects, product and permission questions

test('a defect is sequenced: the fix ticket suggested from this ticket is promoted and made a prerequisite; the work resumes on a refreshed base after it merges', async () => {
  const defect: Triage = { kind: 'defect', summary: 'Existing engine bug.', claim: '', checks: [], fixTickets: ['DEMO-2'], newTicket: null, instructions: 'Remove the temporary skip and assert the fixed behavior.', recommendation: 'Fix the engine first.' };
  const reviewer = new TriageReviewer({ blocker_triage: [defect] });
  const e = env(reviewer, {
    coding: writes({ 'src/a.js': '1\n' }),
    review: async (_s, n) => (n === 1 ? blockingReview('Hands get stuck in the engine; wait for a fix?', [{ title: 'Engine: complete stuck hands', description: 'The engine leaves hands stuck.' }]) : APPROVED_REVIEW),
  });
  const t = await ticket(e);
  await cycles(e, 3);
  const fix = (await e.tracker.listTickets({ projectKey: 'demo' })).find((x) => x.identifier === 'DEMO-2')!;
  assert.equal(fix.title, 'Engine: complete stuck hands');
  assert.ok(['ready', 'in_progress', 'review', 'done'].includes(fix.status), `fix promoted (now ${fix.status})`);
  assert.deepEqual((await e.tracker.getTicket(t.id))!.blockedBy, [fix.id]);
  assert.equal(events(e, 'triage.sequenced').length, 1);
  assert.equal(job(e, t.identifier).status, 'blocked', 'parked without holding a concurrency slot');
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'blocked');
  await cycles(e, 14);
  assert.equal(await merged(e, 'DEMO-2'), true, 'the fix merged first');
  assert.equal(await merged(e, t.identifier), true, 'then the blocked ticket');
  assert.match(events(e, 'triage.base_refreshed')[0]!, /merged the latest main/);
  // The resumed coding run (a session resume prompt has no ticket header) carries triage's instructions.
  assert.ok(e.runner.calls.some((c) => c.role === 'coding' && /Remove the temporary skip and assert the fixed behavior/.test(c.prompt)), 'resumed coding run got the instructions');
  assert.equal(events(e, 'job.blocked').length, 0, 'never asked a human');
  assert.equal(events(e, 'triage.prerequisites_merged').length, 1);
});

test('a defect that names a ticket outside the allowed set (not suggested from this ticket) goes to a human; nothing is promoted', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [{ kind: 'defect', summary: 's', claim: '', checks: [], fixTickets: ['DEMO-1'], newTicket: null, instructions: 'later', recommendation: 'r' }] });
  const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Bug elsewhere?') });
  const held = await e.tracker.createTicket({ projectKey: 'demo', title: 'Human-held idea', description: 'Kept in Backlog by the owner.', status: 'backlog', priority: 3 });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal((await e.tracker.getTicket(held.id))!.status, 'backlog');
  assert.deepEqual((await e.tracker.getTicket(t.id))!.blockedBy, []);
  assert.match(await comments(e, t.id), /outside the allowed set \(suggested from DEMO-2 in this attempt, with no owner comment or hold\): DEMO-1/);
});

test('product and permission questions go to the human with the model\'s classification and recommendation', async () => {
  for (const kind of ['product', 'permission', 'uncertain'] as const) {
    const reviewer = new TriageReviewer({ blocker_triage: [{ kind, summary: `It is ${kind}.`, claim: '', checks: [], fixTickets: [], newTicket: null, instructions: '', recommendation: `Owner decides (${kind}).` }] });
    const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Raise the budget?') });
    const t = await ticket(e);
    await cycles(e, 3);
    assert.equal(job(e, t.identifier).status, 'blocked', kind);
    const text = await comments(e, t.id);
    assert.match(text, new RegExp(`classified this as ${kind}: It is ${kind}\\.`));
    assert.match(text, new RegExp(`\\*\\*Recommendation:\\*\\* Owner decides \\(${kind}\\)\\.`));
  }
});

test('a blocker that is not a question (e.g. a policy flag on a protected path) never triggers question triage', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [FACTUAL] });
  const e = env(reviewer, { coding: writes({ 'deploy/run.sh': 'echo\n' }) });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.asked.length, 0);
});

// ---------------------------------------------------------------- review of cdbfc70

test('regression (P1): a diff with any binary change has no fingerprint, so two different payloads never share an approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  git(dir, 'init', '-q'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'root');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const diffOf = (files: Record<string, string | Buffer>) => {
    git(dir, 'checkout', '-q', '--detach', base);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change');
    // The exact flags Workspaces.diff uses.
    return git(dir, 'diff', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${base}...HEAD`);
  };
  const a = diffOf({ 'payload.bin': Buffer.from([0, 1, 2, 3, 0, 255]), 'note.js': '// production\n' });
  const b = diffOf({ 'payload.bin': Buffer.from([0, 9, 9, 9, 0, 255]), 'note.js': '// production\n' });
  assert.match(a, /^Binary files \/dev\/null and b\/payload\.bin differ$/m);
  assert.equal(a.replace(/^index .*$/gm, ''), b.replace(/^index .*$/gm, ''), 'without index lines the two diffs are identical (the reported collision)');
  assert.equal(diffFingerprint(a), null);
  assert.equal(diffFingerprint(b), null);
  // A text file the repository marks -diff is shown as binary too, and gets no fingerprint either.
  const hidden = diffOf({ '.gitattributes': 'secret.txt -diff\n', 'secret.txt': 'anything\n' });
  assert.match(hidden, /^Binary files \/dev\/null and b\/secret\.txt differ$/m);
  assert.equal(diffFingerprint(hidden), null);
  assert.equal(typeof diffFingerprint(diffOf({ 'note.js': '// production\n' })), 'string');
});

test('regression (P1) e2e: an approved flagged diff that includes a binary file is asked again after the base moves (no carry-over)', async () => {
  const reviewer = new TriageReviewer();
  const binary: FakeBehavior = async (spec, n) => {
    await writes(PROD_COMMENT)(spec, n);
    writeFileSync(join(spec.cwd, 'assets.bin'), Buffer.from([0, 1, 2, 0, 3]));
    return { structured: { status: 'completed', summary: 'done', filesChanged: ['assets.bin'], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
  };
  const e = env(reviewer, { coding: binary }, { secondReview: { triage: { enabled: false } } });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  e.tracker.humanComment(t.id, '/answer approve - ok');
  await e.tracker.setStatus(t.id, 'ready');
  await cycles(e, 4);
  assert.equal(job(e, t.identifier).status, 'awaiting_merge');
  pushToMain(e.repo, { 'other.txt': 'unrelated\n' });
  await cycles(e, 5);
  assert.equal(events(e, 'policy.approval_carried').length, 0);
  assert.equal(events(e, 'job.blocked').length, 2, 'the moved diff with a binary change needs a new human approval');
  assert.equal(job(e, t.identifier).status, 'blocked');
});

/** Simulates the owner reacting to a suggestion the moment it appears (before triage looks at it). */
function ownerHolds(e: ReturnType<typeof makeEnv>, how: 'comment' | 'label') {
  const create = e.tracker.createTicket.bind(e.tracker);
  e.tracker.createTicket = async (t) => {
    const created = await create(how === 'label' ? { ...t, labels: [...(t.labels ?? []), 'owner-hold'] } : t);
    if (how === 'comment') e.tracker.humanComment(created.id, 'Do not promote this; keep it in Backlog.');
    return created;
  };
}

for (const how of ['comment', 'label'] as const) {
  test(`regression (P1): a same-ticket suggestion the owner held (${how}) is never promoted`, async () => {
    const defect: Triage = { kind: 'defect', summary: 'Existing bug.', claim: '', checks: [], fixTickets: ['DEMO-2'], newTicket: null, instructions: 'Then assert the fix.', recommendation: 'Fix first.' };
    const reviewer = new TriageReviewer({ blocker_triage: [defect] });
    const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => blockingReview('Engine bug; wait for a fix?', [{ title: 'Engine: fix it', description: 'The engine is wrong.' }]) });
    ownerHolds(e, how);
    const t = await ticket(e);
    await cycles(e, 3);
    const fix = (await e.tracker.listTickets({ projectKey: 'demo' })).find((x) => x.identifier === 'DEMO-2')!;
    assert.equal(fix.status, 'backlog', 'stays in Backlog');
    assert.deepEqual((await e.tracker.getTicket(t.id))!.blockedBy, []);
    assert.equal(job(e, t.identifier).status, 'blocked');
    assert.match(await comments(e, t.id), /outside the allowed set .*: DEMO-2/);
    assert.doesNotMatch(reviewer.asked[0]!.prompt, /### DEMO-2/, 'held tickets are not even offered to the model');
  });
}

test('regression (P1): a suggestion from an earlier attempt of the same job is not eligible (the owner may have held it outside Linear)', async () => {
  const reviewer = new TriageReviewer({ blocker_triage: [
    { kind: 'permission', summary: 'Owner call.', claim: '', checks: [], fixTickets: [], newTicket: null, instructions: '', recommendation: 'Ask.' },
    { kind: 'defect', summary: 'Existing bug.', claim: '', checks: [], fixTickets: ['DEMO-2'], newTicket: null, instructions: 'Then assert the fix.', recommendation: 'Fix first.' },
  ] });
  let n = 0;
  const e = env(reviewer, { coding: writes({ 'src/a.js': '1\n' }), review: async () => (++n === 1 ? blockingReview('First question?', [{ title: 'Engine: fix it', description: 'x' }]) : blockingReview('Second question?')) });
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).status, 'blocked');
  e.tracker.humanComment(t.id, '/answer continue');
  await e.tracker.setStatus(t.id, 'ready');
  await cycles(e, 4);
  assert.equal(reviewer.count('blocker_triage'), 2);
  assert.equal((await e.tracker.listTickets({ projectKey: 'demo' })).find((x) => x.identifier === 'DEMO-2')!.status, 'backlog');
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(await comments(e, t.id), /outside the allowed set .*: DEMO-2/);
});

test('regression (P2): keyword clearance counts against maxPerJob; with the limit at 0 nothing is cleared or merged', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [CLEAR] });
  const e = env(reviewer, { coding: writes(PROD_COMMENT) }, { secondReview: { triage: { maxPerJob: 0 } } });
  const t = await ticket(e);
  await cycles(e, 5);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.asked.length, 0);
  assert.equal(await merged(e, t.identifier), false);
  assert.match(await comments(e, t.id), /\*\*Triage:\*\* triage already resolved 0 blocker\(s\) on this job \(limit 0\)/);
});

test('regression (P2): a clearance uses one resolution; reusing it at the merge gate for the same diff does not', async () => {
  const reviewer = new TriageReviewer({ keyword_flag_clearance: [CLEAR] });
  const e = env(reviewer, { coding: writes(PROD_COMMENT) }, { secondReview: { triage: { maxPerJob: 1 } } });
  const t = await ticket(e);
  await cycles(e, 6);
  assert.equal(await merged(e, t.identifier), true);
  assert.equal(kvGet(e.ctx.db, `triage-count:${job(e, t.identifier).id}`), '1');
});
