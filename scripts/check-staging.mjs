import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';

const config = dotenv.parse(await readFile('.env.staging'));
const origin = 'https://localhost:3100';
assert.equal(config.APP_ORIGIN, origin, 'This check only targets isolated local staging');
const request = (path, options = {}) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(15000) });
const home = await request('/');
assert.equal(home.status, 200);
assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/);
assert.equal(home.headers.get('x-frame-options'), 'DENY');
const ready = await request('/api/health/ready');
assert.equal(ready.status, 200);
assert.equal((await ready.json()).ready, true);
assert.equal((await request('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'test' }) })).status, 401);
const login = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: config.LOCAL_ADMIN_USERNAME, password: config.LOCAL_ADMIN_PASSWORD }) });
assert.equal(login.status, 200, 'Staging admin login');
const rawCookie = login.headers.get('set-cookie');
assert.ok(rawCookie?.includes('HttpOnly'));
assert.ok(/SameSite=Lax/i.test(rawCookie), 'SameSite cookie protection');
const cookie = rawCookie.split(';')[0];
const crossOrigin = await request('/api/voice/tts', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'test' }) });
assert.equal(crossOrigin.status, 403, 'Reject foreign-origin mutation');
const start = performance.now();
const results = await Promise.all(Array.from({ length: 10 }, async () => {
  const response = await request('/api/trpc/studio.list', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.result?.data?.json), 'Authenticated workspace list');
}));
const salesforceResponse = await request('/api/trpc/salesforce.status', { headers: { Cookie: cookie } });
assert.equal(salesforceResponse.status, 200, 'Salesforce status endpoint');
const salesforceStatus = (await salesforceResponse.json()).result?.data?.json;
assert.equal(typeof salesforceStatus?.configured, 'boolean', 'Salesforce configuration status');
// Do not call logout here: local logout deliberately revokes this user's saved
// Salesforce token. This health check must not disconnect the person running it.
console.log(JSON.stringify({ staticPage: 'passed', services: 'ready', login: 'passed', logout: 'not run (preserves connected CRM accounts)', cookieFlags: 'passed', unauthenticatedVoice: 'blocked', foreignOrigin: 'blocked', concurrentAuthenticatedReads: results.length, batchMs: Math.round(performance.now() - start), salesforceConfigured: salesforceStatus.configured, salesforceConnected: salesforceStatus.connected }));
