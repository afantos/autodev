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

// DEV-204: the label lookup ignored the team, so a same-named label owned by another team (for example LWC's
// `autodev`) could be picked, and Linear refused the issue: "labelIds for incorrect team".
function labelTracker(labels: { id: string; team: { id: string } | null }[]) {
  const { t, calls } = tracker();
  t.gql = (async (query: string, variables: Record<string, unknown> = {}) => {
    calls.push({ query, variables });
    if (query.includes('issueLabels')) {
      return { issueLabels: { nodes: labels.filter((l) => !l.team || l.team.id === variables.t) } };
    }
    if (query.includes('issueLabelCreate')) return { issueLabelCreate: { issueLabel: { id: 'created' } } };
    throw new Error(`unexpected query: ${query.slice(0, 60)}`);
  }) as LinearTracker['gql'];
  return { t, calls, labelId: (team: string, name: string) => (t as unknown as { labelId(a: string, b: string): Promise<string> }).labelId(team, name) };
}

test('label lookup is scoped to the team and never returns another team\'s label', async () => {
  const { labelId, calls } = labelTracker([{ id: 'lwc-autodev', team: { id: 'LWC' } }, { id: 'dev-autodev', team: { id: 'DEV' } }]);
  assert.equal(await labelId('DEV', 'autodev'), 'dev-autodev');
  const q = calls.find((c) => c.query.includes('issueLabels'))!;
  assert.deepEqual(declaredButUnused(q.query), []);
  assert.equal(q.variables.t, 'DEV');
});

test('label lookup prefers the team\'s label over a workspace label of the same name', async () => {
  const { labelId } = labelTracker([{ id: 'workspace', team: null }, { id: 'dev-label', team: { id: 'DEV' } }]);
  assert.equal(await labelId('DEV', 'autodev'), 'dev-label');
});

test('label lookup falls back to a workspace label, and creates a team label only when neither exists', async () => {
  const ws = labelTracker([{ id: 'workspace', team: null }, { id: 'lwc', team: { id: 'LWC' } }]);
  assert.equal(await ws.labelId('DEV', 'autodev'), 'workspace');
  const none = labelTracker([{ id: 'lwc', team: { id: 'LWC' } }]);
  assert.equal(await none.labelId('DEV', 'autodev'), 'created');
  const create = none.calls.find((c) => c.query.includes('issueLabelCreate'))!;
  assert.deepEqual(create.variables, { i: { name: 'autodev', teamId: 'DEV' } });
});
