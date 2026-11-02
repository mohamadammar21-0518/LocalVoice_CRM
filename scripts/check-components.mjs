import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import superjson from 'superjson';

// Creates and removes only this run's temporary local user and its records.
if (!process.argv.includes('--run')) throw new Error('Pass --run for isolated local component acceptance');
const config = dotenv.parse(await readFile('.env.staging'));
const origin = 'https://localhost:3100';
assert.equal(config.APP_ORIGIN, origin);
const request = (path, options = {}) => fetch(origin + path, { ...options, signal: AbortSignal.timeout(30000) });
async function login(username, password) {
  const response = await request('/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(response.status, 200, 'Local login');
  return response.headers.get('set-cookie').split(';')[0];
}
async function rpc(cookie, name, input, mutation = false) {
  const encoded = JSON.stringify(superjson.serialize(input));
  const response = await request(`/api/trpc/${name}${mutation ? '' : `?input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    ...(mutation ? { body: encoded } : {}),
  });
  assert.equal(response.status, 200, name);
  return superjson.deserialize((await response.json()).result.data);
}
const admin = await login(config.LOCAL_ADMIN_USERNAME, config.LOCAL_ADMIN_PASSWORD);
const username = `release_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
let created = false, userId;
try {
  for (const route of ['dashboard.get', 'integrations.hubspotStatus', 'voice.history', 'studio.list', 'admin.listUsers']) await rpc(admin, route);
  await rpc(admin, 'admin.createUser', { username, password, name: username }, true);
  created = true;
  const cookie = await login(username, password);
  const user = await rpc(cookie, 'auth.me');
  assert.equal(user.name, username); userId = user.id;
  assert.equal((await rpc(cookie, 'contacts.list')).length, 0, 'New account is isolated');
  const contact = await rpc(cookie, 'contacts.create', { firstName: 'Release', lastName: 'Fixture', email: `${username}@example.invalid` }, true);
  assert.ok(contact.id);
  await rpc(cookie, 'contacts.update', { id: contact.id, firstName: 'Release', lastName: 'Fixture', company: 'Local acceptance only' }, true);
  assert.equal((await rpc(cookie, 'contacts.get', { id: contact.id })).company, 'Local acceptance only');
  assert.equal(await rpc(admin, 'contacts.get', { id: contact.id }), undefined, 'Another owner cannot read the fixture');
  await rpc(cookie, 'interactions.create', { contactId: contact.id, kind: 'note', body: 'Synthetic release acceptance note' }, true);
  assert.equal((await rpc(cookie, 'interactions.list', { contactId: contact.id }))[0].body, 'Synthetic release acceptance note');
  const dueAt = new Date(Date.now() + 86400000);
  await rpc(cookie, 'tasks.create', { contactId: contact.id, title: 'Synthetic release follow-up', dueAt }, true);
  const [{ task }] = await rpc(cookie, 'tasks.list'); assert.ok(task.id);
  await rpc(cookie, 'tasks.update', { id: task.id, contactId: contact.id, title: 'Updated fixture', dueAt }, true);
  await rpc(cookie, 'tasks.toggle', { id: task.id, completed: true }, true);
  assert.equal((await rpc(cookie, 'tasks.list'))[0].task.status, 'completed');
  await rpc(cookie, 'tasks.toggle', { id: task.id, completed: false }, true);
  assert.equal((await rpc(cookie, 'tasks.list'))[0].task.status, 'open');
  await rpc(cookie, 'contacts.delete', { id: contact.id }, true);
  assert.equal((await rpc(cookie, 'contacts.list')).length, 0);
  assert.equal((await rpc(cookie, 'tasks.list')).length, 0, 'Contact deletion removes its fixture follow-ups');
  if (process.argv.includes('--voice')) {
    const started = performance.now();
    const audioResponse = await request('/api/voice/tts', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Show my open tasks.', language: 'en' }) });
    assert.equal(audioResponse.status, 200, 'English speech synthesis');
    const audio = Buffer.from(await audioResponse.arrayBuffer());
    assert.ok(audio.length > 44);
    const synthesisMs = Math.round(performance.now() - started);
    const recognitionStart = performance.now();
    const result = await rpc(cookie, 'voice.transcribe', { audioBase64: audio.toString('base64'), mimeType: 'audio/wav', filename: 'release-synthetic.wav', language: 'en' }, true);
    assert.match(result.transcript, /show my open tasks/i, 'Synthetic English transcription');
    console.log(JSON.stringify({ syntheticEnglishSpeechPassed: true, synthesisMs, transcriptionMs: Math.round(performance.now() - recognitionStart), note: 'Synthetic audio is not a real microphone or accent accuracy test.' }));
  }
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.equal(await rpc(cookie, 'auth.me'), null, 'Old session is revoked');
  const blocked = await request('/api/trpc/contacts.list', { headers: { Cookie: cookie } });
  assert.equal(blocked.status, 401, 'Signed-out session cannot read records');
  console.log('PASS: shell reads, user isolation, contact CRUD, notes, task create/edit/complete/reopen, cascading deletion, sign-out and session revocation');
} finally {
  if (created) {
    const users = await rpc(admin, 'admin.listUsers');
    const fixture = users.find(user => user.name === username && (userId === undefined || user.id === userId));
    if (fixture) await rpc(admin, 'admin.deleteUser', { id: fixture.id }, true);
    console.log('Removed only this run’s temporary local account and fixtures.');
  }
}
