/** No AI, tracker, SCM, credentials, or existing job state is used by this diagnostic. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { commandEnv, macosSandboxProfile, runSandboxed } from '../src/command-sandbox.ts';
import { diagnoseSandbox, probeNetworkIsolation } from '../src/sandbox-diagnostics.ts';
import { run, shellQuote } from '../src/exec.ts';

const output = realpathSync(mkdtempSync(join(tmpdir(), 'autodev-sandbox-diagnostic-')));
const cwd = join(output, 'work'); const home = join(output, 'home');
mkdirSync(cwd); mkdirSync(home);
const runtime = dirname(dirname(realpathSync(process.execPath)));
const tags: string[] = [];
const profiles: string[] = [];
const saveProfile = (profile: string, tag: string) => {
  const file = join(output, `profile-${profiles.length + 1}.sb`);
  writeFileSync(file, profile, { mode: 0o600 }); profiles.push(file); tags.push(tag);
};
const template = macosSandboxProfile(cwd, home, runtime, `AUTODEV_TEMPLATE_${basename(output)}`);
if (process.platform === 'darwin') writeFileSync(join(output, 'profile-template.sb'), template, { mode: 0o600 });
const diagnosis = await diagnoseSandbox(cwd, { onProfile: saveProfile });
const report: Record<string, unknown> = { platform: process.platform, output, diagnosis, profiles };

if (process.platform === 'darwin' && diagnosis.baseline.code === 0) {
  // Compare the original policy with each narrowly scoped bootstrap correction.
  // Every variant runs only a fixed trusted printf command, never repository code.
  const variants: Record<string, unknown> = {};
  for (const [name, root, mapping] of [['legacy', false, false], ['root_directory', true, false], ['executable_mapping', false, true], ['both', true, true]] as const) {
    const tag = `AUTODEV_${name}_${basename(output)}`;
    const profile = macosSandboxProfile(cwd, home, runtime, tag).split('\n').filter(line =>
      (root || !line.startsWith('(allow file-read* file-test-existence (literal "/")')) &&
      (mapping || !line.startsWith('(allow file-map-executable'))).join('\n');
    saveProfile(profile, tag);
    variants[name] = await run('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', 'printf AUTODEV_SANDBOX_READY'], {
      cwd, env: { ...commandEnv(), HOME: home, TMPDIR: home }, timeoutMs: 5000,
    });
  }
  report.bootstrapVariants = variants;
}

if (diagnosis.status === 'ready') {
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test basic.test.cjs' } }));
  writeFileSync(join(cwd, 'basic.test.cjs'), `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('fixture arithmetic',()=>assert.equal(2+3,5));`);
  const inputs = { onProfile: saveProfile };
  const node = await runSandboxed(`${shellQuote(process.execPath)} -e ${shellQuote('process.stdout.write("AUTODEV_NODE_READY")')}`, cwd, {}, 5000, undefined, inputs);
  const npm = await runSandboxed('npm test --offline --no-audit', cwd, {}, 20_000, undefined, inputs);
  const secret = join(output, 'synthetic.env'); const outside = join(output, 'host-marker');
  writeFileSync(secret, 'SYNTHETIC_DIAGNOSTIC_ONLY'); writeFileSync(outside, 'unchanged');
  writeFileSync(join(cwd, '.git'), 'gitdir: /synthetic-unused\n');
  const probe = `const fs=require('node:fs'),assert=require('node:assert/strict');
const denied=fn=>{try{fn();assert.fail('operation unexpectedly allowed')}catch(e){assert.ok(['EACCES','EPERM','ENOENT','EROFS','EBUSY'].includes(e.code),e.message)}};
denied(()=>fs.readFileSync(${JSON.stringify(secret)}));
fs.symlinkSync(${JSON.stringify(secret)},'secret-link');denied(()=>fs.readFileSync('secret-link'));
denied(()=>fs.writeFileSync('.git','changed'));denied(()=>fs.unlinkSync('.git'));denied(()=>fs.renameSync('.git','.git-renamed'));
try{fs.writeFileSync(${JSON.stringify(outside)},'changed')}catch{};
fs.writeFileSync('ordinary-write.txt','ok');
console.log('AUTODEV_BOUNDARIES_READY');`;
  const boundaries = await runSandboxed(`${shellQuote(process.execPath)} -e ${shellQuote(probe)}`, cwd, {}, 5000, undefined, inputs);
  const hostUnchanged = readFileSync(outside, 'utf8') === 'unchanged' && readFileSync(join(cwd, '.git'), 'utf8') === 'gitdir: /synthetic-unused\n';
  // Network: a real host listener must be reachable from the host and unreachable from the sandbox.
  const network = await probeNetworkIsolation((cmd, dir) => runSandboxed(cmd, dir, {}, 15_000, undefined, inputs), cwd);
  report.runtime = { node, npm, boundaries, hostUnchanged, network };
  report.ok = node.code === 0 && node.stdout === 'AUTODEV_NODE_READY' && npm.code === 0 && boundaries.code === 0 && boundaries.stdout.includes('AUTODEV_BOUNDARIES_READY') && hostUnchanged && network.isolated;
} else report.ok = false;

if (process.platform === 'darwin' && tags.length) {
  const predicate = tags.map(tag => `eventMessage CONTAINS "${tag}"`).join(' OR ');
  const logs = await run('/usr/bin/log', ['show', '--last', '3m', '--style', 'compact', '--info', '--predicate', predicate], { env: commandEnv(), timeoutMs: 10_000 });
  writeFileSync(join(output, 'seatbelt.log'), logs.stdout || logs.stderr, { mode: 0o600 });
  report.logStatus = { code: logs.code, signal: logs.signal, path: join(output, 'seatbelt.log') };
}
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
console.log(`No AI was called and no existing job was resumed. Diagnostic artifacts: ${output}`);
if (!report.ok) process.exitCode = 1;
