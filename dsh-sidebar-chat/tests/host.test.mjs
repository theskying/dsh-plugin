import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, handleSidebarRequest, validateSidebarReferences } from '../index.js';
import { SidebarCore } from '../core.js';
const envelope=(action,request)=>({type:'client-request',rpcId:'rpc-1',method:`sidebarChat/${action}`,payload:{args:{request}}});
const req=body=>new Request('http://audit.invalid',{method:'POST',body:JSON.stringify(body)});
const row={mainSessionId:'main',tabId:'content-1',sessionId:'sidebar-00000000-0000-0000-0000-000000000001',title:'测试',createdAt:1,expiresAt:100,state:'active'};
test('real list and lookup envelope returns known active rows without creating',async()=>{
  const core=new SidebarCore({now:()=>10});core.putMemory({...row});
  const result=await(await handleSidebarRequest(core,req(envelope('list',{mainSessionId:'main'})),'list')).json();
  assert.deepEqual(result.result,{ok:true,value:[row]});
  const lookup=await(await handleSidebarRequest(core,req(envelope('lookup',{mainSessionId:'main',tabId:'content-1'})),'lookup')).json();
  assert.deepEqual(lookup.result.value,row);
});
test('status distinguishes absent tabs from expired and durably closed tabs',async()=>{
  const core=new SidebarCore({now:()=>10});
  const query={mainSessionId:'main',tabId:'content-1'};
  const status=async()=> (await (await handleSidebarRequest(core,req(envelope('status',query)),'status')).json()).result.value;
  assert.deepEqual(await status(),{state:'unknown'});
  core.putMemory({...row,state:'creating'});assert.equal((await status()).state,'creating');
  core.putMemory({...row});assert.equal((await status()).state,'active');
  core.now=()=>101;assert.equal((await status()).state,'closing');
  core.forgetMemory(core.relationship(row.sessionId));core.tombstones.set(core.key(query),query);
  assert.deepEqual(await status(),{state:'closed'});
});
test('RPC rejects malformed payloads and never dispatches unknown actions',async()=>{
  const core={open:()=>{throw Error('must not run')}};
  for(const body of [{},envelope('open',{mainSessionId:'main'}),envelope('close',{}),envelope('open',{mainSessionId:'main',tabId:'a',principal:'owner'})])assert.equal((await handleSidebarRequest(core,req(body))).status,400);
  assert.equal((await handleSidebarRequest(core,req({}),'constructor')).status,400);
});
test('rename accepts cold identity without requiring client sessionId',async()=>{
  const request={mainSessionId:'main',tabId:'content-1',title:'新名称'};
  const result=await(await handleSidebarRequest({rename:async r=>{assert.deepEqual(r,request);return row}},req(envelope('rename',request)),'rename')).json();
  assert.equal(result.result.ok,true);
});
test('native reference guard rejects wrong parent, expired and deleted sources',()=>{
  const core=new SidebarCore({now:()=>10});core.putMemory({...row});
  const decision={kind:'enter',messages:[{source:{kind:'session-reference',references:[{sessionId:row.sessionId}]}}]};
  validateSidebarReferences(core,{id:'main'},decision);
  assert.throws(()=>validateSidebarReferences(core,{id:'other'},decision),/不属于/);
  core.now=()=>101;assert.throws(()=>validateSidebarReferences(core,{id:'main'},decision),/到期/);
  core.rows.clear();core.bySession.clear();assert.throws(()=>validateSidebarReferences(core,{id:'main'},decision),/关闭/);
});
test('Host exposes lookup/list and no model destructive confirmation tool',async()=>{
  const effects=[],routes=[],tools=[];let core;
  const table={entries:()=>[][Symbol.iterator](),put:async()=>{},delete:async()=>{}};
  const ctx={sessionProjections:{register:()=>{}},storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},sessions:{get:()=>undefined},agents:{list:()=>[]},provide:(_,v)=>core=v,effect:f=>effects.push(f()),connection:{fetch:{register:r=>routes.push(r)}},tools:{register:t=>tools.push(t)},on:()=>()=>{},commands:{register:()=>{}}};
  await apply(ctx);
  assert.ok(routes.some(r=>r.path==='/api/sidebarChat/list'));assert.ok(routes.some(r=>r.path==='/api/sidebarChat/lookup'));
  assert.ok(!tools.some(t=>t.name==='sidebar_close'));
  for(const off of effects.reverse())await off?.();assert.equal(core.disposed,true);
});
