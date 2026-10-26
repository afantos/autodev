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
  assert.ok(e.ctx.db.prepare('SELECT 1 FROM kv WHERE k LIKE ? AND v IS NOT NULL').get(`test-integrity:${job(e, t.identifier).id}:${first!.candidateSha}:%`), 'the old approval is bound to the old sha only');
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

// ---------------------------------------------------------------- escaped newlines and indirect process access (review of 9461fad)

/** Two template line continuations (backslash-newline) before the assertion-looking fixture line. The old lexer
 *  skipped each escaped newline without recording it, so every later line's context shifted by two and the fixture
 *  line was read as top-level code. */
const CONTINUED_OLD = `import { test } from 'node:test';
import assert from 'node:assert/strict';

const fixture = \`a\\
b\\
  assert.equal(s.lastFullRaiseIncrement, 2);
\`;

test('real check', () => {
  assert.equal(compute(), 2);
});

test('later check', () => {
  assert.equal(other(), 3);
});
`;
/** Computed access avoids `process.exit` / `process[`: the earlier pattern never matched it. */
const COMPUTED_EXIT = `'\`+globalThis["process"]["exit"](0)+\`'`;
const CONTINUED_BYPASS = CONTINUED_OLD.replace('lastFullRaiseIncrement, 2);', `lastFullRaiseIncrement, ${COMPUTED_EXIT});`);

test('regression: every physical line keeps its own context across template line continuations', () => {
  const l = lexLines(CONTINUED_OLD);
  const lines = CONTINUED_OLD.split('\n');
  assert.equal(l.ok, true);
  assert.equal(l.codeAtStart.length, lines.length);
  assert.equal(l.codeAtEnd.length, lines.length);
  const at = lines.indexOf('  assert.equal(s.lastFullRaiseIncrement, 2);');
  assert.equal(l.codeAtStart[at], false, 'the fixture line starts inside the template');
  assert.equal(l.codeAtEnd[at], false, 'and ends inside it');
  assert.equal(l.codeAtStart[lines.indexOf('b\\')], false);
  assert.equal(l.codeAtStart[lines.indexOf("test('real check', () => {")], true);
  assert.equal(l.codeAtEnd[lines.indexOf('`;')], true);
});

test('regression: the two-continuation template bypass is ineligible on its own (lexer), whatever the payload', () => {
  assert.equal(isLiteral(COMPUTED_EXIT), true, 'line patterns alone would accept the payload');
  const r = analyzeTestUpdate(CONTINUED_OLD, CONTINUED_BYPASS);
  assert.equal(r.eligible, false);
  assert.match(String(r.why), /inside \(or leaves open\) a string, template literal, comment or regular expression/);
  assert.equal(analyzeTestUpdate(CONTINUED_OLD, CONTINUED_OLD.replace('lastFullRaiseIncrement, 2);', 'lastFullRaiseIncrement, 18);')).eligible, false);
});

test('regression: legitimate edits after template continuations stay eligible (contexts line up)', () => {
  const r = analyzeTestUpdate(CONTINUED_OLD, CONTINUED_OLD.replace('assert.equal(other(), 3);', 'assert.equal(other(), 4);'));
  assert.equal(r.eligible, true, r.why ?? '');
});

test('line-count consistency: lexLines returns one start and one end entry per physical line, or is not ok', () => {
  const inputs = [
    '', '\n', 'a\n', 'const t = `x\\\ny\\\nz`;\n', 'const t = `x\\\n${ 1 }\\\n`;\nconst u = 1;\n',
    'const r = /a\\\nb/;\n', 'const r = /[a\\\n]/;\n', "const s = 'a\\\nb';\n", '/* a\n b */\nx;\n', CONTINUED_OLD, OLD,
  ];
  for (const text of inputs) {
    const l = lexLines(text);
    const lines = text.split('\n').length;
    if (l.ok) {
      assert.equal(l.codeAtStart.length, lines, JSON.stringify(text));
      assert.equal(l.codeAtEnd.length, lines, JSON.stringify(text));
    }
  }
  // A backslash-newline inside a regex literal or class is not a continuation: the file is rejected.
  assert.equal(lexLines('const r = /a\\\nb/;\n').ok, false);
  assert.equal(lexLines('const r = /[a\\\n]/;\n').ok, false);
});

test('lexer: line terminators other than \\n (lone CR, U+2028, U+2029) make a file ineligible', () => {
  for (const t of ['\r', ' ', ' ']) {
    const text = OLD.replace('assert.equal(s.currentBet, 20);', `assert.equal(s.currentBet, 20); //${t}process.exit(0)`);
    assert.equal(lexLines(text).ok, false, JSON.stringify(t));
  }
  assert.equal(lexLines('a;\r\nb;\r\n').ok, true, 'CRLF files still lex');
});

test('weakening check: computed, optional, aliased, escaped and dynamic routes to the process are flagged', async () => {
  const { testWeakening } = await import('../src/policy.ts');
  const flagged = (line: string) => testWeakening('test/a.test.js', [line], false).length > 0;
  for (const line of [
    "process['exit'](0);", "process?.['exit'](0);", 'process?.exit(0);', "globalThis['process']['exit'](0);", "global['pro' + 'cess'].exit(0);",
    'self.process.exit();', "Reflect.get(process, 'exit')(0);", "Reflect.get(globalThis, 'process').exit(0);", 'const p = process; p.exit(0);',
    'const { exit } = process;', '\\u0070rocess.exit(0);', 'pro\\u0063ess.exit(0);', "[].constructor.constructor('return process')()()",
    "eval('process.exit(0)');", "new Function('process.exit(0)')();", "Function('return process')().exit(0);",
    "import('node:process').then((p) => p.exit(0));", "import p from 'node:process';", "const vm = require('vm');", "import { execSync } from 'node:child_process';",
    `x = ${COMPUTED_EXIT};`,
  ]) assert.equal(flagged(line), true, line);
  for (const line of [
    "assert.equal(process.env.SEED, undefined);", "test('process the queue', () => {});", "assert.equal(card, '\\u2660');",
    'const half = 4 / 2;', "import { applyAction } from '../src/apply-action.ts';", 'assert.equal(s.lastFullRaiseIncrement, 18);',
  ]) assert.equal(flagged(line), false, line);
});

test('regression e2e: the two-continuation bypass with computed process access blocks for a human, even with authorization', async () => {
  const reviewer = new Reviewer();
  const e = makeEnv({
    secondReviewer: reviewer, project: { autoMerge: true, protectTests: true }, config: { secondReview: { enabled: true } },
    behaviors: { coding: async (spec) => {
      writeFileSync(join(spec.cwd, TEST_PATH), CONTINUED_BYPASS);
      writeFileSync(join(spec.cwd, 'CHANGES.md'), 'x\n');
      return { structured: { status: 'completed', summary: 'done', filesChanged: [TEST_PATH], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
  seedMain(e.repo, { [TEST_PATH]: CONTINUED_OLD });
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 2);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.integrityInputs.length, 0);
  assert.equal(event(e, 'policy.test_update_deferred'), false);
  const pr = job(e, t.identifier).pr_number;
  assert.ok(pr == null || !(await merged(e, t)), 'nothing merged');
});

// ---------------------------------------------------------------- regex after if (...) (review of d7b1b53)

import { v8CodeAtBoundaries } from '../src/test-updates.ts';
import { spawnSync } from 'node:child_process';

/** Reproduction: `if (s) /`/.test(...)` is a regex, but the old heuristic read the '/' after ')' as a division, so the
 *  backtick inside it opened a "template" and every later template boundary was read inverted. The fixture line then
 *  looked like top-level code while JavaScript sees it inside a template literal. */
const REGEX_OLD = `import { test } from 'node:test';
import assert from 'node:assert/strict';

const s = { lastFullRaiseIncrement: 2 };
if (s) /\`/.test('x');

const fixture = \`
  assert.equal(s.lastFullRaiseIncrement, 2);
\`;
// \` keeps the misreading lexer balanced

test('real check', () => {
  assert.equal(1 + 1, 3);
});
`;
const ASSERT_PATCH = `'\`+(assert["equal"] = () => {})+\`'`;
const REGEX_BYPASS = REGEX_OLD.replace('lastFullRaiseIncrement, 2);', `lastFullRaiseIncrement, ${ASSERT_PATCH});`);
const FIXTURE_LINE = REGEX_OLD.split('\n').indexOf('  assert.equal(s.lastFullRaiseIncrement, 2);');

test('reproduction (regex after if): when node runs it, the "expected-value update" makes a failing assertion pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regex-bypass-'));
  const run = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    return spawnSync(process.execPath, ['--test', join(dir, name)], { encoding: 'utf8', env: childEnv, timeout: 60_000 }).status;
  };
  assert.notEqual(run('old.test.mjs', REGEX_OLD), 0, 'the original real check fails');
  assert.equal(run('new.test.mjs', REGEX_BYPASS), 0, 'after the edit, assert.equal is replaced and the failing check passes');
  assert.equal(isLiteral(ASSERT_PATCH), true, 'line patterns alone would accept the payload');
});

test('regression (regex after if): the edit is ineligible', () => {
  const r = analyzeTestUpdate(REGEX_OLD, REGEX_BYPASS, 'test/apply-action.test.js');
  assert.equal(r.eligible, false);
  assert.match(String(r.why), new RegExp(`line ${FIXTURE_LINE + 1}: `));
});

test('regression (regex after if): the lexer resolves `)` by its opener, so it now reads the regex and the template correctly', () => {
  const l = lexLines(REGEX_OLD);
  assert.equal(l.ok, true);
  assert.equal(l.codeAtStart[FIXTURE_LINE], false, 'the fixture line is inside the template');
  assert.equal(l.codeAtEnd[FIXTURE_LINE], false);
  assert.equal(l.codeAtStart[REGEX_OLD.split('\n').indexOf("test('real check', () => {")], true);
});

test('regression (regex after if): V8 independently reads the fixture line as template text, not code', () => {
  for (const text of [REGEX_OLD, REGEX_BYPASS]) {
    const v = v8CodeAtBoundaries(text, false, [FIXTURE_LINE, FIXTURE_LINE + 1, FIXTURE_LINE + 3]);
    assert.deepEqual(v, { ok: true, code: [false, false, true] });
  }
});

test('V8 cross-check contract: boundaries inside templates and block comments are not code; unparsable files are not ok', () => {
  const src = 'const t = `\nassert.equal(a, 1);\n`;\n';
  assert.deepEqual(v8CodeAtBoundaries(src, false, [0, 1, 2, 3]), { ok: true, code: [true, false, false, true] });
  // Inside a block comment too, and in TypeScript after type stripping.
  assert.deepEqual(v8CodeAtBoundaries('/*\nx\n*/\nconst n: number = 1;\n', true, [1, 3]), { ok: true, code: [false, true] });
  // Anything V8 cannot parse (or TypeScript that is not erasable) is not ok.
  assert.equal(v8CodeAtBoundaries('const = ;\n', false, [0]).ok, false);
  assert.equal(v8CodeAtBoundaries('enum E { A }\n', true, [0]).ok, false);
});

test('lexer: a "/" whose meaning depends on context it does not track makes the file not ok', () => {
  for (const src of [
    'const o = {} / 2;\n', 'function f() {}\n/re/.test(s);\n', 'const a = b! / 2;\n', 'const a = i++ / 2;\n', 'const a = f<T> / 2;\n',
    'async function g() { await (x) / 2; }\n', 'const of = 4; const h = of / 2;\n', 'const a = x?./re/;\n',
    'const a = 1; <!-- comment\n', 'x = 1;\n--> comment\n',
  ]) assert.equal(lexLines(src).ok, false, src);
});

test('lexer: unambiguous slashes still lex (division after values and non-control parens, regex after operators and keywords)', () => {
  for (const src of [
    'if (x) /re/.test(s);\n', 'while (x) /a`b/.exec(s);\n', 'const a = f(x) / 2 / 1;\n', 'const a = b[0] / 2;\n', 'const a = o.return / 2;\n',
    'const f = (s) => /re/.test(s);\n', 'function g() { return /re/; }\n', 'export default /x/;\n', 'assert.match(msg, /a\\/b/);\n',
    'const a = x != /re/.source;\n', 'const half = total / 2;\n', '#!/usr/bin/env node\nconst a = 1;\n',
  ]) assert.equal(lexLines(src).ok, true, src);
  // The regex after `while (...)` holds a backtick; the line after it is still top-level code.
  assert.deepEqual(lexLines('while (x) /a`b/.exec(s);\nconst y = 1;\n').codeAtStart, [true, true, true]);
});

test('file types: JSX and non-JS files are ineligible; TypeScript is checked after type stripping', () => {
  const update = (t: string) => t.replace('assert.equal(s.lastFullRaiseIncrement, 2);', 'assert.equal(s.lastFullRaiseIncrement, 18);');
  assert.equal(analyzeTestUpdate(OLD, update(OLD), 'test/a.test.tsx').eligible, false);
  assert.equal(analyzeTestUpdate(OLD, update(OLD), 'test/a.test.jsx').eligible, false);
  assert.equal(analyzeTestUpdate(OLD, update(OLD), 'test/a.test.md').eligible, false);
  const TS = OLD.replace('test(', 'const seats: number = 2;\ntest(');
  const r = analyzeTestUpdate(TS, update(TS), 'packages/engine/test/a.test.ts');
  assert.equal(r.eligible, true, r.why ?? '');
  const notErasable = TS.replace('const seats', 'enum E { A }\nconst seats');
  assert.equal(analyzeTestUpdate(notErasable, update(notErasable), 'packages/engine/test/a.test.ts').eligible, false);
});

test('weakening check: computed, chained, compound and reflective assertion replacement is flagged', async () => {
  const { testWeakening } = await import('../src/policy.ts');
  const flagged = (line: string) => testWeakening('test/a.test.js', [line], false).some((r) => r.includes('replaces assertion functions'));
  for (const line of [
    'assert["equal"] = () => {};', "assert['strict']['equal'] = f;", 'assert.strict.equal = f;', 'assert . equal = f;', 'assert.equal ||= f;',
    'assert.equal ??= f;', `x = ${ASSERT_PATCH};`, "Reflect.set(assert, 'equal', f);", 'Object.defineProperties(assert, { equal: { value: f } });',
    "Reflect.defineProperty(assert, 'equal', { value: f });", 'const a = assert;', 'const { equal } = assert;', 'patch(assert);', 't.assert.equal = f;',
  ]) assert.equal(flagged(line), true, line);
  for (const line of [
    'assert.equal(a, 1);', 'assert.equal(x == y, true);', 'assert.ok(a >= b);', "import assert from 'node:assert/strict';",
    'assert.deepEqual(r, { a: 1 });', "assert.equal(s, '=>');", 'assert.strictEqual(f(x), 2);', 'assert.notEqual(a, b);',
  ]) assert.equal(flagged(line), false, line);
});

test('regression e2e: the regex-after-if bypass blocks for a human, even with authorization', async () => {
  const reviewer = new Reviewer();
  const e = makeEnv({
    secondReviewer: reviewer, project: { autoMerge: true, protectTests: true }, config: { secondReview: { enabled: true } },
    behaviors: { coding: async (spec) => {
      writeFileSync(join(spec.cwd, TEST_PATH), REGEX_BYPASS);
      writeFileSync(join(spec.cwd, 'CHANGES.md'), 'x\n');
      return { structured: { status: 'completed', summary: 'done', filesChanged: [TEST_PATH], testsAdded: [], commandsRun: [], decisions: [], knownLimitations: [] } };
    } },
  });
  seedMain(e.repo, { [TEST_PATH]: REGEX_OLD });
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 2);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(reviewer.integrityInputs.length, 0);
  assert.equal(event(e, 'policy.test_update_deferred'), false);
  const pr = job(e, t.identifier).pr_number;
  assert.ok(pr == null || !(await merged(e, t)), 'nothing merged');
});

// ---------------------------------------------------------------- new coverage is visible to the test-integrity review

test('the test-integrity review sees test files the change adds (DEV-57: required coverage lives in a new file)', async () => {
  const reviewer = new Reviewer();
  const e = env(reviewer, () => DEV11, (cwd) => writeFileSync(join(cwd, 'test', 'all-in-raise-coverage.test.js'), "test('a short all-in raise leaves the increment unchanged', () => {});\n"));
  const t = await ticket(e);
  authorize(e, t.id);
  await cycles(e, 4);
  assert.equal(reviewer.integrityInputs.length, 1);
  assert.deepEqual(reviewer.integrityInputs[0]!.newTests.map((x) => x.path), ['test/all-in-raise-coverage.test.js']);
  assert.match(reviewer.integrityInputs[0]!.newTests[0]!.content, /short all-in raise leaves the increment unchanged/);
  assert.ok(!reviewer.integrityInputs[0]!.newTests.some((x) => x.path === TEST_PATH), 'the edited existing test is not listed as new');
});

// ---------------------------------------------------------------- false positives seen on poker (DEV-78, DEV-91)

test('weakening check: a class constructor and escapes inside strings are not flagged; real escapes and constructor chains still are', async () => {
  const { testWeakening } = await import('../src/policy.ts');
  const flagged = (line: string) => testWeakening('test/a.test.js', [line], false).length > 0;
  for (const line of [
    'constructor(url: string) {', // DEV-91: a class's own constructor
    'class FakeSocket { constructor() { this.sent = []; } }',
    "for (const raw of ['A\\tB', 'A\\nB', '\\tAnn', 'Ann\\u0000', 'A\\u007fB']) {", // DEV-78: control characters in strings
    'const s = "caf\\u00e9clair";',
    'const t = `name\\u0000x`;',
  ]) assert.equal(flagged(line), false, line);
  for (const line of [
    "[].constructor.constructor('return process')()().exit(0);",
    "x.constructor('return 1')();",
    "obj['constructor']('x');",
    '\\u0070rocess.exit(0);',
    'pro\\u0063ess.exit(0);',
    'const p = \\u{70}rocess;',
    "const s = 'safe' + \\u0070rocess.argv;",
  ]) assert.equal(flagged(line), true, line);
});

test('regression (review of ee02fc1): ${…} code and quotes inside regexes cannot hide an escaped identifier', async () => {
  const { testWeakening, withoutStringContents } = await import('../src/policy.ts');
  const flagged = (line: string) => testWeakening('test/a.test.js', [line], false).length > 0;
  // Template interpolations are executable code, kept as written (including nested templates and strings).
  for (const line of [
    '`${\\u0070rocess.exit(0)}`;',
    'const s = `x${ "a" + \\u0070rocess.argv }y`;',
    'const s = `a${`b${\\u0070rocess}`}`;',
  ]) assert.equal(flagged(line), true, line);
  // A quote inside a regex literal must not open a "string" that swallows code: any '/' in code is ambiguous, so the
  // raw line is checked.
  for (const line of [
    "/'/.test(s) || \\u0070rocess.exit(0); //'",
    'const r = /"/; \\u0070rocess.exit(0); // "',
  ]) assert.equal(flagged(line), true, line);
  assert.equal(withoutStringContents("/'/.test(s)"), null, 'ambiguous slash → no exemption');
  assert.equal(withoutStringContents('const t = `open'), null, 'unterminated template → no exemption');
  assert.equal(withoutStringContents("x('a\\u0000', `t${y}u`)"), "x('', `${y}`)", 'only literal data is blanked');
  // Proven string data stays exempt.
  for (const line of ["for (const raw of ['A\\tB', 'Ann\\u0000', 'A\\u007fB']) {", 'const t = `n ${x} \\u0000`;']) assert.equal(flagged(line), false, line);
});

test('regression: closing a multiline literal cannot hide executable escapes from the weakening check', async () => {
  const { testWeakening } = await import('../src/policy.ts');
  for (const source of [
    'const first = `hello\n`; \\u0070rocess.exit(0); const second = `\nworld`;\n',
    "const first = 'hello\\\n'; \\u0070rocess.exit(0); const second = '\\\nworld';\n",
  ]) {
    const lines = source.trimEnd().split('\n');
    assert.ok(testWeakening('test/new.test.js', lines, false).some(r => /reaches the process/.test(r)));
    assert.ok(testWeakening('test/new.test.js', lines, false, source).some(r => /reaches the process/.test(r)));
    // An existing diff can contain just the closing line; its surrounding source must still be inspected.
    assert.ok(testWeakening('test/existing.test.js', [lines[1]], true, source).some(r => /reaches the process/.test(r)));
  }
});

test('full-source string exemptions preserve ordinary Unicode test data and fail closed on ambiguous source', async () => {
  const { testWeakening } = await import('../src/policy.ts');
  const line = "const input = 'Ann\\u0000';";
  const source = `// A control-character fixture\n${line}\n`;
  assert.deepEqual(testWeakening('test/new.test.js', source.trimEnd().split('\n'), false, source), []);
  const invalid = `${source}const broken = ;\n`;
  assert.ok(testWeakening('test/new.test.js', [line], false, invalid).some(r => /reaches the process/.test(r)));
});

test('e2e: a new test cannot hide an escaped early exit between multiline templates', async () => {
  const e = makeEnv({ project: { protectTests: true }, behaviors: { coding: async s => {
    writeFileSync(join(s.cwd, 'CHANGES.md'), 'implementation\n');
    mkdirSync(join(s.cwd, 'test'), { recursive: true });
    writeFileSync(join(s.cwd, 'test/hidden.test.js'), 'const first = `hello\n`; \\u0070rocess.exit(0); const second = `\nworld`;\n');
    return {};
  } } });
  const t = await e.tracker.createTicket({ projectKey: 'demo', title: 'Feature', description: 'Do it.', status: 'ready', priority: 2 });
  await cycles(e, 2);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /reaches the process/);
  assert.equal(job(e, t.identifier).pr_number, null);
});
