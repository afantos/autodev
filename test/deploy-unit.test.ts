import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxAvailable } from './helpers.ts';

// 2026-10-25: under the systemd unit, ProtectKernelTunables=true made bwrap fail to mount /proc
// ("Can't mount proc on /newroot/proc: Operation not permitted"), so every claimed ticket failed setup.
// Manual runs never saw it because they didn't run under the unit's hardening.

const root = join(import.meta.dirname, '..');
const unit = readFileSync(join(root, 'deploy', 'autodev.service'), 'utf8');
const prepare = readFileSync(join(root, 'deploy', 'prepare-host.sh'), 'utf8');
const directives = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('['));
const section = (text: string, name: string) => text.split(/^\[/m).find((s) => s.startsWith(`${name}]`)) ?? '';

test('the unit no longer sets ProtectKernelTunables (it breaks the bwrap /proc mount)', () => {
  assert.equal(directives(unit).some((d) => /^ProtectKernelTunables\s*=/.test(d)), false);
});

test('every other hardening option is kept', () => {
  const d = directives(section(unit, 'Service'));
  for (const want of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=true', 'ProtectKernelModules=true', 'ProtectControlGroups=true', 'RestrictSUIDSGID=true', 'LockPersonality=true', 'MemoryMax=12G', 'User=autodev']) {
    assert.ok(d.includes(want), `missing ${want}`);
  }
  assert.ok(d.some((x) => x.startsWith('ReadWritePaths=/opt/autodev/instance /opt/autodev/instance-work ')));
});

test('the unit runs the sandbox self-test before starting, and stops retrying after a few failures', () => {
  const d = directives(section(unit, 'Service'));
  const pre = d.findIndex((x) => x === 'ExecStartPre=/usr/bin/node /opt/autodev/app/scripts/sandbox-selftest.ts');
  const start = d.findIndex((x) => x.startsWith('ExecStart=/usr/bin/node /opt/autodev/app/src/cli.ts run'));
  assert.ok(pre >= 0, 'ExecStartPre self-test present');
  assert.ok(start > pre, 'self-test runs before the orchestrator');
  const u = directives(section(unit, 'Unit'));
  assert.ok(u.includes('StartLimitBurst=3') && u.some((x) => x.startsWith('StartLimitIntervalSec=')), 'no infinite restart loop on a failing self-test');
});

/** The exact extraction pipeline prepare-host.sh uses, run against a unit file. */
function extract(unitText: string): string[] {
  const line = prepare.split('\n').find((l) => l.startsWith("$(sed -n '/^\\[Service\\]/"));
  assert.ok(line, 'prepare-host contains the extraction pipeline');
  const dir = mkdtempSync(join(tmpdir(), 'unit-'));
  const file = join(dir, 'autodev.service');
  writeFileSync(file, unitText);
  const cmd = line.slice(2, -1).replace('"$UNIT"', JSON.stringify(file));
  return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

test('prepare-host runs the self-test through systemd-run with the settings read from the installed unit', () => {
  assert.match(prepare, /systemd-run --quiet --wait --pipe --uid=autodev --gid=autodev "\$@" \/usr\/bin\/node "\$APP\/scripts\/sandbox-selftest\.ts"/);
  assert.match(prepare, /sandbox self-test FAILED under the unit's settings; not continuing"; exit 1/);
  const props = extract(unit);
  for (const want of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=true', 'ProtectKernelModules=true', 'ProtectControlGroups=true', 'RestrictSUIDSGID=true', 'LockPersonality=true', 'Environment=TZ=America/New_York']) {
    assert.ok(props.includes(want), `extracted ${want}`);
  }
  assert.ok(props.some((p) => p.startsWith('ReadWritePaths=')));
  assert.ok(!props.some((p) => /^(EnvironmentFile|ExecStart|ExecStartPre|User|Restart)=/.test(p)), 'no secrets file or exec lines are passed to systemd-run');
});

test('if ProtectKernelTunables were re-added, prepare-host would test with it (so the self-test would catch it)', () => {
  const regressed = unit.replace('PrivateTmp=true', 'PrivateTmp=true\nProtectKernelTunables=true');
  assert.ok(extract(regressed).includes('ProtectKernelTunables=true'));
});

test('the self-test script passes where the command sandbox works', async (t) => {
  const probe = await sandboxAvailable(mkdtempSync(join(tmpdir(), 'st-')));
  if (!probe.ok && !process.env.AUTODEV_REQUIRE_SANDBOX_TEST) { t.skip(`no OS sandbox here: ${probe.why}`); return; }
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'sandbox-selftest.ts')], { encoding: 'utf8', timeout: 90_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sandbox self-test OK/);
});
