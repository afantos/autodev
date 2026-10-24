import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LinearTracker } from '../src/tracker/linear.ts';

// Linear's GraphQL API rejects operations that declare variables they never use ("Variable "$s" is never used").
// That once failed `autodev plan`, which lists a project's tickets without a status filter.

function declaredButUnused(query: string): string[] {
  const header = /^\s*(?:query|mutation)\s*\(([^)]*)\)/.exec(query)?.[1] ?? '';
  const body = query.slice(query.indexOf(')') + 1);
  return [...header.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]!).filter((name) => !new RegExp(`\\$${name}\\b`).test(body));
}

function tracker() {
  const root = mkdtempSync(join(tmpdir(), 'linear-q-'));
  const cfg = parseConfig({ tracker: 'linear', scm: 'local', runner: 'fake', dataDir: join(root, 'data'), workspaceDir: join(root, 'work'),
    projects: [{ key: 'poker', repo: 'o/poker', linear: { teamKey: 'DEV' } }], sandbox: { enabled: false } }, root);
  const t = new LinearTracker(cfg, 'test-key');
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  t.gql = (async (query: string, variables: Record<string, unknown> = {}) => {
    calls.push({ query, variables });
    return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: '' } } };
  }) as LinearTracker['gql'];
  return { t, calls };
}

test('the checker itself flags a declared-but-unused variable', () => {
  assert.deepEqual(declaredButUnused('query($k:String!, $s:[String!]){ issues(filter:{ key:$k }){ nodes { id } } }'), ['s']);
  assert.deepEqual(declaredButUnused('query($k:String!){ issues(filter:{ key:$k }){ nodes { id } } }'), []);
});

test('listTickets without a status filter declares no unused variables (planning path)', async () => {
  const { t, calls } = tracker();
  await t.listTickets({ projectKey: 'poker' });
  assert.equal(calls.length, 1);
  assert.deepEqual(declaredButUnused(calls[0]!.query), []);
  assert.equal('s' in calls[0]!.variables, false);
});

test('listTickets with a status filter declares and uses $s', async () => {
  const { t, calls } = tracker();
  await t.listTickets({ statuses: ['ready', 'in_progress'] });
  assert.deepEqual(declaredButUnused(calls[0]!.query), []);
  assert.match(calls[0]!.query, /\$s:\[String!\]/);
  assert.ok(Array.isArray(calls[0]!.variables.s));
});
