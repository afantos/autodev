import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeEnv, job } from './helpers.ts';
import { DEFAULTS } from '../src/agents/fake.ts';
import { createCtx } from '../src/context.ts';
import { UnsafePushError } from '../src/secrets.ts';
import { scanSecrets } from '../src/secrets.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const ticket = (e: ReturnType<typeof makeEnv>, title = 'Trusted git') => e.tracker.createTicket({ projectKey: 'demo', title, description: '', status: 'ready', priority: 2 });
const refs = (e: ReturnType<typeof makeEnv>) => git(e.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/autodev/');

const payloads = ['secret', 'dependency policy violation'] as const;
const secretFixture = 'ghp_' + 'PAYLOADPROBE'.repeat(3);

function putPayload(cwd: string, payload: typeof payloads[number]) {
  if (payload === 'secret') writeFileSync(join(cwd, 'credential-fixture.txt'), secretFixture);
  else writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'unapproved-payload-dependency': '1.0.0' } }));
}

function assertPayload(cwd: string, payload: typeof payloads[number], revision: string) {
  if (payload === 'secret') {
    assert.equal(git(cwd, 'show', `${revision}:credential-fixture.txt`), secretFixture);
    assert.deepEqual(scanSecrets(git(cwd, 'show', '--format=', revision)), ['GitHub token']);
  } else assert.equal(JSON.parse(git(cwd, 'show', `${revision}:package.json`)).dependencies['unapproved-payload-dependency'], '1.0.0');
}

for (const target of ['origin/base', 'packed-refs', 'HEAD', 'local branch']) for (const payload of payloads) {
  test(`rewriting ${target} to hide a ${payload} blocks the job and publishes nothing`, async () => {
    const e = makeEnv();
    let initialBase = '';
    let payloadCommit = '';
    e.runner.behaviors.coding = async (s, n) => {
      const rec = e.ctx.ws.verifiedRecord(s.cwd);
      const state = e.ctx.ws.trustedState(s.cwd);
      initialBase = state.base_sha;
      assert.ok(realpathSync(state.git_dir).startsWith(realpathSync(e.ctx.cfg.dataDir)), 'private object store precedes agent execution');
      putPayload(s.cwd, payload);
      git(s.cwd, 'add', '--all');
      payloadCommit = git(s.cwd, 'commit-tree', git(s.cwd, 'write-tree'), '-p', initialBase, '-m', `untrusted ${payload} payload`);
      assertPayload(s.cwd, payload, payloadCommit);
      const cleanTree = git(s.cwd, 'rev-parse', `${initialBase}^{tree}`);
      const mask = git(s.cwd, 'commit-tree', cleanTree, '-p', initialBase, '-m', 'misleading clean candidate');
      if (target === 'origin/base') {
        mkdirSync(join(rec.commonDir, 'refs/remotes/origin'), { recursive: true });
        writeFileSync(join(rec.commonDir, 'refs/remotes/origin/main'), `${payloadCommit}\n`);
      } else if (target === 'packed-refs') {
        assert.equal(existsSync(join(rec.commonDir, 'refs/remotes/origin/main')), false, 'exercise the packed ref rather than a shadowing loose ref');
        writeFileSync(join(rec.commonDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${payloadCommit} refs/remotes/origin/main\n`);
      } else if (target === 'HEAD') writeFileSync(join(rec.gitDir, 'HEAD'), `${mask}\n`);
      else {
        const head = readFileSync(join(rec.gitDir, 'HEAD'), 'utf8').trim().replace('ref: ', '');
        writeFileSync(join(rec.commonDir, head), `${mask}\n`);
      }
      // Prove this fixture actually hides the payload from a mutable-ref range.
      // Baseline rewrites make the offending commit its own comparison point;
      // HEAD/branch rewrites substitute a clean commit while payload files remain.
      const apparentHead = target === 'origin/base' || target === 'packed-refs' ? payloadCommit : 'HEAD';
      assert.equal(git(s.cwd, 'diff', `origin/main...${apparentHead}`), '');
      assert.equal(git(s.cwd, 'rev-list', apparentHead, '--not', '--remotes=origin'), target === 'origin/base' || target === 'packed-refs' ? '' : mask);
      assertPayload(s.cwd, payload, payloadCommit);
      return DEFAULTS.coding!(s, n);
    };
    const t = await ticket(e); await e.cycle();
    const j = job(e, t.identifier);
    assert.equal(j.status, 'blocked', j.error);
    assert.match(j.blocked_reason, /unexpected ref or HEAD change/);
    assert.equal(j.base_sha, initialBase);
    assert.equal(e.ctx.ws.trustedState(j.worktree).base_sha, initialBase);
    assert.equal(e.ctx.ws.trustedState(j.worktree).head_sha, initialBase, 'the untrusted commit was never adopted');
    assert.notEqual(payloadCommit, initialBase);
    assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM local_prs').get() as { n: number }).n, 0);
    assert.equal(refs(e), '');
    assert.equal(e.runner.calls.some(s => s.role === 'review'), false);
    assert.ok(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'security.worktree_tampered'").get());
  });
}

for (const payload of payloads) {
  test(`a ${payload} still blocks when rewritten refs are restored before the guard runs`, async () => {
    const e = makeEnv();
    e.runner.behaviors.coding = async (s, n) => {
      const rec = e.ctx.ws.verifiedRecord(s.cwd);
      putPayload(s.cwd, payload);
      git(s.cwd, 'add', '--all');
      const commit = git(s.cwd, 'commit-tree', git(s.cwd, 'write-tree'), '-p', e.ctx.ws.trustedState(s.cwd).base_sha, '-m', 'payload hidden with transient refs');
      const looseRef = join(rec.commonDir, 'refs/remotes/origin/main');
      const previous = existsSync(looseRef) ? readFileSync(looseRef) : null;
      mkdirSync(join(rec.commonDir, 'refs/remotes/origin'), { recursive: true });
      writeFileSync(looseRef, `${commit}\n`);
      assert.equal(git(s.cwd, 'rev-list', commit, '--not', '--remotes=origin'), '');
      if (previous) writeFileSync(looseRef, previous); else rmSync(looseRef);
      return DEFAULTS.coding!(s, n);
    };
    const t = await ticket(e); await e.cycle();
    const j = job(e, t.identifier);
    assert.equal(j.status, 'blocked', j.error);
    assert.match(j.blocked_reason, payload === 'secret' ? /possible secrets/ : /unapproved dependency change/);
    assert.equal(e.ctx.db.prepare("SELECT 1 FROM events WHERE type = 'security.worktree_tampered'").get(), undefined, 'exercise the protected scan/policy, not just ref detection');
    assert.notEqual(j.candidate_sha, j.base_sha, 'the orchestrator captured the actual working files independently');
    assert.equal(refs(e), '');
    assert.equal((e.ctx.db.prepare('SELECT COUNT(*) n FROM local_prs').get() as { n: number }).n, 0);
  });
}

test('corrupting agent-visible objects cannot change the protected candidate or policy baseline', async () => {
  const e = makeEnv();
  e.runner.behaviors.coding = async (s, n) => {
    const rec = e.ctx.ws.verifiedRecord(s.cwd);
    const state = e.ctx.ws.trustedState(s.cwd);
    assert.equal(existsSync(join(state.git_dir, 'objects/info/alternates')), false);
    const packs = join(rec.commonDir, 'objects/pack');
    for (const name of readdirSync(packs)) if (name.endsWith('.pack')) {
      // Atomic replacement keeps this fixture from changing any other inode.
      rmSync(join(packs, name)); writeFileSync(join(packs, name), 'untrusted object corruption');
    }
    mkdirSync(join(rec.commonDir, 'objects/info'), { recursive: true });
    writeFileSync(join(rec.commonDir, 'objects/info/alternates'), '/nonexistent/untrusted-alternates\n');
    return DEFAULTS.coding!(s, n);
  };
  const t = await ticket(e); await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge', j.error);
  const state = e.ctx.ws.trustedState(j.worktree);
  await e.ctx.ws.git(j.worktree, ['fsck', '--full', '--strict']);
  assert.match(await e.ctx.ws.diff(j.worktree, 'main'), /Trusted git/);
  assert.equal(git(e.repo, 'rev-parse', `refs/heads/${j.branch}`), j.candidate_sha);
  assert.equal(state.head_sha, j.candidate_sha);
});

test('the secret scan includes intermediate protected commits even after a later removal', async () => {
  const e = makeEnv(); const t = await ticket(e); await e.cycle();
  const j = job(e, t.identifier);
  const remoteBefore = git(e.repo, 'rev-parse', `refs/heads/${j.branch}`);
  writeFileSync(join(j.worktree, 'fixture.txt'), 'ghp_' + 'Z'.repeat(36));
  await e.ctx.ws.commitAll(j.worktree, 'test-only synthetic secret in intermediate commit');
  rmSync(join(j.worktree, 'fixture.txt'));
  await e.ctx.ws.commitAll(j.worktree, 'remove test fixture');
  assert.doesNotMatch(await e.ctx.ws.diff(j.worktree, 'main'), /ghp_/);
  const sha = await e.ctx.ws.headSha(j.worktree);
  await assert.rejects(e.ctx.ws.push(j.worktree, j.branch, e.repo, { expectedSha: sha }), UnsafePushError);
  assert.equal(git(e.repo, 'rev-parse', `refs/heads/${j.branch}`), remoteBefore);
});

test('validation, review and the remote PR all use the same protected commit', async () => {
  const e = makeEnv(); const t = await ticket(e); await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'awaiting_merge', j.error);
  assert.equal(j.validated_sha, j.candidate_sha);
  assert.equal(j.reviewed_sha, j.candidate_sha);
  assert.equal(e.ctx.ws.trustedState(j.worktree).head_sha, j.candidate_sha);
  assert.equal((await e.scm.getPr(e.repo, j.pr_number)).headSha, j.candidate_sha);
  const review = e.runner.calls.find(s => s.role === 'review')!;
  assert.ok(review.prompt.includes(j.candidate_sha));
  assert.ok(review.prompt.includes(j.base_sha));
  assert.match(review.prompt, /Full diff from the orchestrator's protected object store/);
  assert.match(review.prompt, /\+.*Trusted git/);
  assert.notEqual(review.cwd, e.runner.calls.find(s => s.role === 'coding')!.cwd);
  assert.equal(existsSync(join(review.cwd, '.git')), false);
  const restarted = createCtx(e.ctx.cfg, { db: e.ctx.db, tracker: e.tracker, scm: e.scm, runner: e.runner, runCommand: e.ctx.runCommand });
  assert.deepEqual(restarted.ws.trustedState(j.worktree), e.ctx.ws.trustedState(j.worktree));
});

test('a late coding-worktree edit cannot change the validation checkout', async () => {
  const e = makeEnv(); const execute = e.ctx.runCommand;
  let sawSnapshot = false;
  e.ctx.runCommand = async (cmd, cwd, env, timeout, signal, inputs) => {
    if (cwd.includes('/candidates/') && !sawSnapshot) {
      sawSnapshot = true;
      const source = e.ctx.ws.worktreeDir('DEMO-1');
      const original = readFileSync(join(cwd, 'src/index.js'), 'utf8');
      writeFileSync(join(source, 'src/index.js'), 'throw new Error("late edit");');
      assert.equal(readFileSync(join(cwd, 'src/index.js'), 'utf8'), original);
    }
    return execute(cmd, cwd, env, timeout, signal, inputs);
  };
  const t = await ticket(e); await e.cycle();
  assert.equal(sawSnapshot, true);
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.equal(refs(e), '');
});

test('merged jobs remove their clean snapshots and protected object store', async () => {
  const e = makeEnv(); const t = await ticket(e); await e.cycle();
  const j = job(e, t.identifier); const state = e.ctx.ws.trustedState(j.worktree);
  await e.scm.merge(e.repo, j.pr_number); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'done');
  assert.equal(existsSync(j.candidate_worktree), false);
  assert.equal(existsSync(state.git_dir), false);
  assert.equal(e.ctx.db.prepare('SELECT * FROM git_states WHERE worktree = ?').get(realpathSync(e.root) + '/work/worktrees/DEMO-1'), undefined);
});

test('a reviewer that edits candidate files cannot approve a different tree', async () => {
  const e = makeEnv({ behaviors: { review: async (s, n) => {
    writeFileSync(join(s.cwd, 'src/index.js'), 'export const add = () => 0;\n');
    return DEFAULTS.review!(s, n);
  } } });
  const t = await ticket(e); await e.cycle();
  const j = job(e, t.identifier);
  assert.equal(j.status, 'blocked');
  assert.equal(j.reviewed_sha, null);
  assert.match(j.blocked_reason, /candidate snapshot invalid/);
  assert.equal((await e.tracker.getTicket(t.id))!.status, 'blocked');
});

test('remote PR HEAD drift prevents handoff even when CI reports success', async () => {
  const e = makeEnv(); const original = e.scm.getPr.bind(e.scm);
  let calls = 0;
  e.scm.getPr = async (repo, number) => {
    const pr = await original(repo, number);
    // First call is inside createPr; the next is the CI stage.
    if (++calls >= 2) return { ...pr, headSha: '1'.repeat(40) };
    return pr;
  };
  const t = await ticket(e); await e.cycle();
  assert.equal(job(e, t.identifier).status, 'blocked');
  assert.match(job(e, t.identifier).blocked_reason, /remote PR HEAD differs/);
  assert.equal(e.runner.calls.some(s => s.role === 'review'), false);
});

test('old workspaces without a trusted object store are refused instead of adopting mutable refs', async () => {
  const e = makeEnv(); const t = await ticket(e); await e.cycle();
  const j = job(e, t.identifier);
  e.ctx.db.prepare('DELETE FROM git_states WHERE worktree = ?').run(realpathSync(j.worktree));
  await assert.rejects(e.ctx.ws.ensureWorktree(e.repo, t.identifier, j.branch, 'main'), /missing trusted hashes/);
});
