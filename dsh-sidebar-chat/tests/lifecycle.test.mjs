import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deleteSidebarLog, projectKey, encodeSegment } from '../lifecycle.js';

async function sandbox(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'sidebar-delete-test-')));
  t.after(async()=>{assert.ok(root.includes('/sidebar-delete-test-'));await rm(root,{recursive:true,force:true});});
  const row={sessionId:`sidebar-${randomUUID()}`,cwd:'/workspace/中文😀'};
  const target=join(root,projectKey(row.cwd),row.sessionId);
  await mkdir(target,{recursive:true});await writeFile(join(target,'session.v1.jsonl'),'synthetic test data');
  const exists=async()=>{try{await access(target);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
  let claimed=0,released=0;
  const persistence={name:'session-persistence-jsonl',root,stat:async()=>await exists()?{header:{id:row.sessionId,cwd:row.cwd}}:undefined,open:async(id,mode)=>{assert.equal(id,row.sessionId);assert.equal(mode,'write');claimed++;return {close:async()=>{released++;}};}};
  return {root,row,target,persistence,exists,counts:()=>({claimed,released})};
}
test('UTF16 path encoding matches backend including astral characters',()=>{
  assert.equal(projectKey('/workspace/😀'),'--workspace-~D83D~DE00--');
  assert.equal(encodeSegment('../x'),'..~002Fx');
});
test('verified backend deletion removes only the exact session and releases lease',async t=>{
  const f=await sandbox(t);const sibling=join(f.root,projectKey(f.row.cwd),'sidebar-sibling');await mkdir(sibling);
  await deleteSidebarLog(f.persistence,f.row,{sessions:{get:()=>undefined},agents:{get:()=>undefined}});
  assert.equal(await f.exists(),false);await access(sibling);assert.deepEqual(f.counts(),{claimed:1,released:1});
  await deleteSidebarLog(f.persistence,f.row);assert.deepEqual(f.counts(),{claimed:1,released:1});
});
test('unknown backend, live session and mismatched header fail without deletion',async t=>{
  const f=await sandbox(t);
  await assert.rejects(deleteSidebarLog({},f.row),/后端/);
  await assert.rejects(deleteSidebarLog(f.persistence,f.row,{sessions:{get:()=>({})}}),/内存/);
  await assert.rejects(deleteSidebarLog({...f.persistence,stat:async()=>({header:{id:'main',cwd:f.row.cwd}})},f.row),/mismatch/);
  assert.equal(await f.exists(),true);
});
test('symlink project is refused rather than traversed',async t=>{
  const f=await sandbox(t),other=join(f.root,'alias-root');await mkdir(other);
  const alias=join(other,projectKey(f.row.cwd));await symlink(join(f.root,projectKey(f.row.cwd)),alias);
  await assert.rejects(deleteSidebarLog({...f.persistence,root:other},f.row),/symbolic link/);assert.equal(await f.exists(),true);
});
test('another writer holding ownership keeps files intact',async t=>{
  const f=await sandbox(t);f.persistence.open=async()=>{throw Error('writer held')};
  await assert.rejects(deleteSidebarLog(f.persistence,f.row),/writer held/);assert.equal(await f.exists(),true);
});
