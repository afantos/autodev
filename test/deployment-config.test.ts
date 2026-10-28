import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoDeployEnabled } from '../deploy/deployment-config.ts';
import { poll } from '../deploy/ci-poll.ts';

function fixture(value?: string) {
  const root=mkdtempSync(join(tmpdir(),'deploy-config-'));
  mkdirSync(join(root,'deploy'));
  if(value !== undefined) writeFileSync(join(root,'deploy/config.json'),value);
  return root;
}

for(const value of [undefined,'{}','{"autoDeployEnabled":false}']) test(`automatic deployment defaults off for ${value}`,()=>{
  assert.equal(autoDeployEnabled(fixture(value)),false);
});

test('only an explicit boolean true enables automatic deployment',()=>{
  assert.equal(autoDeployEnabled(fixture('{"autoDeployEnabled":true}')),true);
});

for(const value of ['{','null','[]','{"autoDeployEnabled":"false"}','{"autoDeployEnabled":1}']) test(`invalid configuration ${value} never enables deployment`,()=>{
  assert.throws(()=>autoDeployEnabled(fixture(value)));
});

for(const value of [undefined,'{"autoDeployEnabled":false}']) test(`disabled poll needs no API calls, installed app or state access (${value})`,async()=>{
  let requests=0,deployments=0;
  const fetchImpl=(async()=>{requests++;throw new Error('unexpected request');}) as typeof fetch;
  await poll(fixture(value),fetchImpl,async()=>{deployments++;});
  assert.equal(requests,0);assert.equal(deployments,0);
});

test('a flag changed to off during the CI query prevents deployment',async()=>{
  const root=fixture('{"autoDeployEnabled":true}');
  mkdirSync(join(root,'app'));writeFileSync(join(root,'app/.installed-commit'),'a'.repeat(40));
  const sha='b'.repeat(40);let deployments=0;
  const fetchImpl=(async(url:string)=>{
    if(url.includes('/workflows/')) return new Response(JSON.stringify({workflow_runs:[{head_sha:sha,id:123,run_number:456,event:'push',head_branch:'main',conclusion:'success',status:'completed',path:'.github/workflows/check.yml',head_repository:{full_name:'afantos/autodev'}}]}));
    if(url.includes('/branches/')) return new Response(JSON.stringify({commit:{sha}}));
    writeFileSync(join(root,'deploy/config.json'),'{"autoDeployEnabled":false}');
    return new Response(JSON.stringify({jobs:[{name:'checks',status:'completed',conclusion:'success'}]}));
  }) as typeof fetch;
  await poll(root,fetchImpl,async()=>{deployments++;});
  assert.equal(deployments,0);
});

test('the shipped operator config defaults off',()=>{
  const template=JSON.parse(readFileSync(join(import.meta.dirname,'../deploy/autodev-deploy.config.json'),'utf8'));
  assert.equal(template.autoDeployEnabled,false);
});
