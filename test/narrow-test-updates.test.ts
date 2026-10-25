import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, job } from './helpers.ts';
import { analyzeTestUpdate, findSupersedingRequirement, isLiteral } from '../src/test-updates.ts';
import type { SecondReviewer, SecondReviewInput, SecondReviewVerdict, TestIntegrityVerdict, TestUpdateReviewInput } from '../src/agents/second-review.ts';
import { kvGet, kvSet } from '../src/db.ts';
import { inspectChanges } from '../src/policy.ts';

// Option B (2026-10-25): narrow existing-test updates (test renames and expected-value changes only) may merge without a
// human, but only with a recorded superseding requirement and a dedicated test-integrity review of the exact candidate.

// ---------------------------------------------------------------- fixtures: DEV-11's real edit

const OLD = `import { test } from 'node:test';
import assert from 'node:assert/strict';

test('an all-in raise sets currentBet but preserves lastFullRaiseIncrement', () => {
  let s = hand([20, 100, 100]);
  s = act(s, { seat: 0, type: 'raise', to: 20 });
  assert.equal(s.currentBet, 20);
  assert.equal(s.lastFullRaiseIncrement, 2);
  s = act(s, { seat: 1, type: 'raise', to: 40 });
  assert.equal(s.lastFullRaiseIncrement, 20);
});
`;
const DEV11 = OLD
  .replace("test('an all-in raise sets currentBet but preserves lastFullRaiseIncrement'", "test('a full-sized all-in raise sets currentBet and updates lastFullRaiseIncrement'")
  .replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.equal(s.lastFullRaiseIncrement, 18);');

// ---------------------------------------------------------------- classifier

test('DEV-11’s legitimate update (rename + 2 → 18) is a narrow update', () => {
  const r = analyzeTestUpdate(OLD, DEV11);
  assert.equal(r.eligible, true, r.why ?? '');
  assert.deepEqual(r.changes.map((c) => c.kind), ['name', 'expected']);
});

const INELIGIBLE: [string, string, RegExp][] = [
  ['deleting an assertion', OLD.replace('  assert.equal(s.lastFullRaiseIncrement, 2);\n', ''), /removed from an existing test file/],
  ['deleting a whole test', OLD.replace(/test\([\s\S]*\n\}\);\n/, ''), /removed from an existing test file/],
  ['adding a line inside an existing test', OLD.replace('  assert.equal(s.currentBet, 20);\n', '  return;\n  assert.equal(s.currentBet, 20);\n'), /added to an existing test file/],
  ['skipping a test (test.skip)', OLD.replace("test('an all-in", "test.skip('an all-in"), /test declaration was changed|test call changed/],
  ['focusing a test (test.only)', OLD.replace("test('an all-in", "test.only('an all-in"), /test declaration was changed|test call changed/],
  ['a skip option', OLD.replace("lastFullRaiseIncrement', () => {", "lastFullRaiseIncrement', { skip: true }, () => {"), /beyond its name/],
  ['commenting out an assertion', OLD.replace('  assert.equal(s.lastFullRaiseIncrement, 2);', '  // assert.equal(s.lastFullRaiseIncrement, 2);'), /neither a test rename nor an expected-value update/],
  ['weakening equal → ok', OLD.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.ok(s.lastFullRaiseIncrement);'), /assertion changed from assert.equal to assert.ok/],
  ['weakening equal → notEqual', OLD.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.notEqual(s.lastFullRaiseIncrement, 2);'), /assertion changed/],
  ['expected becomes an expression', OLD.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.equal(s.lastFullRaiseIncrement, s.currentBet - 2);'), /not a plain literal/],
  ['expected becomes the actual (tautology)', OLD.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.equal(s.lastFullRaiseIncrement, s.lastFullRaiseIncrement);'), /not a plain literal|equals the actual/],
  ['changing the asserted expression', OLD.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.equal(s.currentBet, 2);'), /actual\) expression changed/],
  ['unrelated edit to setup', OLD.replace('hand([20, 100, 100])', 'hand([20, 100, 101])'), /neither a test rename nor an expected-value update/],
];
for (const [name, edited, why] of INELIGIBLE) {
  test(`ineligible: ${name}`, () => {
    const r = analyzeTestUpdate(OLD, edited);
    assert.equal(r.eligible, false);
    assert.match(String(r.why), why);
  });
}

test('literals: plain values only', () => {
  for (const ok of ['18', '-2', '1.5e3', "'x'", '"y"', 'true', 'null', '[1, 2]', "{ a: 1, 'b': [true] }", '[]']) assert.equal(isLiteral(ok), true, ok);
  for (const bad of ['s.x', 'x + 1', '`t${a}`', 'undefined', 'f()', '[a]', '{ a: b }', '1 || 2']) assert.equal(isLiteral(bad), false, bad);
});

test('superseding requirement: ticket text, human comments and human decisions count; automation never does', () => {
  const none = { description: 'Implement TDA reopening.', comments: [{ body: 'This supersedes everything (autodev note).', byAutomation: true }], humanDecisions: [] };
  assert.deepEqual(findSupersedingRequirement(none), []);
  assert.equal(findSupersedingRequirement({ ...none, comments: [{ body: '/answer DEV-11 supersedes DEV-10’s interim rule.', byAutomation: false }] })[0]!.source, 'human comment');
  assert.equal(findSupersedingRequirement({ ...none, humanDecisions: [{ question: 'q', decision: 'The old rule is superseded.' }] })[0]!.source, 'human decision');
  assert.equal(findSupersedingRequirement({ ...none, description: 'This ticket supersedes the interim rule in DEV-10.' })[0]!.source, 'ticket description');
});

// ---------------------------------------------------------------- end to end through the pipeline and merge gate

const APPROVE: SecondReviewVerdict = { verdict: 'approve', summary: 'Correct.', findings: [], specConformance: 'ok' };
const BUG: SecondReviewVerdict = { verdict: 'request_changes', summary: 'Bug.', findings: [{ severity: 'major', category: 'bug', file: 'src/x.js', line: 1, issue: 'off by one', suggestion: 'fix' }], specConformance: '' };
const INTEGRITY_OK: TestIntegrityVerdict = { verdict: 'approve', implementsRequirement: true, preservesCoverage: true, summary: 'New expectation implements the superseding rule.', concerns: [] };
const INTEGRITY_NO: TestIntegrityVerdict = { verdict: 'reject', implementsRequirement: true, preservesCoverage: false, summary: 'The edge case lost its check.', concerns: ['short all-in no longer covered'] };

class Reviewer implements SecondReviewer {
  readonly provider = 'openai';
  readonly model = 'gpt-6.1-sol';
  code: SecondReviewVerdict[];
  integrity: TestIntegrityVerdict[];
  codeInputs: SecondReviewInput[] = [];
  integrityInputs: TestUpdateReviewInput[] = [];
  constructor(code: SecondReviewVerdict[] = [APPROVE], integrity: TestIntegrityVerdict[] = [INTEGRITY_OK]) { this.code = code; this.integrity = integrity; }
  maxCostUsd() { return 0.2; }
  maxTestUpdateCostUsd() { return 0.2; }
  async review(input: SecondReviewInput) { this.codeInputs.push(input); return { verdict: this.code.length > 1 ? this.code.shift()! : this.code[0]!, model: this.model, costUsd: 0.03, inputTokens: 1, outputTokens: 1 }; }
  async reviewTestUpdate(input: TestUpdateReviewInput) { this.integrityInputs.push(input); return { verdict: this.integrity.length > 1 ? this.integrity.shift()! : this.integrity[0]!, model: this.model, costUsd: 0.02, inputTokens: 1, outputTokens: 1 }; }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' } });
function seedMain(repo: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  git(dir, 'clone', '-q', repo, '.');
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'seed'); git(dir, 'push', '-q', 'origin', 'HEAD:main');
}

const TEST_PATH = 'test/apply-action.test.js';
/** A coding agent that edits the existing test file (and, from the second call, makes a code change so the candidate moves). */
function env(reviewer: Reviewer, edit: (n: number) => string, extra: (cwd: string, n: number) => void = () => {}) {
  const e = makeEnv({
    secondReviewer: reviewer,
    project: { autoMerge: true, protectTests: true },
    config: { secondReview: { enabled: true } },
    behaviors: { coding: async (spec, n) => {
      writeFileSync(join(spec.cwd, TEST_PATH), edit(n));
      writeFileSync(join(spec.cwd, 'CHANGES.md'), `change ${n}\n`);
      extra(spec.cwd, n);
      return { structured: { status: 'completed', summary: 'done', filesChanged: [TEST_PATH], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
  seedMain(e.repo, { [TEST_PATH]: OLD });
  return e;
}
const ticket = (e: ReturnType<typeof makeEnv>) => e.tracker.createTicket({ projectKey: 'demo', title: 'TDA reopening', description: 'Implement per-player reopening.', status: 'ready', priority: 2 });
const authorize = (e: ReturnType<typeof makeEnv>, id: string) => e.tracker.humanComment(id, '/answer DEV-11 supersedes DEV-10’s interim rule: expect lastFullRaiseIncrement = 18 for the full-sized all-in raise.');
async function cycles(e: ReturnType<typeof makeEnv>, n: number) { for (let i = 0; i < n; i++) await e.cycle(); }
const merged = async (e: ReturnType<typeof makeEnv>, t: { identifier: string }) => (await e.scm.getPr(e.repo, job(e, t.identifier).pr_number)).state === 'merged';
const event = (e: ReturnType<typeof makeEnv>, type: string) => !!e.ctx.db.prepare('SELECT 1 FROM events WHERE type = ?').get(type);
const comments = async (e: ReturnType<typeof makeEnv>, id: string) => (await e.tracker.listComments(id)).map((c) => c.body).join('\n---\n');

test('e2e: DEV-11’s legitimate update with a recorded superseding decision merges via the test-integrity review, no human', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer, () => DEV11);
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 3);
  assert.equal(job(e, t.identifier).blocked_reason, null, 'never blocked for a human');
  assert.ok(event(e, 'policy.test_update_deferred'));
  assert.equal(reviewer.integrityInputs.length, 1);
  const input = reviewer.integrityInputs[0]!;
  assert.equal(input.candidateSha, job(e, t.identifier).candidate_sha);
  assert.equal(input.originalTests[0]!.content, OLD, 'the reviewer sees the original tests');
  assert.match(input.testDiff, /-  assert\.equal\(s\.lastFullRaiseIncrement, 2\);\n\+  assert\.equal\(s\.lastFullRaiseIncrement, 18\);/);
  assert.match(input.superseding[0]!.text, /supersedes DEV-10’s interim rule/);
  assert.ok(event(e, 'test_integrity.approved'));
  assert.equal(await merged(e, t), true);
});

test('e2e: missing authorization holds the PR for a human; no test-integrity call, no merge', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer, () => DEV11);
  const t = await ticket(e);
  await cycles(e, 3);
  assert.equal(reviewer.integrityInputs.length, 0);
  assert.equal(await merged(e, t), false);
  assert.match(await comments(e, t.id), /neither the ticket nor a recorded human decision says the old behavior is superseded/);
});

test('e2e: a test-integrity rejection holds the PR; nothing merges', async () => {
  const reviewer = new Reviewer([APPROVE], [INTEGRITY_NO]);
  const e = env(reviewer, () => DEV11);
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 3);
  assert.equal(reviewer.integrityInputs.length, 1);
  assert.equal(await merged(e, t), false);
  assert.equal(reviewer.codeInputs.length, 0, 'the code review never runs after an integrity rejection');
  assert.match(await comments(e, t.id), /test-integrity review \(gpt-6\.1-sol\) did not approve[\s\S]*preserves coverage: false/);
});

test('e2e: a "reject" is binding even if the model claims both conditions; an "approve" missing either condition is a reject', async () => {
  for (const v of [{ ...INTEGRITY_OK, verdict: 'reject' as const }, { ...INTEGRITY_OK, implementsRequirement: false }]) {
    const reviewer = new Reviewer([APPROVE], [v]);
    const e = env(reviewer, () => DEV11);
    const t = await ticket(e);
    authorize(e, t.id);
    await cycles(e, 3);
    assert.equal(await merged(e, t), false, JSON.stringify(v));
  }
});

for (const [name, edited] of [
  ['assertion deletion', OLD.replace('  assert.equal(s.lastFullRaiseIncrement, 2);\n', '')],
  ['skipping', OLD.replace("test('an all-in", "test.skip('an all-in")],
  ['weakened assertion', OLD.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.ok(s.lastFullRaiseIncrement);')],
  ['unrelated edit', OLD.replace('hand([20, 100, 100])', 'hand([20, 100, 101])')],
] as const) {
  test(`e2e: ${name} still blocks for a human (even with authorization); no test-integrity call`, async () => {
    const reviewer = new Reviewer();
    const e = env(reviewer, () => edited);
    const t = await ticket(e);
    authorize(e, t.id);
    await cycles(e, 2);
    const j = job(e, t.identifier);
    assert.equal(j.status, 'blocked');
    assert.match(String(j.blocked_reason), /existing test file changed|test skipped/);
    assert.equal(reviewer.integrityInputs.length, 0);
    assert.equal(event(e, 'policy.test_update_deferred'), false);
  });
}

test('e2e: a dependency change next to a narrow test update keeps the human gate', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer, () => DEV11, (cwd) => writeFileSync(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}'));
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 2);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.integrityInputs.length, 0);
});

test('e2e: stale approvals don’t carry over: a new candidate needs a new test-integrity review (here rejected) and does not merge', async () => {
  // First candidate: integrity approves, but the code review finds a bug → rework → a new candidate commit.
  const reviewer = new Reviewer([BUG, APPROVE], [INTEGRITY_OK, INTEGRITY_NO]);
  const e = env(reviewer, () => DEV11, (cwd, n) => { mkdirSync(join(cwd, 'src'), { recursive: true }); writeFileSync(join(cwd, 'src', 'x.js'), `export const v = ${n};\n`); });
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 5);
  assert.equal(reviewer.integrityInputs.length, 2, 'reviewed again for the new candidate');
  const [first, second] = reviewer.integrityInputs;
  assert.notEqual(first!.candidateSha, second!.candidateSha);
  assert.equal(second!.candidateSha, job(e, t.identifier).candidate_sha);
  assert.equal(kvGet(e.ctx.db, `test-integrity:${job(e, t.identifier).id}:${first!.candidateSha}`) !== null, true, 'the old approval is bound to the old sha only');
  assert.equal(await merged(e, t), false, 'the stale approval did not merge the new candidate');
});

test('e2e: a cached approval for another sha is never used for the current candidate', async () => {
  const reviewer = new Reviewer([APPROVE], [INTEGRITY_NO]);
  const e = env(reviewer, () => DEV11);
  const t = await ticket(e);
  authorize(e, t.id);
  await e.cycle();
  const j = job(e, t.identifier);
  kvSet(e.ctx.db, `test-integrity:${j.id}:${'f'.repeat(40)}`, JSON.stringify(INTEGRITY_OK)); // approval for some other commit
  await cycles(e, 2);
  assert.equal(reviewer.integrityInputs.length, 1);
  assert.equal(await merged(e, t), false);
});

test('e2e: a human-approved flagged diff is not routed to the test-integrity review; it waits for a human merge', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer, () => DEV11);
  const t = await ticket(e);
  authorize(e, t.id);
  await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge');
  // A human approved this exact flagged diff through the normal policy path (as with DEV-11 in production).
  const { hash } = await inspectChanges(e.ctx.ws, j.worktree, j.base_branch, e.ctx.cfg.projects[0]!, e.ctx.cfg);
  kvSet(e.ctx.db, `policy-approved:${j.id}:${hash}`, 'human');
  await cycles(e, 2);
  assert.equal(reviewer.integrityInputs.length, 0);
  assert.equal(await merged(e, t), false);
  assert.match(await comments(e, t.id), /diff policy flags changes that need a human/);
});

test('agents are told about the narrow exception only when auto-merge is on', async () => {
  const { docsHint } = await import('../src/agents/prompts.ts');
  const base = makeEnv().ctx.cfg.projects[0]!;
  assert.doesNotMatch(docsHint({ ...base, protectTests: true, autoMerge: false }), /Narrow exception/);
  const hint = docsHint({ ...base, protectTests: true, autoMerge: true });
  assert.match(hint, /Narrow exception: when this ticket or a recorded human decision explicitly says earlier behavior is SUPERSEDED/);
  assert.match(hint, /Never delete, skip, comment out, add or otherwise edit lines in an existing test file/);
});

// ---------------------------------------------------------------- lexical context (review of 90d0c63, P1)

import { lexLines } from '../src/test-updates.ts';

/** Reproduction: assertion-looking text inside a template literal; the "expected value" edit breaks out of the template. */
const TEMPLATE_OLD = `import { test } from 'node:test';
import assert from 'node:assert/strict';

const fixture = \`
  assert.equal(s.lastFullRaiseIncrement, 2);
\`;

test('real check', () => {
  assert.equal(compute(), 2);
});
`;
const TEMPLATE_BYPASS = TEMPLATE_OLD.replace("  assert.equal(s.lastFullRaiseIncrement, 2);", "  assert.equal(s.lastFullRaiseIncrement, '`+process.exit(0)+`');");

test('P1 reproduction: an "expected value" edit inside a template literal that breaks out into code is ineligible', () => {
  // Sanity: line patterns alone would accept it ('`+process.exit(0)+`' looks like a single-quoted literal) ...
  assert.equal(isLiteral("'`+process.exit(0)+`'"), true);
  // ... but in context it closes the template and runs process.exit(0) before the real test.
  const r = analyzeTestUpdate(TEMPLATE_OLD, TEMPLATE_BYPASS);
  assert.equal(r.eligible, false);
  assert.match(String(r.why), /inside \(or leaves open\) a string, template literal, comment or regular expression/);
});

test('P1: a harmless-looking value edit on a line inside a template literal is ineligible too', () => {
  const r = analyzeTestUpdate(TEMPLATE_OLD, TEMPLATE_OLD.replace('lastFullRaiseIncrement, 2);', 'lastFullRaiseIncrement, 18);'));
  assert.equal(r.eligible, false);
});

test('P1: edits inside a block comment, or that open or close one, are ineligible', () => {
  const inComment = OLD.replace("  assert.equal(s.currentBet, 20);\n  assert.equal(s.lastFullRaiseIncrement, 2);", "  /* assert.equal(s.currentBet, 20);\n  assert.equal(s.lastFullRaiseIncrement, 2); */");
  assert.equal(analyzeTestUpdate(inComment, inComment.replace('lastFullRaiseIncrement, 2); */', 'lastFullRaiseIncrement, 18); */')).eligible, false);
});

test('P1: a ${...} expression inside a template is not top-level code', () => {
  const src = 'const t = `x ${\n  assert.equal(a, 1)\n} y`;\n';
  const l = lexLines(src);
  assert.equal(l.ok, true);
  assert.deepEqual(l.codeAtStart, [true, false, false, true]);
  assert.equal(analyzeTestUpdate(src, src.replace('assert.equal(a, 1)', 'assert.equal(a, 2)')).eligible, false);
});

test('P1: files that cannot be lexed unambiguously are ineligible (unterminated template, string line continuation)', () => {
  assert.equal(lexLines('const a = `open\n').ok, false);
  assert.equal(lexLines("const a = 'one \\\ntwo';\n").ok, false);
  const unterminated = OLD + 'const tail = `\n';
  assert.equal(analyzeTestUpdate(unterminated, unterminated.replace('lastFullRaiseIncrement, 2);', 'lastFullRaiseIncrement, 18);')).eligible, false);
});

test('P1: legitimate files with regex literals, strings and templates elsewhere stay eligible', () => {
  const rich = OLD.replace("test('an all-in raise", "const re = /a\\/b[/]c/g;\nconst msg = `t ${ {a: 1}.a } \\` done`;\nassert.match('x/y', /x\\/y/);\nconst half = 4 / 2 / 1;\ntest('an all-in raise");
  const l = lexLines(rich);
  assert.equal(l.ok, true);
  const r = analyzeTestUpdate(rich, rich.replace("test('an all-in raise sets currentBet but preserves lastFullRaiseIncrement'", "test('a full-sized all-in raise sets currentBet and updates lastFullRaiseIncrement'").replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.equal(s.lastFullRaiseIncrement, 18);'));
  assert.equal(r.eligible, true, r.why ?? '');
});

test('P1 e2e: the template-literal bypass is never deferred; it blocks for a human even with authorization', async () => {
  const reviewer = new Reviewer();
  const e = makeEnv({
    secondReviewer: reviewer, project: { autoMerge: true, protectTests: true }, config: { secondReview: { enabled: true } },
    behaviors: { coding: async (spec) => {
      writeFileSync(join(spec.cwd, TEST_PATH), TEMPLATE_BYPASS);
      writeFileSync(join(spec.cwd, 'CHANGES.md'), 'x\n');
      return { structured: { status: 'completed', summary: 'done', filesChanged: [TEST_PATH], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
  seedMain(e.repo, { [TEST_PATH]: TEMPLATE_OLD });
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 2);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.integrityInputs.length, 0);
  assert.equal(event(e, 'policy.test_update_deferred'), false);
});
