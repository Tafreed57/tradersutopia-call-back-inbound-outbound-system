import nextEnv from "@next/env";
import twilio from "twilio";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH;
if (!accountSid || !authToken) throw new Error("Twilio credentials are not configured");

const serviceSid = "ZS460b4815c0556adeef4f71a4b0ba47a7";
const environmentSid = "ZE742b39f7f4635ac14b83afd8ff01a418";
const syncServiceSid = "ISad179c06d3a06644eb350138bb5ed59c";
const flowSid = "FW0e50c6f78cbeb6ac755a8db47dfe7015";
const appUrl = "https://tradersutopia-callback-dashboard.vercel.app";
const statusUrl = appUrl + "/api/inbound-status#rc=2&rp=ct,rt,5xx";
const inboundNumbers = ["+18555077602", "+18444844459"];
const replacements = new Map([
  ["/simulring_agents", "simulring_agents.js"],
  ["/agent_whisper_accept", "agent_whisper_accept.js"],
  ["/conference_status_callback", "conference_status_callback.js"],
  ["/agent_call_status", "agent_call_status.js"],
  ["/join_conference", "join_conference.js"],
]);
const here = path.dirname(fileURLToPath(import.meta.url));
const workflow = path.resolve(here, "../../../tradersutopia inboundcall workflow");
const client = twilio(accountSid, authToken);
const expectedBuild = process.argv.find(value => value.startsWith("--expected-build="))?.split("=")[1];
if (!expectedBuild) throw new Error("Supply --expected-build=<current Twilio build SID> before deploying");

async function upload(item, filename) {
  const content = await readFile(path.join(workflow, filename), "utf8");
  const form = new FormData();
  form.set("Path", item.path);
  form.set("Visibility", "protected");
  form.set("Content", new Blob([content], { type: "application/javascript" }), "index.js");
  const response = await fetch(
    `https://serverless-upload.twilio.com/v1/Services/${serviceSid}/Functions/${item.function_sid}/Versions`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
      body: form,
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.sid) throw new Error(`Upload failed for ${item.path}: ${result.message || response.status}`);
  console.log(`${item.path}: ${result.sid}`);
  return result.sid;
}

const environment = await client.serverless.v1.services(serviceSid).environments(environmentSid).fetch();
if (environment.buildSid !== expectedBuild) throw new Error("Twilio changed since review; inspect the current build first");
await client.sync.v1.services(syncServiceSid).fetch();
const health = await fetch(appUrl + "/api/inbound-status", { method: "POST", body: "" });
if (health.status !== 403) throw new Error("Deploy and verify the new dashboard endpoint before changing Twilio");
const current = await client.serverless.v1.services(serviceSid).builds(environment.buildSid).fetch();
const flow = await client.studio.v2.flows(flowSid).fetch();
const numbers = await client.incomingPhoneNumbers.list({ limit: 100 });
const targets = inboundNumbers.map(number => {
  const target = numbers.find(item => item.phoneNumber === number);
  if (!target || !target.voiceUrl?.includes(flowSid)) throw new Error(`Unexpected voice flow on ${number}`);
  return target;
});
await mkdir(".vercel/investigation", { recursive: true });
await writeFile(".vercel/investigation/twilio-reliability-before.json", JSON.stringify({
  buildSid: current.sid,
  flow: { sid: flow.sid, revision: flow.revision, definition: flow.definition },
  numbers: targets.map(item => ({ sid: item.sid, statusCallback: item.statusCallback, statusCallbackMethod: item.statusCallbackMethod })),
}, null, 2));
for (const target of replacements.keys()) {
  if (!current.functionVersions.some(item => item.path === target)) throw new Error(`Missing function ${target}`);
}
const versions = [];
for (const item of current.functionVersions) {
  const filename = replacements.get(item.path);
  versions.push(filename ? await upload(item, filename) : item.sid);
}
const build = await client.serverless.v1.services(serviceSid).builds.create({
  functionVersions: versions,
  assetVersions: (current.assetVersions || []).map(item => item.sid),
  dependencies: JSON.stringify(current.dependencies || []),
  runtime: current.runtime,
});
let ready = build;
for (let attempt = 0; attempt < 60; attempt++) {
  ready = await client.serverless.v1.services(serviceSid).builds(build.sid).fetch();
  if (ready.status === "completed") break;
  if (ready.status === "failed") throw new Error(`Twilio build ${build.sid} failed`);
  await new Promise(resolve => setTimeout(resolve, 2000));
}
if (ready.status !== "completed") throw new Error(`Twilio build ${build.sid} timed out`);
const latest = await client.serverless.v1.services(serviceSid).environments(environmentSid).fetch();
if (latest.buildSid !== expectedBuild) throw new Error("Another Twilio deployment occurred during the build");
const deployment = await client.serverless.v1.services(serviceSid).environments(environmentSid)
  .deployments.create({ buildSid: build.sid });

const variables = await client.serverless.v1.services(serviceSid).environments(environmentSid)
  .variables.list({ limit: 100 });
const syncVariable = variables.find(item => item.key === "SYNC_SERVICE_SID");
if (!syncVariable) throw new Error("SYNC_SERVICE_SID is missing");
await client.serverless.v1.services(serviceSid).environments(environmentSid)
  .variables(syncVariable.sid).update({ value: syncServiceSid });

for (const target of targets) {
  await client.incomingPhoneNumbers(target.sid).update({
    statusCallback: statusUrl,
    statusCallbackMethod: "POST",
  });
  console.log(`${target.phoneNumber}: inbound status tracking enabled`);
}

const definition = structuredClone(flow.definition);
const latestFlow = await client.studio.v2.flows(flowSid).fetch();
if (latestFlow.revision !== flow.revision) throw new Error("Studio changed during deployment; review the flow before publishing");
const ringState = definition.states.find(state => state.name === "simulring_agents");
if (ringState) {
  ringState.properties.add_twilio_auth = true;
  ringState.transitions = ringState.transitions.map(transition => transition.event === "failed"
    ? { ...transition, next: "redirect_to_conference" } : transition);
}
const sayState = definition.states.find(state => state.name === "say_play_1");
if (sayState) sayState.transitions = [{ event: "audioComplete" }];
// The terminal number callback is authoritative, so the old Google Sheets
// request is removed from the published flow completely.
definition.states = definition.states.filter(state => state.name !== "http_1");
await client.studio.v2.flows(flowSid).update({
  status: "published",
  definition,
  commitMessage: "Track final inbound outcomes and remove legacy Sheets callback",
});

console.log(`Twilio build ${build.sid} deployed as ${deployment.sid}`);
console.log("Inbound reliability configuration completed");
