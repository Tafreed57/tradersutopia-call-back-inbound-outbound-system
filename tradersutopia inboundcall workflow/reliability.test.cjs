const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.resolve(__dirname, '../tradersutopia outbound call/callback-dashboard/package.json'));
const Twilio = appRequire('twilio');
const callerSid = 'CA' + '1'.repeat(32);
const agentSid = 'CA' + '2'.repeat(32);
const otherSid = 'CA' + '3'.repeat(32);
const conf = 'TU_' + callerSid;

function setup(options = {}) {
  const items = new Map();
  const calls = [];
  const posts = [];
  const requests = [];
  const apiCalls = Object.assign(() => ({
    fetch: async () => ({ from: '+15550000001', to: '+18444844459', status: options.status || 'in-progress' }),
    update: async () => ({}),
  }), {
    list: async () => [],
    create: async p => {
      calls.push(p);
      if(options.failCreate) throw new Error('Provider rejected call');
      return { sid: agentSid };
    },
  });
  const mapItems = Object.assign(key => ({
    fetch: async () => { if(!items.has(key)) throw Object.assign(new Error('Missing'),{status:404}); return {data:items.get(key).data}; },
    update: async value => { items.set(key,value); return value; },
    remove: async () => items.delete(key),
  }), {
    create: async value => {
      if(items.has(value.key)) throw Object.assign(new Error('Exists'), {status:409});
      items.set(value.key,value);
      return value;
    }
  });
  const maps = Object.assign(() => ({syncMapItems:mapItems}), {create:async()=>({})});
  const client = {
    calls:apiCalls,
    sync:{v1:{services:()=>({syncMaps:maps})}},
    messages:{create:async()=>({})}
  };
  const https = {
    request: (p, cb) => {
      requests.push(p);
      const req=new EventEmitter();
      req.write=()=>{};
      req.destroy=()=>{};
      req.end=()=>queueMicrotask(()=>{
        const res=new EventEmitter(); res.statusCode=200; cb(res);
        res.emit('data',JSON.stringify({ok:true,agents:['+15550000002'],fromNumber:'+18444844459'}));
        res.emit('end');
      });
      return req;
    }
  };
  const context={
    DOMAIN_NAME:'example.twil.io',FROM_NUMBER:'+18555077602',AGENT_LIST:'+15550000099',
    CALL_ROUTING_URL:'https://example.com/api/call-routing/runtime',CALL_ROUTING_SECRET:'test',
    SYNC_SERVICE_SID:'IS'+'1'.repeat(32),getTwilioClient:()=>client,
  };
  function run(name,event,extra={}){
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,name+'.js'),'utf8'),{
      exports:module.exports,require:n=>n==='https'?https:require(n),
      Twilio,URL,URLSearchParams,Buffer,AbortSignal,
      fetch:async(url,p)=>{posts.push(JSON.parse(p.body));return new Response('{}',{status:options.postStatus || 200});},
      console:{log(){},warn(){},error(){}},
    });
    return new Promise((resolve,reject)=>{
      Promise.resolve(module.exports.handler({...context,...extra},event,(err,value)=>err?reject(err):resolve(value))).catch(reject);
    });
  }
  return {run,items,calls,posts,requests};
}
test('Studio wrapped form uses actual inbound line and dashboard agents',async()=>{
  const s=setup();
  await s.run('simulring_agents',{body:'conferenceName='+conf+'&callerCallSid='+callerSid});
  assert.equal(s.calls.length,1);
  assert.equal(s.calls[0].to,'+15550000002');
  assert.equal(s.calls[0].from,'+18444844459');
  assert.equal(new URL('https://example.com'+s.requests[0].path).searchParams.get('calledNumber'),'+18444844459');
});
test('conference name recovers missing caller SID',async()=>{
  const s=setup(); await s.run('simulring_agents',{conferenceName:conf});
  assert.equal(s.calls.length,1);
  assert.equal(new URL(s.calls[0].url).searchParams.get('callerCallSid'),callerSid);
});
test('ended caller never starts ringing agents',async()=>{
  const s=setup({status:'completed'}); await s.run('simulring_agents',{conferenceName:conf});
  assert.equal(s.calls.length,0);
});
test('failed outbound creation releases the agent claim',async()=>{
  const s=setup({failCreate:true}); await s.run('simulring_agents',{conferenceName:conf});
  assert(!s.items.has('+15550000002'));
});
test('late acceptance does not join a disconnected caller',async()=>{
  const s=setup({status:'completed'});
  const result=await s.run('agent_whisper_accept',{conferenceName:conf,Digits:'1',CallSid:agentSid,To:'+15550000002'});
  assert.match(result.toString(),/<Hangup/);
  assert.doesNotMatch(result.toString(),/<Conference/);
});
test('only the winning agent can join the conference',async()=>{
  const s=setup();
  s.items.set('winner_'+conf,{data:{callSid:otherSid}});
  const result=await s.run('agent_whisper_accept',{conferenceName:conf,Digits:'1',CallSid:agentSid,To:'+15550000002'});
  assert.match(result.toString(),/<Hangup/);
  assert.doesNotMatch(result.toString(),/<Conference/);
});
test('accepted agent lease survives calls longer than five minutes',async()=>{
  const s=setup();
  s.items.set('+15550000002',{data:{conferenceName:conf}});
  s.items.set(conf,{data:{callSids:[agentSid],agents:['+15550000002']}});
  const result=await s.run('agent_whisper_accept',{conferenceName:conf,Digits:'1',CallSid:agentSid,To:'+15550000002'});
  assert.match(result.toString(),/<Conference/);
  assert.match(result.toString(),/conference_status_callback#rc=2&amp;rp=ct,rt,5xx&amp;rt=5000/);
  assert.equal(s.items.get('+15550000002').ttl,14400);
  assert.equal(s.items.get('+15550000002').data.callSid,agentSid);
});
test('actual agent join persists answer, caller join does not',async()=>{
  const s=setup();
  const extra={CALLBACK_SCRIPT_URL:'https://example.com/api/twilio-data'};
  await s.run('conference_status_callback',{FriendlyName:conf,StatusCallbackEvent:'participant-join',CallSid:callerSid},extra);
  assert.equal(s.posts.length,0);
  await s.run('conference_status_callback',{FriendlyName:conf+'_retry',StatusCallbackEvent:'participant-join',CallSid:agentSid},extra);
  assert.equal(s.posts[0].event,'inbound_agent_joined');
  assert.equal(s.posts[0].call_sid,callerSid);
});
test('failed outcome delivery retries and returns an error',async()=>{
  const s=setup({postStatus:500});
  await assert.rejects(s.run('conference_status_callback',{FriendlyName:conf,StatusCallbackEvent:'participant-leave',CallSid:callerSid},{CALLBACK_SCRIPT_URL:'https://example.com/api/twilio-data'}));
  assert.equal(s.posts.length,2);
});

test('caller conference requests transport retries for outcome callbacks',async()=>{
  const s=setup();
  const result=await s.run('join_conference',{conferenceName:conf,CallSid:callerSid,From:'+15550000001',To:'+18444844459'});
  assert.match(result.toString(),/conference_status_callback#rc=2&amp;rp=ct,rt,5xx&amp;rt=5000/);
  assert.match(result.toString(),/record="record-from-start"/);
});
