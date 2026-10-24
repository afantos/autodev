import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, job } from './helpers.ts';
import { testWeakening } from '../src/policy.ts';

// Project policy: protected paths (humanReviewPaths) and test weakening (protectTests) go to a human.
const ticket = (e: ReturnType<typeof makeEnv>) => e.tracker.createTicket({ projectKey: 'demo', title: 'Policy ticket', description: '', status: 'ready', priority: 2 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** Adds files to the demo repo's main branch before any job starts. */
function seedMain(repo: string, files: Record<string, string>) {
  if (!Object.keys(files).length) return;
  const dir = mkdtempSync(join(tmpdir(), 'seed-'));
  git(dir, 'clone', '-q', repo, '.');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  git(dir, 'push', '-q', 'origin', 'HEAD:main');
}

const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const TEST_SRC = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => {\n  assert.equal(1 + 1, 2);\n});\n";

function env(project: Record<string, unknown>, edit: (cwd: string) => void) {
  return makeEnv({ project, behaviors: { coding: async (s) => { edit(s.cwd); writeFileSync(join(s.cwd, 'CHANGES.md'), 'done'); return {}; } } });
}

test('a change to a configured protected path blocks for human review', async () => {
  const e = env({ humanReviewPaths: ['^eslint-rules/', '^eslint\\.config\\.js$'] }, (cwd) => {
    mkdirSync(join(cwd, 'eslint-rules'), { recursive: true });
    writeFileSync(join(cwd, 'eslint-rules', 'boundaries.js'), 'export default {};\n');
  });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /eslint-rules\/boundaries\.js: protected path/);
});

test('changes outside protected paths are unaffected', async () => {
  const e = env({ humanReviewPaths: ['^eslint-rules/'], protectTests: true }, (cwd) => {
    writeFileSync(join(cwd, 'src', 'index.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
    mkdirSync(join(cwd, 'test'), { recursive: true });
    writeFileSync(join(cwd, 'test', 'sub.test.js'), "import assert from 'node:assert/strict';\nassert.equal(2 - 1, 1);\n");
  });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', job(e, t.identifier).blocked_reason ?? job(e, t.identifier).error);
});

test('removing or changing an existing assertion blocks when protectTests is on', async () => {
  const e = env({ protectTests: true }, (cwd) => writeFileSync(join(cwd, 'test', 'add.test.js'), TEST_SRC.replace("  assert.equal(1 + 1, 2);\n", '')));
  seedMain(e.repo, { 'test/add.test.js': TEST_SRC });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /test\/add\.test\.js: existing test file changed/);
});

for (const [name, replacement] of [
  ['test.skip', "test.skip('adds', () => {"],
  ['skip option', "test('adds', { skip: true }, () => {"],
  ['test.only', "test.only('adds', () => {"],
] as const) {
  test(`newly skipping or focusing a test blocks when protectTests is on: ${name}`, async () => {
    const e = env({ protectTests: true }, (cwd) => writeFileSync(join(cwd, 'test', 'add.test.js'), `${TEST_SRC}\n${replacement}\n  assert.ok(true);\n});\n`));
    seedMain(e.repo, { 'test/add.test.js': TEST_SRC });
    const t = await ticket(e); await e.cycle();
    assert.equal(job(e, t.identifier).status, 'blocked');
    assert.match(job(e, t.identifier).blocked_reason, /added test code (skips, focuses|sets a skip\/only\/todo)/);
  });
}

test('without protectTests, removing an assertion is left to the review agent', async () => {
  const e = env({}, (cwd) => writeFileSync(join(cwd, 'test', 'add.test.js'), TEST_SRC.replace("  assert.equal(1 + 1, 2);\n", '')));
  seedMain(e.repo, { 'test/add.test.js': TEST_SRC });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', job(e, t.identifier).blocked_reason ?? job(e, t.identifier).error);
});

test('a removed SQL comment line starting with "-- " is not mistaken for a file header', async () => {
  const e = env({ protectTests: true, humanReviewPaths: ['^protected/'] }, (cwd) => writeFileSync(join(cwd, 'src', 'q.sql'), 'select 1;\n'));
  seedMain(e.repo, { 'src/q.sql': '-- a/protected/x\nselect 1;\n' });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', job(e, t.identifier).blocked_reason ?? job(e, t.identifier).error);
});

// ---------------------------------------------------------------- reproduced gaps (review 2026-10-24)

const MULTILINE = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('deck is full', () => {\n  assert.ok(\n    deck.length === 52,\n  );\n});\n";

async function blockedWith(project: Record<string, unknown>, base: Record<string, string>, edit: (cwd: string) => void, reason: RegExp) {
  const e = env(project, edit);
  seedMain(e.repo, base);
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked', `expected a block matching ${reason}`);
  assert.match(job(e, t.identifier).blocked_reason, reason);
}

test('gap: replacing the argument of an unchanged multiline assert.ok( with true blocks', () =>
  blockedWith({ protectTests: true }, { 'test/deck.test.js': MULTILINE },
    (cwd) => writeFileSync(join(cwd, 'test', 'deck.test.js'), MULTILINE.replace('deck.length === 52', 'true')),
    /existing test file changed/));

test('gap: a new test with { skip: 1 === 1 } blocks', () =>
  blockedWith({ protectTests: true }, { 'test/deck.test.js': MULTILINE },
    (cwd) => writeFileSync(join(cwd, 'test', 'deck.test.js'), `${MULTILINE}\ntest('later', { skip: 1 === 1 }, () => {\n  assert.ok(false);\n});\n`),
    /sets a skip\/only\/todo test option/));

test('gap: an early return inserted inside an existing test blocks', () =>
  blockedWith({ protectTests: true }, { 'test/deck.test.js': MULTILINE },
    (cwd) => writeFileSync(join(cwd, 'test', 'deck.test.js'), MULTILINE.replace("test('deck is full', () => {\n", "test('deck is full', () => {\n  return;\n")),
    /existing test file changed/));

test('gap: process.exit appended to a test file blocks', () =>
  blockedWith({ protectTests: true }, { 'test/deck.test.js': MULTILINE },
    (cwd) => writeFileSync(join(cwd, 'test', 'deck.test.js'), `${MULTILINE}process.exit(0);\n`),
    /can end the test process early/));

test('gap: replacing an assertion function blocks, even in a new test file', () =>
  blockedWith({ protectTests: true }, {},
    (cwd) => { mkdirSync(join(cwd, 'test'), { recursive: true }); writeFileSync(join(cwd, 'test', 'setup.test.js'), "import assert from 'node:assert/strict';\nassert.equal = () => {};\n"); },
    /replaces assertion functions/));

test('gap: changing a test script in package.json blocks without any project configuration', () =>
  blockedWith({}, { 'package.json': '{"name":"demo","scripts":{"test":"node --test"}}\n' },
    (cwd) => writeFileSync(join(cwd, 'package.json'), '{"name":"demo","scripts":{"test":"node --test --test-name-pattern=^$"}}\n'),
    /package\.json: manifest changed beyond approved dependencies/));

test('gap: workspace manifests are protected by humanReviewPaths', () =>
  blockedWith({ humanReviewPaths: ['(^|/)package\\.json$'] }, { 'packages/engine/package.json': '{"name":"@x/engine","scripts":{"test":"node --test"}}\n' },
    (cwd) => writeFileSync(join(cwd, 'packages', 'engine', 'package.json'), '{"name":"@x/engine","scripts":{"test":"true"}}\n'),
    /packages\/engine\/package\.json: (protected path|manifest changed)/));

test('gap: a block comment opened in the header and closed at EOF blocks (assertions would silently never run)', async () => {
  const failing = TEST_SRC.replace('assert.equal(1 + 1, 2)', 'assert.equal(1 + 1, 3)');
  const commented = failing.replace("test('adds'", "/*\ntest('adds'") + '*/\n';
  // The bypass is real: with the failing test commented out, Node exits 0 (execFileSync would throw otherwise).
  const dir = mkdtempSync(join(tmpdir(), 'bypass-'));
  writeFileSync(join(dir, 'add.test.mjs'), failing);
  assert.throws(() => execFileSync(process.execPath, ['--test', join(dir, 'add.test.mjs')], { stdio: 'ignore', env: childEnv }), 'the uncommented failing test must fail');
  writeFileSync(join(dir, 'add.test.mjs'), commented);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--test', join(dir, 'add.test.mjs')], { stdio: 'ignore', env: childEnv }));
  await blockedWith({ protectTests: true }, { 'test/add.test.js': TEST_SRC },
    // Exactly the reproduced edit: only `/*` inserted in the header and `*/` appended at EOF.
    (cwd) => writeFileSync(join(cwd, 'test', 'add.test.js'), TEST_SRC.replace("test('adds'", "/*\ntest('adds'") + '*/\n'),
    /test\/add\.test\.js: existing test file changed/);
});

test('conservative: even an appended test or a new import in an existing test file needs review', () =>
  blockedWith({ protectTests: true }, { 'test/deck.test.js': MULTILINE },
    (cwd) => writeFileSync(join(cwd, 'test', 'deck.test.js'),
      MULTILINE.replace("import assert from 'node:assert/strict';\n", "import assert from 'node:assert/strict';\nimport { Deck } from '../src/deck.js';\n") +
      "\ntest('draws one', () => {\n  assert.equal(new Deck().draw(1).length, 1);\n});\n"),
    /test\/deck\.test\.js: existing test file changed/));

test('allowed: new tests in a new test file, next to an unchanged existing one', async () => {
  const e = env({ protectTests: true }, (cwd) => writeFileSync(join(cwd, 'test', 'draw.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('draws one', () => {\n  assert.equal([1].slice(0, 1).length, 1);\n});\n"));
  seedMain(e.repo, { 'test/deck.test.js': MULTILINE });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', job(e, t.identifier).blocked_reason ?? job(e, t.identifier).error);
});

test('allowed: an approved dependency added to package.json passes the manifest check', async () => {
  const e = env({ approvedDependencies: ['left-pad'] }, (cwd) => writeFileSync(join(cwd, 'package.json'), '{"name":"demo","scripts":{"test":"node --test"},"dependencies":{"left-pad":"1.3.0"}}\n'));
  seedMain(e.repo, { 'package.json': '{"name":"demo","scripts":{"test":"node --test"}}\n' });
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'awaiting_merge', job(e, t.identifier).blocked_reason ?? job(e, t.identifier).error);
});

test('testWeakening: every change to an existing test file is flagged; new files are only pattern-scanned', () => {
  const old = "import a from 'a';\n\ntest('x', () => {\n  a();\n});\n";
  const changed = ['t.test.js: existing test file changed'];
  assert.deepEqual(testWeakening('t.test.js', ['@@ -1,0 +2,1 @@', '+/*'], old), changed, 'insertion in the header');
  assert.deepEqual(testWeakening('t.test.js', ['@@ -5,0 +6,1 @@', '+*/'], old), changed, 'insertion at EOF');
  assert.deepEqual(testWeakening('t.test.js', ['@@ -3,0 +4,1 @@', '+  return;'], old), changed, 'insertion inside a test');
  assert.deepEqual(testWeakening('t.test.js', ['@@ -4 +4 @@', '-  a();', '+  a(true);'], old), changed, 'line edit');
  assert.deepEqual(testWeakening('t.test.js', ['@@ -4 +3,0 @@', '-  a();'], old), changed, 'line removal');
  assert.deepEqual(testWeakening('new.test.js', ['@@ -0,0 +1,1 @@', "+test('ok', () => {});"], null), [], 'clean new file');
  assert.deepEqual(testWeakening('new.test.js', ['@@ -0,0 +1,2 @@', "+test('ok', () => {});", "+test.todo('later');"], null), ['new.test.js: added test code skips, focuses or marks a test todo']);
});
