import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../scripts/backfill-inbound-outcomes.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "");
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  "nextEnv", "twilio", "readFile", "process", "fetch", "console", source
);
const sid = digit => "CA" + digit.repeat(32);
const ended = new Date(Date.now() - 300_000);
function call(digit, overrides = {}) {
  return { sid:sid(digit), from:"+14165551234", to:"+18555077602", direction:"inbound",
    status:"completed", startTime:new Date(ended.getTime()-60_000), endTime:ended, ...overrides };
}
async function backfill({calls=[], live=[], verified=[], args=["--apply"]} = {}) {
  const saved=[];
  const output=[];
  const exit = Symbol("exit");
  try {
    await run({loadEnvConfig(){}}, ()=>({calls:{list:async()=>calls}}),
      async()=>JSON.stringify(verified),
      {cwd:()=>".",argv:["node","script",...args],env:{TWILIO_SID:"test",TWILIO_AUTH:"test",CALLBACK_DB_API_URL:"https://example.test",CALLBACK_DB_API_SECRET:"test"},exit:()=>{throw exit;}},
      async(_url,options)=>{
        const {action,payload}=JSON.parse(options.body);
        let data;
        if(action==="routing.get")data={lines:[{phone:"+18555077602"}]};
        else if(action==="live_calls.list")data=live;
        else if(action==="inbound.record"){saved.push(payload);data={recorded:true};}
        else throw new Error("Unexpected action "+action);
        return {ok:true,json:async()=>({ok:true,data})};
      }, {log:value=>output.push(value)});
  } catch(error) { if(error!==exit)throw error; }
  return {saved,output};
}

test("unknown history does not become a missed callback",async()=>{
  const result=await backfill({calls:[call("1")]});
  assert.deepEqual(result.saved,[]);
  assert.equal(JSON.parse(result.output[0]).unverifiedSkipped,1);
});

test("only audited, ended, settled calls on dashboard lines are eligible",async()=>{
  const result=await backfill({
    calls:[call("1"),call("2",{status:"in-progress"}),call("3",{endTime:null}),
      call("4",{endTime:new Date()}),call("5",{to:"+18095551234"}),call("6",{direction:"outbound-api"})],
    verified:[1,2,3,4,5,6].map(n=>sid(String(n))),args:["--apply","--verified-missed=audit.json"]
  });
  assert.equal(result.saved.length,1);
  assert.equal(result.saved[0].callSid,sid("1"));
  assert.equal(result.saved[0].answeredAt,null);
});

test("accepted retry calls remain answered even if also in the missed audit",async()=>{
  const started=ended.toISOString();
  const result=await backfill({calls:[call("1")],live:[{conferenceName:`TU_${sid("1")}_retry`,startTime:started}],
    verified:[sid("1")],args:["--apply","--verified-missed=audit.json"]});
  assert.equal(result.saved[0].answeredAt,started);
});

test("dry run never writes",async()=>{
  const result=await backfill({calls:[call("1")],verified:[sid("1")],args:["--verified-missed=audit.json"]});
  assert.deepEqual(result.saved,[]);
});

test("reject truncated call history and malformed audit lists",async()=>{
  await assert.rejects(backfill({calls:Array(5000).fill(call("1"))}),/reached its limit/);
  await assert.rejects(backfill({verified:["not-a-call"],args:["--verified-missed=audit.json"]}),/audited missed/);
});

test("both application copies use the same recovery policy",async()=>{
  const deployed=await readFile(new URL("../scripts/backfill-inbound-outcomes.mjs",import.meta.url),"utf8");
  const outer=await readFile(new URL("../../scripts/backfill-inbound-outcomes.mjs",import.meta.url),"utf8");
  assert.equal(deployed,outer);
});
