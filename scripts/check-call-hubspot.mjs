import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';

// Local-only smoke test. No CRM create, update, delete, import or logout calls.
const config = dotenv.parse(await readFile('.env.staging'));
const origin = 'https://localhost:3100';
assert.equal(config.APP_ORIGIN, origin);
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({ username: config.LOCAL_ADMIN_USERNAME, password: config.LOCAL_ADMIN_PASSWORD }), signal: AbortSignal.timeout(15000) });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
async function rpc(name, input, mutation = false) {
  const encoded = JSON.stringify({ json: input });
  const response = await fetch(`${origin}/api/trpc/${name}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    ...(mutation ? { body: encoded } : {}), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok) return { ok: false, status: response.status, message: body.error?.json?.message ?? 'Request failed' };
  return { ok: true, data: body.result?.data?.json };
}
const summary = {};
const connection = await rpc('hubspot.connection', undefined);
summary.hubspotLogin = connection.ok ? { oauthConfigured: connection.data.oauthConfigured, mode: connection.data.mode, persistent: connection.data.persistent } : connection;
const sfObjects = await rpc('salesforce.objects', undefined);
summary.salesforceObjects = sfObjects.ok ? Object.fromEntries(['Account', 'Contact', 'Opportunity', 'Task', 'Lead', 'Case'].map(name => [name, sfObjects.data.some(object => object.name === name)])) : sfObjects;
if (sfObjects.ok) {
  const sfCall = await rpc('voice.liveCall.start', { source: 'salesforce', timezone: 'Asia/Kuala_Lumpur', language: 'en' }, true);
  assert.ok(sfCall.ok && sfCall.data.id);
  try {
    const reply = await rpc('voice.liveCall.turn', { callId: sfCall.data.id, requestId: crypto.randomUUID(), text: 'hello' }, true);
    assert.ok(reply.ok && reply.data.text && !reply.data.reviewId);
    summary.salesforceCall = 'start, greeting and end checked';
  } finally { await rpc('voice.liveCall.end', { callId: sfCall.data.id }, true); }
}
const call = await rpc('voice.liveCall.start', { source: 'local', timezone: 'Asia/Kuala_Lumpur', language: 'en' }, true);
assert.ok(call.ok && call.data.id);
try {
  const reply = await rpc('voice.liveCall.turn', { callId: call.data.id, requestId: crypto.randomUUID(), text: 'hello' }, true);
  assert.ok(reply.ok && reply.data.text && !reply.data.reviewId);
  summary.callSession = 'start, greeting and end checked';
  const general = await rpc('voice.liveCall.turn', { callId: call.data.id, requestId: crypto.randomUUID(), text: 'Why is the sky blue?' }, true);
  assert.ok(general.ok && general.data.text && !general.data.reviewId && !general.data.saved, 'Read-only general question in a live call');
  summary.generalQuestion = 'answered without a CRM change';
} finally { await rpc('voice.liveCall.end', { callId: call.data.id }, true); }
const audio = await fetch(`${origin}/api/voice/tts`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Hello. Your local voice call is ready.', language: 'en' }), signal: AbortSignal.timeout(30000) });
summary.speechPlayback = audio.ok && (await audio.arrayBuffer()).byteLength > 44 ? 'audio generated' : `HTTP ${audio.status}`;
const connected = await rpc('hubspot.status', undefined); summary.hubspot = connected.ok ? connected.data : connected;
summary.objects = {};
if (connected.ok && connected.data.configured) {
  const catalog = await rpc('hubspot.objects', undefined);
  summary.customObjectDiscovery = catalog.ok ? catalog.data.warning || 'available' : catalog.message;
  for (const object of ['contacts', 'companies', 'deals', 'tickets', 'tasks', 'notes', 'calls', 'emails', 'meetings', 'products', 'line_items', 'quotes']) {
    const page = await rpc('hubspot.records', { object, limit: 1 });
    summary.objects[object] = page.ok ? { readable: true, sampleCount: page.data.records.length, morePages: !!page.data.after } : { readable: false, status: page.status, message: page.message };
    if (object === 'contacts' && page.ok && page.data.records[0]) {
      const detail = await rpc('hubspot.record', { object, id: page.data.records[0].id });
      summary.recordDetail = detail.ok ? { propertyCount: Object.keys(detail.data.properties).length } : detail.message;
    }
  }
}
console.log(JSON.stringify(summary, null, 2));
// A provider/read failure must not be mistaken for a successful release check.
assert.ok(sfObjects.ok, 'Salesforce object read failed; inspect the summary and retry only after diagnosis');
assert.equal(summary.speechPlayback, 'audio generated');
