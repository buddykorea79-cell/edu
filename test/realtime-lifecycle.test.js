'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { createRealtime } = require('../lib/realtime');

const account = { userId: 'teacher-one', email: 'teacher@example.test', name: 'Teacher', status: 'approved' };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t, options = {}) {
  const server = http.createServer();
  const io = new Server(server);
  const realtime = createRealtime(io, { authenticateInstructor: async () => account, ...options });
  const clients = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    realtime.close();
    for (const client of clients) client.disconnect();
    await new Promise(resolve => io.close(resolve));
  });
  async function client() {
    const socket = connect(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 2000 });
    clients.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
  return { realtime, io, client };
}
const ack = (socket, event, payload) => socket.timeout(2000).emitWithAck(event, payload);

test('leaving cancels instructor authentication already in flight', async t => {
  const entered = deferred();
  const auth = deferred();
  const { realtime, client } = await fixture(t, { authenticateInstructor: () => { entered.resolve(); return auth.promise; } });
  const socket = await client();
  socket.emit('instructor:join', { roomCode: '123456', token: 'valid', lectureName: 'Class' });
  await entered.promise;
  assert.equal((await ack(socket, 'room:leave', {})).ok, true);
  auth.resolve(account);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(realtime.rooms.size, 0);
  assert.equal(realtime.socketRoom.size, 0);
});

test('revocation rejects an in-flight join and only explicit approval restores access', async t => {
  const entered = deferred();
  const auth = deferred();
  const { realtime, client } = await fixture(t, { authenticateInstructor: () => { entered.resolve(); return auth.promise; } });
  const socket = await client();
  const joining = ack(socket, 'instructor:join', { roomCode: '123456', token: 'valid' });
  await entered.promise;
  realtime.revokeInstructor(account.userId);
  auth.resolve(account);
  assert.equal((await joining).code, 'AUTH');
  assert.equal(realtime.rooms.size, 0);
  realtime.allowInstructor(account.userId);
  realtime.createRoom('123456', 'Class').ownerId = account.userId;
  assert.equal((await ack(socket, 'instructor:join', { roomCode: '123456', token: 'valid' })).ok, true);
  assert.equal(realtime.rooms.size, 1);
  const disconnected = once(socket, 'disconnect');
  realtime.revokeInstructor(account.userId);
  await disconnected;
  assert.equal(realtime.getRoom('123456').members.size, 0);
});

test('disconnected instructor authentication cannot create a room later', async t => {
  const entered = deferred();
  const auth = deferred();
  const { realtime, io, client } = await fixture(t, { authenticateInstructor: () => { entered.resolve(); return auth.promise; } });
  const socket = await client();
  const disconnected = once(io.sockets.sockets.get(socket.id), 'disconnect');
  socket.emit('instructor:join', { roomCode: '123456', token: 'valid' });
  await entered.promise;
  socket.disconnect();
  await disconnected;
  auth.resolve(account);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(realtime.rooms.size, 0);
  assert.equal(realtime.socketRoom.size, 0);
});

test('one owned room per browser identity and five total rooms, with released slots after deletion', async t => {
  const { realtime } = await fixture(t);
  assert.equal(realtime.createOwnedRoom('', 'Class').code, 'AUTH');
  assert.equal(realtime.createOwnedRoom('first', '   ').code, 'INVALID');
  const first = realtime.createOwnedRoom('first', '  First classroom  ');
  assert.equal(first.ok, true);
  assert.match(first.roomCode, /^\d{6}$/);
  assert.equal(first.lectureName, 'First classroom');
  assert.deepEqual(realtime.findOwnedRoom('first'), { roomCode: first.roomCode, lectureName: first.lectureName });
  const duplicate = realtime.createOwnedRoom('first', 'Another');
  assert.equal(duplicate.code, 'ROOM_EXISTS');
  assert.equal(duplicate.roomCode, first.roomCode);
  assert.equal(realtime.rooms.size, 1);
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => realtime.createOwnedRoom(`browser-${i}`, `Room ${i}`))));
  assert.equal(attempts.filter(result => result.ok).length, 4);
  assert.equal(attempts.filter(result => result.code === 'ROOM_LIMIT').length, 8);
  assert.equal(realtime.rooms.size, 5);
  assert.equal(new Set([first.roomCode, ...attempts.filter(result => result.ok).map(result => result.roomCode)]).size, 5);
  assert.equal(realtime.deleteRoom(first.roomCode), true);
  assert.equal(realtime.deleteRoom(first.roomCode), false);
  assert.equal(realtime.findOwnedRoom('first'), null);
  assert.equal(realtime.createOwnedRoom('first', 'Replacement').ok, true);
  assert.equal(realtime.rooms.size, 5);
});

test('socket joins require the owning identity and cannot create or assume ownership of rooms', async t => {
  const { realtime, client } = await fixture(t);
  const socket = await client();
  assert.equal((await ack(socket, 'instructor:join', { roomCode: '123456', token: 'valid' })).code, 'NOT_FOUND');
  assert.equal(realtime.rooms.size, 0);
  const other = realtime.createOwnedRoom('another-browser', 'Other room');
  assert.equal((await ack(socket, 'instructor:join', { roomCode: other.roomCode, token: 'valid' })).code, 'FORBIDDEN');
  assert.equal((await ack(socket, 'instructor:join', { roomCode: other.roomCode, token: 'valid', asAssistant: true })).code, 'FORBIDDEN');
  realtime.createRoom('654321', 'Unowned fixture');
  assert.equal((await ack(socket, 'instructor:join', { roomCode: '654321', token: 'valid' })).code, 'FORBIDDEN');
  assert.equal(realtime.getRoom(other.roomCode).members.size, 0);
  assert.equal(realtime.getRoom('654321').ownerId, null);
});

test('deleting a room notifies members, invalidates their permissions and cannot be undone by a reconnect', async t => {
  const { realtime, client } = await fixture(t);
  const created = realtime.createOwnedRoom(account.userId, 'Delete this room');
  const host = await client();
  const student = await client();
  const hostSnapshot = once(host, 'instructor:joined');
  assert.equal((await ack(host, 'instructor:join', { roomCode: created.roomCode, token: 'valid' })).ok, true);
  const [snapshot] = await hostSnapshot;
  assert.equal((await ack(student, 'student:join', { roomCode: created.roomCode, name: 'Participant' })).ok, true);
  assert.ok(realtime.getHttpSession(host.id, snapshot.uploadToken));
  const hostClosed = once(host, 'room:closed');
  const studentClosed = once(student, 'room:closed');
  const room = realtime.getRoom(created.roomCode);
  assert.equal(realtime.deleteRoom(created.roomCode), true);
  assert.equal((await hostClosed)[0].roomCode, created.roomCode);
  assert.equal((await studentClosed)[0].roomCode, created.roomCode);
  assert.equal(realtime.socketRoom.size, 0);
  assert.equal(realtime.socketRole.size, 0);
  assert.equal(room.members.size, 0);
  assert.equal(room.students.size, 0);
  assert.equal(realtime.getHttpSession(host.id, snapshot.uploadToken), null);
  assert.equal((await ack(host, 'message:send', { text: 'deleted room' })).code, 'NOT_JOINED');
  assert.equal((await ack(student, 'message:send', { text: 'deleted room' })).code, 'NOT_JOINED');
  assert.equal((await ack(host, 'instructor:join', { roomCode: created.roomCode, token: 'valid' })).code, 'NOT_FOUND');
  assert.equal((await ack(student, 'student:join', { roomCode: created.roomCode, name: 'Participant' })).code, 'NOT_FOUND');
  assert.equal(realtime.rooms.size, 0);
  assert.equal(realtime.createOwnedRoom(account.userId, 'New room').ok, true);
});

test('deletion during an in-flight host join never restores the deleted classroom', async t => {
  const entered = deferred();
  const auth = deferred();
  const { realtime, client } = await fixture(t, { authenticateInstructor: () => { entered.resolve(); return auth.promise; } });
  const created = realtime.createOwnedRoom(account.userId, 'Class');
  const socket = await client();
  const joining = ack(socket, 'instructor:join', { roomCode: created.roomCode, token: 'valid' });
  await entered.promise;
  realtime.deleteRoom(created.roomCode);
  auth.resolve(account);
  assert.equal((await joining).code, 'NOT_FOUND');
  assert.equal(realtime.rooms.size, 0);
  assert.equal(realtime.socketRoom.size, 0);
});

test('host can resume from another tab while the original socket loses its room permissions', async t => {
  const { realtime, client } = await fixture(t);
  const created = realtime.createOwnedRoom(account.userId, 'Class');
  const original = await client();
  assert.equal((await ack(original, 'instructor:join', { roomCode: created.roomCode, token: 'valid' })).ok, true);
  const replacement = await client();
  const replaced = once(original, 'session:replaced');
  assert.equal((await ack(replacement, 'instructor:join', { roomCode: created.roomCode, token: 'valid' })).ok, true);
  await replaced;
  assert.equal(realtime.getRoom(created.roomCode).instructorSocketId, replacement.id);
  assert.equal(realtime.getRoom(created.roomCode).members.size, 1);
  assert.equal(realtime.socketRoom.size, 1);
});

test('idle cleanup releases the browser ownership slot', async t => {
  const { realtime } = await fixture(t, { idleTtlMs: 100 });
  const created = realtime.createOwnedRoom(account.userId, 'Class');
  realtime.cleanupRooms(realtime.getRoom(created.roomCode).lastActivity + 101);
  assert.equal(realtime.findOwnedRoom(account.userId), null);
  assert.equal(realtime.createOwnedRoom(account.userId, 'Next class').ok, true);
});

