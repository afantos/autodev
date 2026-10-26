import type { CheckResult } from './types.ts';

/**
 * Flaky-CI handling. When a PR's required CI fails only in test files the PR did not touch, the failure may be an
 * intermittent test the agent cannot fix, or a real regression caught by an existing test. The pipeline re-runs the failed
 * jobs once per candidate. If they fail again, that is evidence of a deterministic failure: the agent is told so neutrally,
 * and the failure is called likely pre-existing only when the same tests also fail on the base branch's latest CI.
 */

const TEST_AT = /^\s*test at (.+?):\d+:\d+\s*$/;
const SECTION = /^===== (.+) =====$/;

/** Test files named by node:test's `test at <file>:<line>:<col>` lines, normalized and de-duplicated, in order. */
export function failingTestFiles(excerpt: string): string[] {
  const files: string[] = [];
  for (const line of excerpt.split('\n')) {
    const m = TEST_AT.exec(line);
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\//, '').replace(/^\.\//, '');
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * The failing test files of a CI failure, or null unless every failing check's log names at least one (a check without
 * logs, or one that failed on lint or a build step, may be a real failure the files do not explain).
 */
export function failingTestFilesOfChecks(checks: CheckResult): string[] | null {
  if (checks.state !== 'failure' || !checks.failures.length) return null;
  // GitHubScm prefixes each failing job's excerpt with "===== <check name> ====="; LocalScm reports one unlabelled check.
  const sections = new Map<string, string[]>();
  let current: string | null = checks.failures.length === 1 ? checks.failures[0]!.name : null;
  for (const line of checks.logExcerpt.split('\n')) {
    const header = SECTION.exec(line);
    if (header) { current = header[1]!; continue; }
    if (current === null) continue;
    sections.set(current, [...(sections.get(current) ?? []), line]);
  }
  const files: string[] = [];
  for (const f of checks.failures) {
    const named = failingTestFiles((sections.get(f.name) ?? []).join('\n'));
    if (!named.length) return null;
    for (const file of named) if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** True if `file` (relative, or an absolute runner path such as /home/runner/work/r/r/test/x.ts) is one of `changed`. */
export function inDiff(file: string, changed: string[]): boolean {
  return changed.some((c) => file === c || file.endsWith(`/${c}`));
}

/** Feedback note for a failure confined to tests outside the diff (`rerun`: the failed jobs were re-run and failed again). */
export function outsideDiffNote(files: string[], rerun: boolean): string {
  return `Note from the orchestrator: every failing test is in a file this change does not touch (${files.map((f) => `\`${f}\``).join(', ')})` +
    (rerun ? ', and it failed again when the failed CI jobs were re-run on this commit.' : '.') +
    ` These tests are not in your diff but may test code you changed: find out whether your change causes the failure and ` +
    `fix your code if so. Do not weaken or skip those tests to make CI pass.`;
}

/** Feedback note when the same tests also fail on the base branch's latest CI: likely pre-existing (flaky or broken on base). */
export function baseFailsNote(files: string[], base: string): string {
  return `Note from the orchestrator: every failing test is in a file this change does not touch (${files.map((f) => `\`${f}\``).join(', ')}), ` +
    `it failed again when the failed CI jobs were re-run on this commit, and the same tests also fail on the latest CI run of ` +
    `\`${base}\`. The failure likely predates this change (flaky or broken on ${base}). Do not edit unrelated code or weaken ` +
    `those tests to make CI pass; only change your own code if it can plausibly affect them, and otherwise explain it in knownLimitations.`;
}
