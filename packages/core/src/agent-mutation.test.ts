import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { removeTestDir } from './temp-dir.test-helper.ts';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixtureApprovals } from './approval-fixture.test-helper.ts';
import { AgentMutationService, type AgentMutationAction, type AgentMutationRequest, type AgentMutationContext } from './agent-mutation.ts';
import { AgentSendJournal, AgentSendService } from './agent-send.ts';
import { SendPolicy } from './policy.ts';
const room = {maxLogId:'9007199254740993',memberCount:2};
function request(action:AgentMutationAction):AgentMutationRequest {
  return action==='update_my_profile'?{profileId:'123456789',statusMessage:'fixture changed'}:action==='send_emoticon'?{chatId:'123456789',fromChatId:'987654321',fromLogId:'9007199254740993'}:{chatId:'123456789',logId:'9007199254740993',...(action==='edit_message'?{text:'fixture changed'}:{})};
}
function context(action:AgentMutationAction,r:AgentMutationRequest):AgentMutationContext {
  return action==='update_my_profile'?{kind:'profile',target:{profileId:r.profileId,nickname:'fixture',statusMessage:'fixture old'}}:
    {kind:'message',room:{...room},target:{chatId:action==='send_emoticon'?r.fromChatId:r.chatId,messageId:action==='send_emoticon'?r.fromLogId:r.logId,authorId:'123456789',type:action==='send_emoticon'?20:1,text:'fixture source',revision:null,attachment:action==='send_emoticon'?' {"name":"fixture","path":"fixture/path"} ':null},...(action==='send_emoticon'?{sourceRoom:{...room}}:{})};
}
function fixture(t:{after(fn:()=>void):void},notification=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-mutation-')),journals:AgentSendJournal[]=[];
  let now=1000000,calls=0,inspections=0,changed=false,fail=false,foreign=false,acknowledgement:{status:number;logId?:string}|undefined,hold:Promise<void>|undefined,inspectHold:Promise<void>|undefined;
  const policy=new SendPolicy({ceiling: ['123456789','987654321'],notifyChatId:notification?'123456789':undefined,pausedAtStart:false,auditLogPath:path.join(root,'audit')},{now:()=>now});
  const adapter={accountId:()=> '123456789',connected:()=>true,inspect:async(action:AgentMutationAction,r:AgentMutationRequest)=>{
    inspections++;const gate=inspectHold;if(gate)await gate;const c=context(action,r);if(changed)c.target.statusMessage!==undefined?c.target.statusMessage='changed remotely':c.target.text='changed source';if(foreign)c.target.authorId='987654321';
    return {context:c,validate:()=>{},execute:async()=>{calls++;assert.equal(journals[0].get(id)?.state,'sending');if(hold)await hold;if(fail)throw new Error('fixture lost response');return acknowledgement ?? {status:0,...(action==='send_emoticon'?{logId:'9007199254740994'}:{})};}};
  }};
  const create=()=>{const journal=AgentSendJournal.open(root);journals.push(journal);const approvals=fixtureApprovals(journal,root,()=>now);return {journal,approve:approvals.approve,service:new AgentMutationService({principal:'local-mcp',journal,policy,adapter,approvals:approvals.store,now:()=>now})};};
  const initial=create();let id=randomUUID();
  t.after(()=>{for(const j of journals)j.close();removeTestDir(root);});
  return {...initial,root,policy,adapter,create,id:()=>id,next:()=>id=randomUUID(),calls:()=>calls,inspections:()=>inspections,change:()=>{changed=true;},foreign:()=>{foreign=true;},fail:()=>{fail=true;},advance:(ms:number)=>{now+=ms;},acknowledgement:(value:{status:number;logId?:string})=>{acknowledgement=value;},inspectHold:(p:Promise<void>|undefined)=>{inspectHold=p;},hold:(p:Promise<void>)=>{hold=p;}};
}

test('every mutation requires human approval even for notices, then replays only its original acknowledgement after restart',async t=>{
  for(const action of ['send_emoticon','edit_message','delete_message','update_my_profile'] as const){
    const f=fixture(t,true),r=request(action),p=await f.service.prepare(action,f.id(),r);
    assert.equal(p.approvalRequired,true);assert.equal(f.calls(),0);
    await assert.rejects(f.service.commit(action,f.id(),r),{code:'APPROVAL_REQUIRED'});
    f.approve(p);const out=await f.service.commit(action,f.id(),r);
    assert.equal(out.state,'applied_unverified');assert.equal(out.logId,action==='send_emoticon'?'9007199254740994':undefined);
    f.change();const inspections=f.inspections(),restart=f.create();
    assert.deepEqual(await restart.service.commit(action,f.id(),r),out);assert.equal(f.inspections(),inspections);assert.equal(f.calls(),1);
    assert.equal((await restart.service.prepare(action,f.id(),r)).state,'applied_unverified');
    const altered=action==='update_my_profile'?{...r,statusMessage:'different'}:action==='send_emoticon'?{...r,fromLogId:'9007199254740995'}:{...r,logId:'9007199254740995'};
    await assert.rejects(restart.service.commit(action,f.id(),altered),{code:'IDEMPOTENCY_CONFLICT'});
    for(const file of ['kakao.db','kakao.db-wal'])if(fs.existsSync(path.join(f.root,file)))assert.equal(fs.readFileSync(path.join(f.root,file)).includes(Buffer.from('fixture source')),false);
  }
});

test('changed target/source/profile/policy and expiry refuse before a mutation attempt',async t=>{
  for(const action of ['send_emoticon','edit_message','delete_message','update_my_profile'] as const)for(const mode of ['context','expiry','pause'] as const){
    const f=fixture(t),r=request(action),p=await f.service.prepare(action,f.id(),r);f.approve(p);
    if(mode==='context')f.change();if(mode==='expiry')f.advance(300000);if(mode==='pause')f.policy.setPaused(true);
    await assert.rejects(f.service.commit(action,f.id(),r),{code:mode==='expiry'?'OPERATION_EXPIRED':mode==='pause'?'POLICY_DENIED':'OPERATION_STALE'});assert.equal(f.calls(),0);
  }
  const f=fixture(t);f.foreign();await assert.rejects(f.service.prepare('delete_message',f.id(),request('delete_message')),{code:'POLICY_DENIED'});assert.equal(f.calls(),0);
});

test('lost outcome or outcome persistence failure remains fenced across reconstruction for all mutation types',async t=>{
  for(const action of ['send_emoticon','edit_message','delete_message','update_my_profile'] as const)for(const disk of [false,true]){
    const f=fixture(t),r=request(action),p=await f.service.prepare(action,f.id(),r);f.approve(p);
    if(disk)f.journal.db.db.exec(`CREATE TRIGGER fixture_mutation_disk BEFORE UPDATE OF state ON agent_send_operations WHEN NEW.state IN ('applied_unverified','mutation_unknown') BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);else f.fail();
    await assert.rejects(f.service.commit(action,f.id(),r),{code:'MUTATION_OUTCOME_UNKNOWN',retryable:false});
    const restart=f.create();assert.equal((await restart.service.prepare(action,f.id(),r)).state,'mutation_unknown');
    await assert.rejects(restart.service.commit(action,f.id(),r),{code:'MUTATION_OUTCOME_UNKNOWN'});assert.equal(f.calls(),1);
  }
});

test('a failed durable claim cannot execute, and concurrent callers cannot repeat a claimed mutation',async t=>{
  const f=fixture(t),r=request('edit_message'),p=await f.service.prepare('edit_message',f.id(),r);f.approve(p);
  f.journal.db.db.exec(`CREATE TRIGGER fixture_claim BEFORE UPDATE OF state ON agent_send_operations WHEN NEW.state='sending' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END`);
  await assert.rejects(f.service.commit('edit_message',f.id(),r),{code:'INTERNAL'});assert.equal(f.calls(),0);
  f.journal.db.db.exec('DROP TRIGGER fixture_claim');
  let release!:()=>void;f.hold(new Promise<void>(resolve=>{release=resolve;}));
  const pending=f.service.commit('edit_message',f.id(),r);
  while(f.calls()===0)await new Promise<void>(resolve=>setImmediate(resolve));
  await assert.rejects(f.service.commit('edit_message',f.id(),r),{code:'MUTATION_OUTCOME_UNKNOWN'});release();await pending;assert.equal(f.calls(),1);
});

test('mutation claims share durable rate counters and request identities with text sends',async t=>{
  const f=fixture(t,true),r=request('delete_message'),p=await f.service.prepare('delete_message',f.id(),r);f.approve(p);
  await f.service.commit('delete_message',f.id(),r);
  const policy=new SendPolicy({ceiling: [],notifyChatId:'123456789',pausedAtStart:false,auditLogPath:path.join(f.root,'limited'),rateLimit:{windowMs:60000,perChat:1,global:1}},{now:()=>1000000});
  const text=new AgentSendService({principal:'local-mcp',journal:f.journal,policy,now:()=>1000000,notifications:true,adapter:{accountId:()=> '123456789',connected:()=>true,context:()=> 'fixture',send:async()=>{throw new Error('must not send');}}});
  assert.throws(()=>text.prepare(f.id(),{chatId:'123456789',text:'fixture'}),{code:'IDEMPOTENCY_CONFLICT'});
  const id=f.next(),m={chatId:'123456789',text:'fixture'};text.prepare(id,m);await assert.rejects(text.send(id,m),{code:'RATE_LIMITED'});
});


test('a concurrent prepare cannot expire or stale an already applied mutation after awaiting inspection',async t=>{
  const f=fixture(t),r=request('update_my_profile'),p=await f.service.prepare('update_my_profile',f.id(),r);f.approve(p);
  let release!:()=>void;f.inspectHold(new Promise<void>(resolve=>{release=resolve;}));
  const pending=f.service.prepare('update_my_profile',f.id(),r);
  f.inspectHold(undefined);
  await f.service.commit('update_my_profile',f.id(),r);
  f.change();f.advance(300000);release();
  assert.equal((await pending).state,'applied_unverified');assert.equal(f.journal.get(f.id())?.state,'applied_unverified');assert.equal(f.calls(),1);
});

test('schema expansion preserves existing prepared text bindings and durable publication history',async t=>{
  const f=fixture(t,true),id=randomUUID(),message={chatId:'123456789',text:'fixture legacy text'};
  const deps={principal:'local-mcp',journal:f.journal,policy:f.policy,now:()=>1000000,notifications:true,adapter:{accountId:()=> '123456789',connected:()=>true,context:()=> 'fixture legacy context',send:async()=>({status:0,logId:'9007199254740994'})}};
  const before=new AgentSendService(deps).prepare(id,message);
  // Reapply the table-expansion migration to actual existing journal rows, not an empty schema.
  f.journal.db.db.prepare('DELETE FROM schema_migrations WHERE version=5').run();
  const reopened=AgentSendJournal.open(f.root);t.after(()=>reopened.close());
  const upgraded=new AgentSendService({...deps,journal:reopened});
  assert.equal(upgraded.prepare(id,message).signingText,before.signingText);
  assert.equal((await upgraded.send(id,message)).logId,'9007199254740994');
});


test('missing/malformed acknowledgements stay unknown, and unsupported edits fail before any mutation',async t=>{
  for(const acknowledgement of [{status:undefined},{status:1},{status:0,logId:9007199254740992}]){
    const f=fixture(t),r=request('update_my_profile'),p=await f.service.prepare('update_my_profile',f.id(),r);f.approve(p);
    f.acknowledgement(acknowledgement as {status:number;logId?:string});
    await assert.rejects(f.service.commit('update_my_profile',f.id(),r),{code:'MUTATION_OUTCOME_UNKNOWN'});
    await assert.rejects(f.create().service.commit('update_my_profile',f.id(),r),{code:'MUTATION_OUTCOME_UNKNOWN'});assert.equal(f.calls(),1);
  }
  const f=fixture(t),adapter={...f.adapter,inspect:async(action:AgentMutationAction,r:AgentMutationRequest)=>{const source=await f.adapter.inspect(action,r);source.context.target.type=20;return source;}};
  const service=new AgentMutationService({principal:'local-mcp',journal:f.journal,policy:f.policy,adapter});
  await assert.rejects(service.prepare('edit_message',f.id(),request('edit_message')),{code:'INVALID_ARGUMENT'});assert.equal(f.calls(),0);
});

test('own edit and delete in the memo chat need no approval; other mutations and other rooms still ask',async t=>{
  const f=fixture(t);
  const memo=(journal:AgentSendJournal)=>new AgentMutationService({principal:'local-mcp',journal,policy:f.policy,adapter:f.adapter,approvals:fixtureApprovals(journal,f.root).store,isMemoChat:id=>id==='123456789'});
  const service=memo(f.journal);
  for(const action of ['edit_message','delete_message'] as const){
    f.next();const r=request(action);
    assert.equal((await service.prepare(action,f.id(),r)).approvalRequired,false);
    assert.equal((await service.commit(action,f.id(),r)).state,'applied_unverified');
  }
  f.next();const emoticon=request('send_emoticon');
  assert.equal((await service.prepare('send_emoticon',f.id(),emoticon)).approvalRequired,true);
  f.next();const elsewhere={...request('delete_message'),chatId:'987654321'};
  assert.equal((await service.prepare('delete_message',f.id(),elsewhere)).approvalRequired,true);
  assert.equal(f.calls(),2);
});
