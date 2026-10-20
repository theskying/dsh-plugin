import test from 'node:test';
import assert from 'node:assert/strict';
import { SidebarCore, SIDE_DENIED_TOOLS, initialProgress, foldProgress } from '../core.js';
import { SIDEBAR_TTL_MS } from '../lifecycle.js';

const request=(tabId='content-1',mainSessionId='main')=>({mainSessionId,tabId});
export function fixture(shared={}) {
  let time=1000;
  const records=shared.records??new Map(), tombstones=shared.tombstones??new Map(), disk=shared.disk??new Map();
  const main={id:'main',header:{id:'main',cwd:'/workspace',agentPreset:'standard'},events:[
    {type:'permission/preset',data:{preset:'danger-full-access'}},
    {type:'sandbox/mode',data:{mode:'danger-full-access'}},
    {type:'approval/policy',data:{policy:'never'}},
  ]};
  const sessions=new Map([['main',main]]), live=new Map([['main',{id:'main',session:main,ctx:{},status:'running'}]]), calls=[];
  const table={entries:()=>records.entries(),put:async(id,row)=>records.set(id,structuredClone(row)),delete:async id=>records.delete(id)};
  const closedTable={entries:()=>tombstones.entries(),put:async(id,row)=>tombstones.set(id,structuredClone(row)),delete:async id=>tombstones.delete(id)};
  let core;
  const make=async(req,resume)=>{
    const id=resume?req.resumeSessionId:req.sessionId;
    if(live.has(id))throw Error('already live');
    if(resume&&!disk.has(id))throw Error('not found');
    calls.push([resume?'resume':'create',id]);
    const saved=resume?disk.get(id):{header:{id,...req.meta},events:[]};
    const session={id,header:saved.header,events:structuredClone(saved.events),append(type,data){this.events.push({type,data:structuredClone(data)});}};
    const agent={id,session,ctx:{},status:'idle'};
    await req.setup(agent.ctx,agent);req.signal?.throwIfAborted();
    sessions.set(id,session);live.set(id,agent);disk.set(id,{header:session.header,events:structuredClone(session.events)});
    let disposed=false;
    return {agent,dispose:async()=>{if(disposed)return;calls.push(['dispose',id]);disk.set(id,{header:session.header,events:structuredClone(session.events)});live.delete(id);sessions.delete(id);disposed=true;}};
  };
  core=new SidebarCore({table,closedTable,now:()=>time,
    sessions:{get:id=>sessions.get(id),flush:async s=>{calls.push(['flush',s.id]);disk.set(s.id,{header:s.header,events:structuredClone(s.events)});}},
    agents:{get:id=>live.get(id),create:r=>make(r,false),resume:r=>make(r,true)},
    sessionController:{inspect:async id=>{const s=sessions.get(id)??disk.get(id);if(!s)throw Error('not found');return {meta:s.header,events:s.events};}},
    workingDirectory:{get:s=>s.header.cwd},agentPresets:{composedPreset:()=> 'standard',resolve:async id=>({id:id??'standard'}),mount:async()=>{}},
    agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},
    sessionProjections:{stateOf:()=>undefined},
    sessionTitle:{get:s=>({title:s.events.findLast(e=>e.type==='session/title')?.data.title??'创造模式的作用'}),rename:(s,title)=>s.append('session/title',{title})},
    workspaceRegistry:{archiveSession:async id=>calls.push(['archive',id])},
    sessionPersistence:{stat:async id=>disk.has(id)?{header:disk.get(id).header}:undefined},
    deleteLog:async(_p,row)=>{assert.equal(live.has(row.sessionId),false,'writer owner released before deletion');calls.push(['delete',row.sessionId]);disk.delete(row.sessionId);},
    sessionQuery:{readSurface:async()=>({capturedThroughSeq:7,events:[
      {seq:3,type:'user/message',data:{content:[{type:'text',text:'question'}]}},
      {seq:5,type:'assistant/message',data:{message:{content:[{type:'text',text:'answer'}]}}},
      {seq:7,type:'tool/result',data:{message:{content:[{type:'text',text:'result'}]}}},
    ]}),readEvent:async r=>({target:{seq:r.seq,type:'tool/result',data:{text:'full event'}}})},
  });
  return {core,main,live,sessions,calls,records,tombstones,disk,table,setTime:v=>time=v};
}

test('new tabs inherit permissions and have unique parent-qualified names',async()=>{
  const f=fixture(),before=structuredClone(f.main);
  const [a,b]=await Promise.all([f.core.open(request()),f.core.open(request('content-2'))]);
  assert.notEqual(a.sessionId,b.sessionId);assert.deepEqual(f.main,before);
  assert.equal(a.title,'侧边栏1-创造模式的作用');assert.equal(b.title,'侧边栏2-创造模式的作用');
  assert.deepEqual(f.sessions.get(a.sessionId).events.slice(0,3).map(e=>e.type),['permission/preset','approval/policy','sandbox/mode']);
  assert.equal(a.expiresAt-a.createdAt,SIDEBAR_TTL_MS);assert.equal(f.records.size,2);
});
test('status queried during Agent creation is creating, never closing',async()=>{
  const f=fixture(),create=f.core.agents.create,entered=Promise.withResolvers(),release=Promise.withResolvers();
  f.core.agents.create=async options=>{entered.resolve();await release.promise;return create(options);};
  const opening=f.core.open(request());
  await entered.promise;
  try {
    assert.equal(f.core.status(request()).state,'creating');
    assert.equal(f.core.list('main').length,0);
    assert.equal(f.calls.some(call=>call[0]==='archive'||call[0]==='delete'),false);
  } finally { release.resolve(); }
  const row=await opening;
  assert.equal(f.core.status(request()).state,'active');
  assert.equal(f.live.has(row.sessionId),true);
  assert.equal(f.tombstones.size,0);
});
test('same identity concurrent open publishes once',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.core.open(request()),f.core.open(request())]);
  assert.deepEqual(a,b);assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('list accepts RPC-shaped request and lookup never creates',async()=>{
  const f=fixture();assert.equal(f.core.lookup(request()),null);const a=await f.core.open(request());
  assert.deepEqual(f.core.list({mainSessionId:'main'}),[a]);assert.equal(f.core.list({mainSessionId:'other'}).length,0);
});
test('close releases writer then deletes disk and metadata; sibling remains',async()=>{
  const f=fixture(),a=await f.core.open(request()),b=await f.core.open(request('other'));
  await f.core.close(a);assert.equal(f.live.has(a.sessionId),false);assert.equal(f.disk.has(a.sessionId),false);assert.equal(f.records.has(a.sessionId),false);assert.equal(f.live.has(b.sessionId),true);
  assert.ok(f.calls.findIndex(c=>c[0]==='dispose')<f.calls.findIndex(c=>c[0]==='delete'));
  await assert.rejects(f.core.open(request()),/closed/);
});
test('wrong session close cannot tombstone a sibling',async()=>{
  const f=fixture(),a=await f.core.open(request()),b=await f.core.open(request('b'));
  await assert.rejects(f.core.close({...a,sessionId:b.sessionId}),/mismatch/);
  assert.deepEqual(await f.core.open(request()),a);
});
test('unload preserves durable row and restart resumes an owned handle',async()=>{
  const f=fixture(),a=await f.core.open(request());await f.core.dispose();
  assert.equal(f.live.has(a.sessionId),false);assert.equal(f.records.size,1);assert.equal(f.disk.size,1);
  const g=fixture(f);await g.core.load();const b=await g.core.open(request());
  assert.equal(b.sessionId,a.sessionId);assert.equal(g.calls.filter(c=>c[0]==='resume').length,1);
  await g.core.close(b);assert.equal(g.live.has(b.sessionId),false);assert.equal(g.disk.size,0);
});
test('cold expired row uses persisted header and deletes without resuming',async()=>{
  const f=fixture(),a=await f.core.open(request());await f.core.dispose();
  const g=fixture(f);g.setTime(a.expiresAt);await g.core.load();await g.core.expire();
  assert.equal(g.records.size,0);assert.equal(g.disk.size,0);assert.equal(g.calls.some(c=>c[0]==='resume'),false);
});
test('cleanup failure stays queued and next expiry pass retries',async()=>{
  const f=fixture(),a=await f.core.open(request());const del=f.core.deleteLog;
  f.core.deleteLog=async()=>{throw Error('disk busy')};f.setTime(a.expiresAt);
  assert.equal((await f.core.expire()).length,1);assert.equal(f.records.size,1);assert.equal(f.core.list('main').length,0);
  f.core.deleteLog=del;await f.core.expire();assert.equal(f.records.size,0);assert.equal(f.disk.size,0);
});
test('metadata delete failure preserves retry row',async()=>{
  const f=fixture(),a=await f.core.open(request()),del=f.table.delete;
  f.table.delete=async()=>{throw Error('metadata busy')};await assert.rejects(f.core.close(a),/metadata busy/);
  assert.equal(f.core.rows.size,1);assert.equal(f.records.size,1);f.table.delete=del;
  await f.core.close(a);assert.equal(f.core.rows.size,0);assert.equal(f.records.size,0);
});
test('failed preflight creates no phantom row or session',async()=>{
  const f=fixture();f.core.sessionController.inspect=async()=>{throw Error('offline')};
  await assert.rejects(f.core.open(request()),/offline/);assert.equal(f.core.rows.size,0);assert.equal(f.records.size,0);
});
test('close racing create retains exact late handle for disposal',async()=>{
  const f=fixture(),original=f.core.agents.create,entered=Promise.withResolvers(),go=Promise.withResolvers();
  f.core.agents.create=async r=>{entered.resolve();await go.promise;return original(r)};
  const opening=f.core.open(request());const rejected=assert.rejects(opening,/closed/);await entered.promise;
  const closing=f.core.close(request());go.resolve();await Promise.all([rejected,closing]);assert.equal(f.disk.size,0);assert.equal(f.live.size,1);
});
test('close before open durable tombstone prevents delayed creation across restart',async()=>{
  const f=fixture();await f.core.close(request());const g=fixture(f);await g.core.load();
  await assert.rejects(g.core.open(request()),/closed/);assert.equal(g.disk.size,0);
});
test('cold rename writes native title and durable row consistently',async()=>{
  const f=fixture(),a=await f.core.open(request());await f.core.dispose();const g=fixture(f);await g.core.load();
  await g.core.rename({...request(),title:'用户命名'});
  assert.equal(g.records.get(a.sessionId).title,'用户命名');assert.equal(g.disk.get(a.sessionId).events.at(-1).data.title,'用户命名');
});
test('foreign live Agent is not given a fake disposer or deleted',async()=>{
  const f=fixture(),a=await f.core.open(request());f.core.rows.get(f.core.key(a)).handle=undefined;
  await assert.rejects(f.core.close(a),/其他运行时/);assert.equal(f.disk.has(a.sessionId),true);assert.equal(f.records.size,1);
});
test('expiry respects each tab deadline using deterministic clock',async()=>{
  const f=fixture(),a=await f.core.open(request());f.setTime(2000);const b=await f.core.open(request('b'));
  f.setTime(a.expiresAt);await f.core.expire();assert.equal(f.core.list('main').length,1);assert.equal(f.core.list('main')[0].sessionId,b.sessionId);
});
test('read main is bounded and uses exact linked source',async()=>{
  const f=fixture(),a=await f.core.open(request());const result=await f.core.readMain(a.sessionId,{maxChars:3});
  assert.equal(result.entries[0].text,'res');assert.equal(result.omittedEvents,2);
  await assert.rejects(f.core.readMain(a.sessionId,{maxChars:32001}),/Invalid/);
  await f.core.close(a);await assert.rejects(f.core.readMain(a.sessionId),/关闭/);
});
test('nested sidebar forbidden; cancellation before create has no effects',async()=>{
  const f=fixture();await assert.rejects(f.core.open(request('x','sidebar-test')),/another/);
  const ac=new AbortController();ac.abort();await assert.rejects(f.core.open(request(),ac.signal));assert.equal(f.records.size,0);
});
test('progress fold preserves ignored-state identity and ends tool activity',()=>{
  const s=initialProgress();assert.equal(foldProgress(s,{type:'user/message'}),s);
  const called=foldProgress(s,{type:'tool/call',seq:3,data:{callId:'c',name:'read'}});
  assert.equal(called.activeTools.length,1);assert.equal(foldProgress(called,{type:'tool/result',seq:4,data:{message:{toolCallId:'c'}}}).activeTools.length,0);
});
test('cross-agent delegation remains denied without blocking local tools',()=>{
  for(const n of ['send_message','subagent','plugin_manager'])assert.ok(SIDE_DENIED_TOOLS.has(n));
  assert.equal(SIDE_DENIED_TOOLS.has('read'),false);
});
