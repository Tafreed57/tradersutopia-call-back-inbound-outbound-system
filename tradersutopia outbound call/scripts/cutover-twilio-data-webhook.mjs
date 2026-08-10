import nextEnv from "@next/env";
import twilio from "twilio";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_AUTH;
if (!accountSid || !authToken) throw new Error("Twilio credentials are not configured");

const serviceSid = "ZS460b4815c0556adeef4f71a4b0ba47a7";
const environmentSid = "ZE742b39f7f4635ac14b83afd8ff01a418";
const webhookUrl = "https://tradersutopia-callback-dashboard.vercel.app/api/twilio-data";
const targets = new Map([
  ["/conference_wait", "postBody"],
  ["/timeout_action", "postBody"],
  ["/agent_whisper_accept", "postBody"],
  ["/agent_call_status", "endBody"],
]);

const client = twilio(accountSid, authToken);
const environment = await client.serverless.v1
  .services(serviceSid)
  .environments(environmentSid)
  .fetch();
const currentBuild = await client.serverless.v1
  .services(serviceSid)
  .builds(environment.buildSid)
  .fetch();

function addWebhookSecretHeader(content, bodyVariable, path) {
  if (content.includes("'x-call-routing-secret': (context.CALL_ROUTING_SECRET || '').trim()")) {
    return content;
  }
  const needle = `'Content-Length': Buffer.byteLength(${bodyVariable})`;
  const index = content.indexOf(needle);
  if (index < 0) throw new Error(`Could not find webhook headers in ${path}`);
  const lineStart = content.lastIndexOf("\n", index) + 1;
  const indent = content.slice(lineStart, index);
  return content.replace(
    needle,
    `${needle},\n${indent}'x-call-routing-secret': (context.CALL_ROUTING_SECRET || '').trim()`
  );
}

async function uploadFunctionVersion(item, content) {
  const form = new FormData();
  form.set("Path", item.path);
  form.set("Visibility", item.visibility);
  form.set("Content", new Blob([content], { type: "application/javascript" }), "index.js");
  const response = await fetch(
    `https://serverless-upload.twilio.com/v1/Services/${serviceSid}/Functions/${item.function_sid}/Versions`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      body: form,
    }
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.sid) {
    throw new Error(`Failed to upload ${item.path}: ${result.message || response.status}`);
  }
  return result.sid;
}

const functionVersions = [];
for (const item of currentBuild.functionVersions) {
  const bodyVariable = targets.get(item.path);
  if (!bodyVariable) {
    functionVersions.push(item.sid);
    continue;
  }
  const version = await client.serverless.v1
    .services(serviceSid)
    .functions(item.function_sid)
    .functionVersions(item.sid)
    .functionVersionContent()
    .fetch();
  const content = addWebhookSecretHeader(version.content, bodyVariable, item.path);
  const newSid = await uploadFunctionVersion(item, content);
  functionVersions.push(newSid);
  console.log(`${item.path}: ${newSid}`);
}

const build = await client.serverless.v1.services(serviceSid).builds.create({
  functionVersions,
  assetVersions: (currentBuild.assetVersions || []).map((item) => item.sid),
  dependencies: JSON.stringify(currentBuild.dependencies || []),
  runtime: currentBuild.runtime,
});

let completedBuild = build;
for (let attempt = 0; attempt < 60; attempt++) {
  completedBuild = await client.serverless.v1.services(serviceSid).builds(build.sid).fetch();
  if (completedBuild.status === "completed") break;
  if (completedBuild.status === "failed") throw new Error(`Twilio build ${build.sid} failed`);
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (completedBuild.status !== "completed") throw new Error(`Twilio build ${build.sid} timed out`);

const deployment = await client.serverless.v1
  .services(serviceSid)
  .environments(environmentSid)
  .deployments.create({ buildSid: build.sid });

const variables = await client.serverless.v1
  .services(serviceSid)
  .environments(environmentSid)
  .variables.list({ limit: 100 });
const callbackVariable = variables.find((item) => item.key === "CALLBACK_SCRIPT_URL");
if (!callbackVariable) throw new Error("CALLBACK_SCRIPT_URL is missing from Twilio");
await client.serverless.v1
  .services(serviceSid)
  .environments(environmentSid)
  .variables(callbackVariable.sid)
  .update({ value: webhookUrl });

console.log(`Twilio build ${build.sid} deployed as ${deployment.sid}`);
console.log(`CALLBACK_SCRIPT_URL=${webhookUrl}`);
