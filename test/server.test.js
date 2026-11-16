'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: connect } = require('socket.io-client');
const QRCode = require('qrcode');

// This process is a local smoke test; never use a developer's live auth project.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.PUBLIC_ORIGIN;
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

async function hostSession(cookie = '', headers = {}) {
  const response = await fetch(url + '/api/host/session', { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}
async function createRoom(cookie, lectureName = 'Class', headers = {}) {
  const response = await fetch(url + '/api/rooms', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify({ lectureName }) });
  return { response, data: await response.json() };
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

test('production entry point wires static assets, health and safe API errors', async () => {
  const health = await fetch(url + '/api/ping');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await health.json()).ok, true);
  for (const file of ['/', '/student.html', '/instructor.html', '/admin.html', '/css/style.css', '/js/connection.js', '/vendor/supabase.js', '/socket.io/socket.io.js']) {
    const response = await fetch(url + file);
    assert.equal(response.status, 200, file);
    assert.ok((await response.text()).length > 100, file);
  }
  for (const route of ['/api/upload', '/api/ai/chat', '/api/admin/auth']) {
    const response = await fetch(url + route, { method: 'POST' });
    assert.equal(response.status, 401, route);
    assert.ok((await response.json()).error, route);
  }
  const malformed = await fetch(url + '/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.ok((await malformed.json()).error);
  const oversize = await fetch(url + '/api/ai/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(270000) })
  });
  assert.equal(oversize.status, 413);
  assert.ok((await oversize.json()).error);
});

test('anonymous host identity persists across reloads and rejects forged cookies and cross-site creation', async () => {
  const first = await hostSession();
  assert.equal(first.response.status, 200);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.room, null);
  assert.equal(first.data.roomLimit, 5);
  assert.match(first.response.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(first.response.headers.get('set-cookie'), /SameSite=Lax/i);
  assert.equal(first.response.headers.get('cache-control'), 'no-store');
  const reloaded = await hostSession(first.cookie);
  assert.equal(reloaded.data.token, first.data.token);
  assert.equal((await hostSession()).data.token === first.data.token, false);
  assert.equal((await createRoom('')).response.status, 401);
  const forged = first.cookie.slice(0, -1) + (first.cookie.endsWith('0') ? '1' : '0');
  assert.equal((await createRoom(forged)).response.status, 401);
  assert.equal((await createRoom(first.cookie, 'Blocked', { Origin: 'https://elsewhere.example' })).response.status, 403);
  assert.equal((await hostSession(first.cookie, { 'Sec-Fetch-Site': 'cross-site' })).response.status, 403);
  assert.equal(app.rooms.size, 0);
});

test('anonymous room creation enforces one browser room and a global five-room limit under concurrent requests', async () => {
  const host = await hostSession();
  for (const name of ['', ' ', 'x'.repeat(101), null, 123]) {
    assert.equal((await createRoom(host.cookie, name)).response.status, 400);
  }
  const attempts = await Promise.all([createRoom(host.cookie, 'First'), createRoom(host.cookie, 'Second')]);
  assert.equal(attempts.filter(result => result.response.status === 201).length, 1);
  const created = attempts.find(result => result.data.ok).data;
  const duplicate = attempts.find(result => !result.data.ok);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, 'ROOM_EXISTS');
  assert.equal(duplicate.data.roomCode, created.roomCode);
  assert.match(created.roomCode, /^\d{6}$/);
  assert.equal((await hostSession(host.cookie)).data.room.roomCode, created.roomCode);
  const others = await Promise.all(Array.from({ length: 8 }, () => hostSession()));
  const results = await Promise.all(others.map((other, index) => createRoom(other.cookie, `Class ${index}`)));
  assert.equal(results.filter(result => result.response.status === 201).length, 4);
  assert.equal(results.filter(result => result.response.status === 409 && result.data.code === 'ROOM_LIMIT').length, 4);
  assert.equal(app.rooms.size, 5);
});

test('public room statistics count connected participants and omit private creation and identity details', async () => {
  const host = await hostSession();
  const created = (await createRoom(host.cookie, '공개 현황')).data;
  const hostSocket = await socketClient();
  assert.equal((await ack(hostSocket, 'instructor:join', { roomCode: created.roomCode, token: host.data.token })).ok, true);
  const a = await socketClient();
  const b = await socketClient();
  for (const [socket, name] of [[a, 'First'], [b, 'Second']]) {
    assert.equal((await ack(socket, 'student:join', { roomCode: created.roomCode, name })).ok, true);
  }
  const response = await fetch(url + '/api/rooms');
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.roomCount, 1);
  assert.equal(summary.roomLimit, 5);
  assert.equal(summary.totalParticipants, 2);
  assert.deepEqual(summary.rooms, [{ roomCode: created.roomCode, lectureName: '공개 현황', participantCount: 2, capacity: 50 }]);
  assert.doesNotMatch(JSON.stringify(summary), /createdAt|ownerId|ownerEmail|token|First|Second/);
  const disconnected = once(app.io.sockets.sockets.get(b.id), 'disconnect');
  b.io.engine.close();
  await disconnected;
  assert.equal(app.getRoom(created.roomCode).students.size, 2, 'transport loss reserves the seat temporarily');
  assert.equal((await (await fetch(url + '/api/rooms')).json()).totalParticipants, 1, 'public count reflects currently connected participants');
});

test('room QR SVG encodes the participant URL, including HTTPS proxy origin, and missing rooms return 404', async () => {
  const host = await hostSession();
  const created = (await createRoom(host.cookie, 'QR class')).data;
  const options = { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 320 };
  const response = await fetch(`${url}/api/room/${created.roomCode}/qr.svg`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(await response.text(), await QRCode.toString(`${url}/student.html?code=${created.roomCode}`, options));
  const secureResponse = await fetch(`${url}/api/room/${created.roomCode}/qr.svg`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(await secureResponse.text(), await QRCode.toString(`${url.replace('http:', 'https:')}/student.html?code=${created.roomCode}`, options));
  for (const code of ['invalid', '12345', '9999999']) {
    assert.equal((await fetch(`${url}/api/room/${code}/qr.svg`)).status, 404);
  }
  app.realtime.deleteRoom(created.roomCode);
  assert.equal((await fetch(`${url}/api/room/${created.roomCode}/qr.svg`)).status, 404);
});

test('private room management requires administrator authentication while legacy instructor registration is retired', async () => {
  for (const [path, method] of [['/api/admin/rooms', 'GET'], ['/api/admin/rooms/123456', 'DELETE'], ['/api/admin/logout', 'POST']]) {
    assert.equal((await fetch(url + path, { method })).status, 401);
  }
  assert.equal((await fetch(url + '/api/instructor/session', { method: 'POST' })).status, 404);
});
