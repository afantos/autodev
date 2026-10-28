import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';

const repo = join(import.meta.dirname, '..');
const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40);
function fixture(failure: string, linked = false) {
  const root = mkdtempSync(join(tmpdir(), 'ci-deploy-'));
  const app = join(root, linked ? 'releases/old' : 'app');
  for (const dir of [app, join(root, 'instance/data'), join(root, 'deploy'), join(root, 'bin'), join(root, 'stage/src'), join(root, 'stage/deploy')]) mkdirSync(dir, { recursive: true });
  if (linked) symlinkSync(app, join(root, 'app'));
  writeFileSync(join(app, '.installed-commit'), oldSha);
  writeFileSync(join(root, 'unit'), 'previous unit\n');
  writeFileSync(join(root, 'instance/autodev.config.yaml'), 'projects: [{key: demo, repo: demo}]\n');
  const dbPath = join(root, 'instance/data/autodev.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER); CREATE TABLE events(ts INTEGER,type TEXT,message TEXT);');
  db.prepare('INSERT INTO kv VALUES (?,?,?)').run('manual_pause', 'owner pause preserved', Date.now());
  db.close();
  copyFileSync(join(repo, 'src/config.ts'), join(root, 'stage/src/config.ts'));
  copyFileSync(join(repo, 'deploy/health.ts'), join(root, 'stage/deploy/health.ts'));
  copyFileSync(join(repo, 'deploy/autodev.service'), join(root, 'stage/deploy/autodev.service'));
  writeFileSync(join(root, 'stage/src/cli.ts'), '');
  writeFileSync(join(root, 'stage/package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'stage/package-lock.json'), '{}');
  writeFileSync(join(root, 'state.json'), JSON.stringify({ active: true, calls: [], newPidReads: 0 }));
  const shim = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  shim('id', 'console.log(0)');
  shim('chown', '');
  shim('sleep', '');
  shim('flock', `if(process.env.DEPLOY_FAILURE==='lock') process.exit(1)`);
  shim('npm', `if(process.env.DEPLOY_FAILURE==='install') process.exit(1);require('fs').symlinkSync(${JSON.stringify(realpathSync(join(repo, 'node_modules')))},'node_modules')`);
  shim('systemctl', `
const fs=require('fs'),path=require('path');
const root=process.env.AUTODEV_DEPLOY_ROOT, file=path.join(root,'state.json');
const s=JSON.parse(fs.readFileSync(file)); const args=process.argv.slice(2);s.calls.push(args);
const current=fs.readFileSync(path.join(root,'app/.installed-commit'),'utf8').trim();
const candidate=current===${JSON.stringify(newSha)}, failure=process.env.DEPLOY_FAILURE;
let code=0;
if(args[0]==='stop') s.active=false;
if(args[0]==='start') {
  if(candidate && failure==='start') code=1;
  else {
    s.active=true;
    const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(root,'instance/data/autodev.db'));
    if(candidate) db.exec('CREATE TABLE candidate_migration(id INTEGER)');
    const owner='host:'+(failure==='health'&&candidate?'999':'12345')+':new';
    db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?,?)').run('instance_lock',owner,Date.now());
    db.prepare('INSERT INTO events VALUES (?,?,?)').run(Date.now(),'orchestrator.start','owner='+owner+' concurrency=2');db.close();
  }
}
if(args[0]==='show') { s.newPidReads+=candidate?1:0;console.log(candidate&&failure==='restart'&&s.newPidReads>2?'22222':'12345'); }
if(args[0]==='is-active'&&!s.active) code=1;
fs.writeFileSync(file,JSON.stringify(s));process.exit(code);
`);
  return { root, run: (sequence = '10') => spawnSync('/bin/bash', [join(repo, 'deploy/ci-deploy.sh'), newSha, sequence, join(root, 'stage')], {
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, AUTODEV_DEPLOY_ROOT: root, AUTODEV_DEPLOY_UNIT: join(root, 'unit'), DEPLOY_FAILURE: failure }, encoding: 'utf8', timeout: 30_000,
  }) };
}

for (const linked of [false, true]) test(`successful deploy uses an immutable release and retains rollback state (previous symlink=${linked})`, () => {
  const {root,run}=fixture('',linked);const result=run();
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(readFileSync(join(root,'app/.installed-commit'),'utf8').trim(),newSha);
  assert.equal(statSync(join(root,'app')).mode & 0o777,0o755,'service can traverse the installed release');
  assert.equal(existsSync(join(root,'deploy/pending')),false);
  assert.equal(readFileSync(join(root,'deploy/sequence'),'utf8').trim(),'10');
  assert.match(result.stdout,/DEPLOYED/);
});

for (const failure of ['start','health','restart']) test(`deploy ${failure} failure restores code, unit and database and restarts the old release`, () => {
  const {root,run}=fixture(failure);const result=run();
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/ROLLED_BACK/);
  assert.equal(readFileSync(join(root,'app/.installed-commit'),'utf8').trim(),oldSha);
  assert.equal(readFileSync(join(root,'unit'),'utf8'),'previous unit\n');
  assert.equal(existsSync(join(root,'deploy/pending')),false);
  assert.equal(existsSync(join(root,'deploy/sequence')),false);
  const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));
  assert.equal(state.active,true);
  const db=new DatabaseSync(join(root,'instance/data/autodev.db'),{readOnly:true});
  assert.equal(db.prepare("SELECT v FROM kv WHERE k='manual_pause'").get()!.v,'owner pause preserved');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='candidate_migration'").get(),undefined);
  db.close();
});

for (const failure of ['install','lock']) test(`${failure} failure leaves the current service running`, () => {
  const {root,run}=fixture(failure);const result=run();
  assert.notEqual(result.status,0);
  assert.equal(readFileSync(join(root,'app/.installed-commit'),'utf8'),oldSha);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).calls,[]);
});

test('an older queued run cannot downgrade a newer successful deployment', () => {
  const {root,run}=fixture('');
  writeFileSync(join(root,'deploy/sequence'),'11\n');
  assert.equal(run().status,0);
  assert.equal(readFileSync(join(root,'app/.installed-commit'),'utf8'),oldSha);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).calls,[]);
});

test('CI deploys only successful main pushes, serializes deployments and uses pinned SSH host keys', () => {
  const workflow=parse(readFileSync(join(repo,'.github/workflows/check.yml'),'utf8'));
  const deploy=workflow.jobs.deploy;
  assert.equal(deploy.needs,'checks');
  assert.equal(deploy.if,"github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(deploy.concurrency['cancel-in-progress'],false);
  const command=deploy.steps.find((s: {run?:string})=>s.run?.includes('git archive')).run;
  assert.match(command,/StrictHostKeyChecking=yes/);
  assert.match(command,/current.*!=.*GITHUB_SHA/);
});
