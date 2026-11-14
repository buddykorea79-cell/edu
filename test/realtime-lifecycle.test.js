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

