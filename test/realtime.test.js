'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { createRealtime, LIMITS } = require('../lib/realtime');

function event(socket, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out: ${name}`)); }, 10000);
    function listener(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(name, listener);
      resolve(data);
    }
    socket.on(name, listener);
  });
}
const ack = (socket, name, payload) => socket.timeout(10000).emitWithAck(name, payload);

async function fixture(t, options = {}) {
  const server = http.createServer();
  const io = new Server(server, { maxHttpBufferSize: 128 * 1024 });
  const realtime = createRealtime(io, {
    authenticateInstructor: async token => token === 'teacher-token'
      ? { userId: 'teacher', email: 'teacher@example.test', name: 'Teacher', status: 'approved' } : null,
    ...options
  });
  const sockets = [];
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    realtime.close();
    sockets.forEach(s => s.disconnect());
    await new Promise(resolve => io.close(resolve));
  });
  async function connect(transport = 'websocket') {
    const socket = client(url, { transports: [transport], reconnection: false, autoConnect: false });
    sockets.push(socket);
    const connected = event(socket, 'connect');
    socket.connect();
    await connected;
    return socket;
  }
  async function staff(code = '123456') {
    if (!realtime.getRoom(code)) realtime.createRoom(code, '부하 테스트').ownerId = 'teacher';
    const socket = await connect();
    const joined = event(socket, 'instructor:joined');
    assert.equal((await ack(socket, 'instructor:join', { roomCode: code, lectureName: '부하 테스트', token: 'teacher-token' })).ok, true);
    return { socket, snapshot: await joined };
  }
  async function student(index = 0, code = '123456', transport = 'websocket') {
    const socket = await connect(transport);
    const payload = { roomCode: code, name: `Student ${index}`, emoji: '🙂', sessionId: randomUUID() };
    const joined = event(socket, 'student:joined');
    assert.equal((await ack(socket, 'student:join', payload)).ok, true);
    return { socket, payload, snapshot: await joined };
  }
  return { io, realtime, connect, staff, student };
}

test('30 simultaneous students: 240 messages reach all 31 clients, including polling, then 10 reconnect', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const instructor = await f.staff();
  const students = await Promise.all(Array.from({ length: 30 }, (_, i) => f.student(i, '123456', i % 2 ? 'websocket' : 'polling')));
  const recipients = [instructor, ...students];
  const seen = recipients.map(() => new Map());
  const deliveries = recipients.map(({ socket }, i) => new Promise(resolve => {
    socket.on('message:new', m => {
      if (!m.text?.startsWith('load:')) return;
      seen[i].set(m.id, (seen[i].get(m.id) || 0) + 1);
      if (seen[i].size === 240) resolve();
    });
  }));
  const latencies = [];
  for (let round = 0; round < 8; round++) {
    await Promise.all(students.map(async ({ socket }, index) => {
      const start = performance.now();
      const [result, board] = await Promise.all([
        ack(socket, 'message:send', { text: `load:${round}:${index}`, clientMessageId: randomUUID() }),
        ack(socket, 'whiteboard:drawBatch', [{ x0: 0, y0: index / 30, x1: (round + 1) / 10, y1: index / 30, color: '#0d766e', width: 2 }])
      ]);
      assert.equal(result.ok, true);
      assert.equal(board.ok, true);
      latencies.push(performance.now() - start);
    }));
  }
  await Promise.all(deliveries);
  for (const received of seen) {
    assert.equal(received.size, 240);
    assert.ok([...received.values()].every(n => n === 1));
  }
  const drop = students.slice(0, 10);
  await Promise.all(drop.map(async ({ socket }) => {
    const disconnected = event(socket, 'disconnect');
    socket.io.engine.close();
    await disconnected;
  }));
  const gap = await ack(instructor.socket, 'message:send', { text: 'sent while offline', clientMessageId: randomUUID() });
  await Promise.all(drop.map(async member => {
    const connected = event(member.socket, 'connect');
    member.socket.connect();
    await connected;
    const joined = event(member.socket, 'student:joined');
    assert.equal((await ack(member.socket, 'student:join', member.payload)).ok, true);
    const snapshot = await joined;
    assert.equal(snapshot.participantId, member.snapshot.participantId);
    assert.ok(snapshot.messages.some(m => m.id === gap.messageId));
  }));
  assert.equal(f.realtime.getRoom('123456').students.size, 30);
  assert.equal(f.realtime.getRoom('123456').whiteboard.length, 240);
  const recovered = event(students[29].socket, 'message:new', m => m.text === 'after reconnect');
  assert.equal((await ack(drop[0].socket, 'message:send', { text: 'after reconnect', clientMessageId: randomUUID() })).ok, true);
  await recovered;
  latencies.sort((a, b) => a - b);
  t.diagnostic(`Local 30-student run: 240 messages / 7,440 deliveries; ACK p95=${latencies[Math.floor(latencies.length * .95)].toFixed(1)}ms; max=${latencies.at(-1).toFixed(1)}ms. This does not measure Render capacity.`);
});

test('ack retries deduplicate after reconnect; survey vote identity remains stable', async t => {
  const f = await fixture(t);
  const teacher = await f.staff();
  const member = await f.student();
  const payload = { text: 'Only once', clientMessageId: randomUUID() };
  const first = await ack(member.socket, 'message:send', payload);
  assert.equal((await ack(member.socket, 'message:send', payload)).messageId, first.messageId);
  const surveyEvent = event(member.socket, 'survey:started');
  await ack(teacher.socket, 'survey:understanding');
  const survey = await surveyEvent;
  await ack(member.socket, 'survey:respond', { surveyId: survey.id, optionIndex: 0 });
  const disconnected = event(member.socket, 'disconnect');
  member.socket.io.engine.close();
  await disconnected;
  const connected = event(member.socket, 'connect');
  member.socket.connect();
  await connected;
  const joined = event(member.socket, 'student:joined');
  await ack(member.socket, 'student:join', member.payload);
  const snapshot = await joined;
  assert.equal(snapshot.myResponses[survey.id], 0);
  assert.equal(snapshot.activeSurvey.results, undefined);
  assert.equal(snapshot.activeSurvey.total, undefined);
  assert.equal((await ack(member.socket, 'message:send', payload)).messageId, first.messageId);
  await ack(member.socket, 'survey:respond', { surveyId: survey.id, optionIndex: 1 });
  const stored = f.realtime.getRoom('123456');
  assert.equal(stored.messages.filter(m => m.id === first.messageId).length, 1);
  assert.equal(stored.activeSurvey.total, 1);
  assert.deepEqual(stored.activeSurvey.results, [0, 1, 0]);
});

test('malformed payloads, role checks, room switching and stale upload credentials', async t => {
  const f = await fixture(t);
  await f.staff();
  const member = await f.student();
  assert.ok(f.realtime.getHttpSession(member.socket.id, member.snapshot.uploadToken));
  for (const name of ['message:send', 'message:file', 'survey:create', 'survey:respond', 'survey:close', 'survey:shareResults', 'resource:share']) {
    for (const value of [null, undefined, [], 'bad']) {
      assert.equal((await ack(member.socket, name, value)).ok, false, `${name} accepted invalid payload`);
    }
  }
  assert.equal((await ack(member.socket, 'survey:understanding')).code, 'FORBIDDEN');
  assert.equal((await ack(member.socket, 'message:send', { text: 'Still alive', clientMessageId: randomUUID() })).ok, true);
  f.realtime.createRoom('654321', 'Second room');
  await ack(member.socket, 'student:join', { ...member.payload, roomCode: '654321' });
  assert.equal(f.realtime.getRoom('123456').students.size, 0);
  assert.equal(f.realtime.getRoom('654321').students.size, 1);
  await ack(member.socket, 'room:leave');
  assert.equal(f.realtime.getHttpSession(member.socket.id, member.snapshot.uploadToken), null);
  assert.equal((await ack(member.socket, 'message:send', { text: 'Cannot send' })).code, 'NOT_JOINED');
});

test('full room permits duplicate join and session replacement; private secrets are not broadcast', async t => {
  const f = await fixture(t);
  await f.staff();
  f.realtime.getRoom('123456').capacity = 2;
  const a = await f.student(1);
  const b = await f.student(2);
  assert.equal((await ack(a.socket, 'student:join', a.payload)).ok, true);
  const outsider = await f.connect();
  assert.equal((await ack(outsider, 'student:join', { ...a.payload, sessionId: randomUUID() })).code, 'FULL');
  const replaced = event(a.socket, 'session:replaced');
  const snapshot = event(outsider, 'student:joined');
  assert.equal((await ack(outsider, 'student:join', a.payload)).ok, true);
  await replaced;
  const restored = await snapshot;
  assert.equal(restored.participantId, a.snapshot.participantId);
  assert.equal(restored.students.length, 2);
  const publicData = JSON.stringify({ students: restored.students, messages: restored.messages });
  assert.ok(!publicData.includes(a.payload.sessionId));
  assert.ok(!publicData.includes(b.payload.sessionId));
  assert.equal(f.realtime.getRoom('123456').students.size, 2);
});

test('whiteboard batches keep server order and bounded history; active rooms never expire at midnight', async t => {
  const f = await fixture(t, { idleTtlMs: 100 });
  const teacher = await f.staff();
  const member = await f.student();
  const strokes = [{ x0: 0, y0: 0, x1: .1, y1: .2, color: '#123456', width: 2 }];
  const echoed = event(member.socket, 'whiteboard:drawBatch');
  assert.equal((await ack(member.socket, 'whiteboard:drawBatch', strokes)).ok, true);
  assert.equal((await echoed).length, 1);
  const room = f.realtime.getRoom('123456');
  assert.equal(room.whiteboard.length, 1);
  room.whiteboard = Array(LIMITS.boardItems).fill(room.whiteboard[0]);
  assert.equal((await ack(member.socket, 'whiteboard:drawBatch', strokes)).ok, false);
  assert.equal(room.whiteboard.length, LIMITS.boardItems);
  assert.equal((await ack(teacher.socket, 'whiteboard:clear')).ok, true);
  assert.equal(room.whiteboard.length, 0);
  f.realtime.cleanupRooms(Date.now() + 86400000);
  assert.equal(f.realtime.rooms.size, 1);
  await ack(member.socket, 'room:leave');
  await ack(teacher.socket, 'room:leave');
  f.realtime.cleanupRooms(Date.now() + 101);
  assert.equal(f.realtime.rooms.size, 0);
});
