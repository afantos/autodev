import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, job } from './helpers.ts';

// Project policy: protected paths (humanReviewPaths) and test weakening (protectTests) go to a human.
const ticket = (e: ReturnType<typeof makeEnv>) => e.tracker.createTicket({ projectKey: 'demo', title: 'Policy ticket', description: '', status: 'ready', priority: 2 });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** Adds files to the demo repo's main branch before any job starts. */
function seedMain(repo: string, files: Record<string, string>) {
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
  assert.match(job(e, t.identifier).blocked_reason, /test\/add\.test\.js: test assertion or test case removed or changed/);
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
    assert.match(job(e, t.identifier).blocked_reason, /test skipped, focused or marked todo/);
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
