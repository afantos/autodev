import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanCiLog, collapseRepeats, excerptCiLog } from '../src/ci-log.ts';

// 2026-10-26 (luckywinclub LWC-29): the agent received the last 5,000 characters of the integration job log, which were
// all Postgres container output from `docker compose logs`; the node:test failure report sat just above. It blocked
// asking for the failing test. This fixture is that real job log (Compose + node:test, GitHub timestamps, ANSI).
const REAL = readFileSync(new URL('./fixtures/ci-compose-node-test.log', import.meta.url), 'utf8');

test('real mixed log: the excerpt carries the node:test failure report, not Compose service output', () => {
  const old = REAL.slice(-5000);
  assert.doesNotMatch(old, /failing tests:/, 'the old tail really missed it (fixture sanity)');
  const ex = excerptCiLog(REAL, 5000);
  assert.ok(ex.length <= 5000);
  assert.match(ex, /✖ failing tests:/);
  assert.match(ex, /test at test-integration\/entry-concurrency\.test\.ts:1:1/);
  assert.match(ex, /generated asynchronous activity after the test ended/, 'the hook error reported above the summary is kept');
  assert.match(ex, /terminating connection due to administrator command/);
  assert.doesNotMatch(ex, /postgres-1\s+\|/);
  assert.doesNotMatch(ex, /mailpit-1\s+\|/);
  assert.doesNotMatch(ex, /^\d{4}-\d{2}-\d{2}T/m, 'timestamps stripped');
  assert.doesNotMatch(ex, /\x1b\[|\^\[\[/, 'ANSI stripped');
});

test('cleanCiLog drops Compose service lines, group markers, timestamps and ANSI', () => {
  const raw = [
    '﻿2026-10-26T16:23:34.3741507Z ##[group]Run npm test',
    '2026-10-26T16:23:34.3741713Z \x1b[36;1mnpm test\x1b[0m',
    '2026-10-26T16:23:40.0000000Z postgres-1  | LOG:  checkpoint starting',
    '2026-10-26T16:23:40.0000000Z web-12 | listening on 3000',
    '2026-10-26T16:23:41.0000000Z ✔ a test (1ms)',
    '2026-10-26T16:23:42.0000000Z ##[endgroup]',
  ].join('\n');
  assert.deepEqual(cleanCiLog(raw), ['npm test', '✔ a test (1ms)']);
});

test('without a node:test summary, windows after failure markers are kept and merged', () => {
  const lines = [...Array(100)].map((_, i) => `noise ${i}`);
  lines[40] = 'not ok 3 - widget renders';
  lines[42] = '  AssertionError [ERR_ASSERTION]: Expected 1 to equal 2';
  lines[90] = 'npm ERR! code ELIFECYCLE';
  const ex = excerptCiLog(lines.join('\n'), 5000, 5);
  assert.match(ex, /not ok 3 - widget renders[\s\S]*AssertionError/);
  assert.match(ex, /npm ERR! code ELIFECYCLE/);
  assert.doesNotMatch(ex, /noise 10\b/);
  assert.equal((ex.match(/…/g) ?? []).length, 1, 'two windows, the overlapping markers merged into one');
});

test('without any marker the excerpt is a bounded tail of the cleaned log', () => {
  const raw = [...Array(2000)].map((_, i) => `line ${i}`).join('\n');
  const ex = excerptCiLog(raw, 500);
  assert.ok(ex.length <= 500);
  assert.match(ex, /line 1999$/);
  assert.match(ex, /^… \(start omitted\)/);
});

test('the excerpt never exceeds the limit, even with a huge failure summary', () => {
  const raw = ['✖ failing tests:', ...[...Array(5000)].map((_, i) => `test at x.test.ts:${i}:1`)].join('\n');
  const ex = excerptCiLog(raw, 1000);
  assert.ok(ex.length <= 1000); assert.match(ex, /^✖ failing tests:/); assert.match(ex, /truncated\)$/);
});

test('real log with an assertion failure: the excerpt is the summary through ##[error], without post-job runner noise', () => {
  const raw = readFileSync(new URL('./fixtures/ci-node-test-assertion.log', import.meta.url), 'utf8');
  const ex = excerptCiLog(raw, 5000);
  assert.match(ex, /test at test-integration\/claims-deadline-dst\.test\.ts:26:3/);
  assert.match(ex, /AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal/);
  assert.match(ex, /expected: 'America\/New_York'/);
  assert.match(ex, /##\[error\]Process completed with exit code 1\.$/);
  assert.doesNotMatch(ex, /Post job cleanup|safe\.directory|Cleaning up orphan processes/);
});

test('real log with 11 repeated hook errors above the summary (LWC-27): the cause survives the budget', () => {
  const raw = readFileSync(new URL('./fixtures/ci-hook-error-repeated.log', import.meta.url), 'utf8');
  const ex = excerptCiLog(raw, 5000);
  assert.ok(ex.length <= 5000);
  assert.match(ex, /Test hook "before" at test-integration\/entry-concurrency\.test\.ts:11:3/);
  assert.match(ex, /terminating connection due to administrator command/);
  assert.match(ex, /repeated \d+×/);
  assert.match(ex, /✖ failing tests:/);
  assert.ok(ex.length > 600, `a useful excerpt, not just the summary (${ex.length} chars)`);
});

test('collapseRepeats folds repeated lines and repeated blocks, ignoring durations', () => {
  assert.deepEqual(collapseRepeats(['a', 'b', 'b', 'b', 'c']), ['a', 'b', '… (the line above repeated 3×)', 'c']);
  assert.deepEqual(collapseRepeats(['x (1ms)', 'y', 'x (2ms)', 'y', 'z']), ['x (1ms)', 'y', '… (the 2 lines above repeated 2×)', 'z']);
  assert.deepEqual(collapseRepeats(['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('over budget, the windows nearest the summary are kept and earlier ones dropped', () => {
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push(`not ok ${i} - early failure ${i}`, ...[...Array(5)].map((_, j) => `detail ${i}.${j} ${'x'.repeat(40)}`), ...[...Array(30)].map((_, j) => `filler ${i}.${j}`));
  lines.push('AssertionError: the real cause', '✖ failing tests:', 'test at a.test.ts:1:1');
  const ex = excerptCiLog(lines.join('\n'), 2000, 3);
  assert.ok(ex.length <= 2000);
  assert.match(ex, /AssertionError: the real cause/);
  assert.match(ex, /✖ failing tests:/);
  assert.doesNotMatch(ex, /early failure 0\b/, 'the oldest windows are the ones dropped');
});
