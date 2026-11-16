'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: connect } = require('socket.io-client');

// Node's test runner isolates this file in its own process. Mock the auth SDK
// before loading the production entry point; no live Supabase project is used.
process.env.SUPABASE_URL = 'https://auth.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-key';
process.env.SUPABASE_ANON_KEY = 'mock-public-key';
process.env.ADMIN_EMAIL = 'admin@example.test';
delete process.env.PUBLIC_ORIGIN;
const authCalls = [];
const sdkPath = require.resolve('@supabase/supabase-js');
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: {
  createClient: () => ({ auth: { getUser: async token => {
    authCalls.push(token);
    if (token === 'service-down') return { error: { status: 503 } };
    if (['admin-google', 'another-google', 'password-only', 'linked-google'].includes(token)) return { data: { user: {
      id: token, email: token === 'another-google' ? 'another@example.test' : 'ADMIN@example.test',
      app_metadata: { provider: ['password-only', 'linked-google'].includes(token) ? 'email' : 'google' },
      identities: token === 'linked-google' ? [{ provider: 'google' }] : [],
    } } };
    return { error: { status: 401 } };
  } } }),
} };
const app = require('../server');
let url;
const clients = [];

test.before(async () => {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  url = `http://127.0.0.1:${app.server.address().port}`;
});
test.beforeEach(() => {
  clients.splice(0).forEach(socket => socket.disconnect());
  for (const code of app.rooms.keys()) app.realtime.deleteRoom(code);
});
test.after(async () => {
  clients.forEach(socket => socket.disconnect());
  await app.close();
});

async function adminLogin(token) {
  const response = await fetch(url + '/api/admin/auth', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return { response, data: await response.json() };
}
async function classroom(name = 'Class') {
  const sessionResponse = await fetch(url + '/api/host/session');
  const session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  const create = await fetch(url + '/api/rooms', { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ lectureName: name }) });
  assert.equal(create.status, 201);
  return { ...(await create.json()), token: session.token, cookie };
}
async function socketClient() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false, autoConnect: false });
  clients.push(socket);
  const connected = new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  socket.connect();
  await connected;
  return socket;
}
const ack = (socket, event, payload) => socket.timeout(2000).emitWithAck(event, payload);

test('only the designated Google account receives an administrator session', async () => {
  assert.equal((await adminLogin('invalid')).response.status, 401);
  assert.equal((await adminLogin('another-google')).response.status, 403);
  assert.equal((await adminLogin('password-only')).response.status, 403);
  assert.equal((await adminLogin('linked-google')).response.status, 200);
  const admin = await adminLogin('admin-google');
  assert.equal(admin.response.status, 200);
  assert.equal(admin.data.ok, true);
  assert.match(admin.data.token, /^[a-f0-9]{48}$/);
  assert.equal((await fetch(url + '/api/admin/rooms', { headers: { 'X-Admin-Token': 'admin-google' } })).status, 401);
  assert.equal((await fetch(url + '/api/admin/rooms', { headers: { 'X-Admin-Token': admin.data.token } })).status, 200);
  assert.equal((await adminLogin('service-down')).response.status, 503);
  assert.ok(authCalls.includes('admin-google'));
});

test('creation timestamps appear only in the authenticated administrator listing', async () => {
  const room = await classroom('관리자 조회');
  const publicList = await (await fetch(url + '/api/rooms')).json();
  assert.equal(publicList.rooms[0].createdAt, undefined);
  const admin = await adminLogin('admin-google');
  const response = await fetch(url + '/api/admin/rooms', { headers: { 'X-Admin-Token': admin.data.token } });
  assert.equal(response.status, 200);
  const privateList = await response.json();
  assert.equal(privateList.roomCount, 1);
  assert.equal(privateList.rooms[0].roomCode, room.roomCode);
  assert.equal(privateList.rooms[0].createdAt, app.getRoom(room.roomCode).createdAt);
  assert.ok(Number.isFinite(privateList.rooms[0].createdAt));
  assert.equal(privateList.rooms[0].ownerId, undefined);
  assert.equal(privateList.rooms[0].token, undefined);
  assert.equal((await fetch(url + '/api/admin/rooms', { headers: { 'X-Admin-Token': room.token } })).status, 401);
});

test('admin deletion closes host and participant access, frees ownership, and does not recreate on reconnect', async () => {
  const room = await classroom('Delete me');
  const host = await socketClient();
  const participant = await socketClient();
  const hostSnapshot = once(host, 'instructor:joined');
  assert.equal((await ack(host, 'instructor:join', { roomCode: room.roomCode, token: room.token })).ok, true);
  const [hostData] = await hostSnapshot;
  const studentSnapshot = once(participant, 'student:joined');
  assert.equal((await ack(participant, 'student:join', { roomCode: room.roomCode, name: 'Participant' })).ok, true);
  const [studentData] = await studentSnapshot;
  const hostHeaders = { 'X-Socket-Id': host.id, 'X-Upload-Token': hostData.uploadToken };
  const studentHeaders = { 'X-Socket-Id': participant.id, 'X-Upload-Token': studentData.uploadToken };
  assert.ok(app.getHttpSession(host.id, hostData.uploadToken));
  assert.ok(app.getHttpSession(participant.id, studentData.uploadToken));
  const path = `${url}/api/admin/rooms/${room.roomCode}`;
  assert.equal((await fetch(path, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(path, { method: 'DELETE', headers: { 'X-Admin-Token': room.token } })).status, 401);
  assert.ok(app.getRoom(room.roomCode));
  const admin = await adminLogin('admin-google');
  const adminHeaders = { 'X-Admin-Token': admin.data.token };
  assert.equal((await fetch(path, { method: 'DELETE', headers: { ...adminHeaders, Origin: 'https://other.example' } })).status, 403);
  const hostClosed = once(host, 'room:closed');
  const studentClosed = once(participant, 'room:closed');
  assert.equal((await fetch(path, { method: 'DELETE', headers: adminHeaders })).status, 200);
  assert.equal((await hostClosed)[0].roomCode, room.roomCode);
  assert.equal((await studentClosed)[0].roomCode, room.roomCode);
  assert.equal(app.getHttpSession(host.id, hostData.uploadToken), null);
  assert.equal(app.getHttpSession(participant.id, studentData.uploadToken), null);
  for (const headers of [hostHeaders, studentHeaders]) {
    assert.equal((await fetch(url + '/api/upload', { method: 'POST', headers })).status, 401);
    assert.equal((await fetch(url + '/api/ai/chat', { method: 'POST', headers })).status, 401);
  }
  assert.equal((await ack(host, 'instructor:join', { roomCode: room.roomCode, token: room.token })).code, 'NOT_FOUND');
  assert.equal((await ack(participant, 'student:join', { roomCode: room.roomCode, name: 'Participant' })).code, 'NOT_FOUND');
  assert.equal(app.rooms.size, 0);
  assert.equal((await fetch(path, { method: 'DELETE', headers: adminHeaders })).status, 404);
  const session = await (await fetch(url + '/api/host/session', { headers: { Cookie: room.cookie } })).json();
  assert.equal(session.room, null);
  const replacement = await fetch(url + '/api/rooms', { method: 'POST', headers: { Cookie: room.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ lectureName: 'Replacement' }) });
  assert.equal(replacement.status, 201);
});

test('administrator logout revokes its token immediately', async () => {
  const admin = await adminLogin('admin-google');
  const headers = { 'X-Admin-Token': admin.data.token };
  assert.equal((await fetch(url + '/api/admin/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(url + '/api/admin/rooms', { headers })).status, 401);
  assert.equal((await fetch(url + '/api/admin/rooms/123456', { method: 'DELETE', headers })).status, 401);
});
