const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const timers = new Map();
  let nextTimer = 0;
  const errors = [];
  const notices = [];
  const status = { textContent: '' };
  const context = {
    crypto: { randomUUID: () => '8189b2ca-633a-4a51-9633-280d979c226f' },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: id => id === 'connection-status' ? status : null,
      addEventListener: () => {}
    },
    addEventListener: () => {},
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) })
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/connection.js'), 'utf8'), context);
  const handlers = new Map();
  const outgoing = [];
  const socket = {
    id: 'first-socket', connected: true,
    on(event, callback) { handlers.set(event, callback); },
    timeout() { return this; },
    emit(event, payload, ack) { outgoing.push({ event, payload, ack }); },
    connect() { this.connected = true; handlers.get('connect')?.(); },
    disconnect() { this.connected = false; handlers.get('disconnect')?.(); }
  };
  const connection = new context.EduTalkConnection(socket, {
    joinEvent: 'student:join', onError: error => errors.push(error), onNotice: message => notices.push(message)
  });
  const join = () => {
    connection.join({ roomCode: '123456', name: '학생' });
    connection.acceptSnapshot({ participantId: 'student-one', uploadToken: 'first-token' });
  };
  return { connection, socket, outgoing, handlers, errors, notices, timers, status, context, join };
}

test('transport reconnect rejoins same student before enabling actions or HTTP credentials', () => {
  const f = fixture();
  f.join();
  const sessionId = f.outgoing[0].payload.sessionId;
  assert.equal(f.connection.isReady(), true);
  f.socket.disconnect();
  assert.equal(f.connection.isReady(), false);
  assert.throws(() => f.connection.uploadHeaders());
  assert.equal(f.connection.emit('survey:respond', {}), false);
  assert.equal(f.notices.length, 1);
  f.socket.id = 'second-socket';
  f.socket.connect();
  assert.equal(f.connection.isReady(), false);
  assert.equal(f.outgoing.at(-1).event, 'student:join');
  assert.equal(f.outgoing.at(-1).payload.sessionId, sessionId);
  f.connection.acceptSnapshot({ participantId: 'student-one', uploadToken: 'fresh-token' });
  assert.equal(f.connection.uploadHeaders()['X-Socket-Id'], 'second-socket');
  assert.equal(f.connection.uploadHeaders()['X-Upload-Token'], 'fresh-token');
  f.connection.stop();
});

test('message acknowledgement timeout retries same ID and resolves the accepted message', async () => {
  const f = fixture();
  f.join();
  const promise = f.connection.send('message:send', { text: '안녕하세요' }, 'retry-same-id');
  const first = f.outgoing.at(-1);
  first.ack(new Error('timeout'));
  const retry = f.outgoing.at(-1);
  assert.equal(retry.payload.clientMessageId, first.payload.clientMessageId);
  retry.ack(null, { ok: true, message: { id: 'server-message', text: '안녕하세요' } });
  assert.equal((await promise).id, 'server-message');
  assert.equal(f.connection.pending.size, 0);
  assert.equal(f.timers.size, 0);
});

test('in-flight send waits for membership restore and ignores old transport callbacks', async () => {
  const f = fixture();
  f.join();
  const promise = f.connection.send('message:send', { text: '재연결' }, 'same-message');
  const oldAck = f.outgoing.at(-1).ack;
  f.socket.disconnect();
  f.socket.connect();
  assert.equal(f.outgoing.at(-1).event, 'student:join');
  oldAck(new Error('old disconnect'));
  f.connection.acceptSnapshot({ participantId: 'student-one', uploadToken: 'fresh' });
  const resumed = f.outgoing.at(-1);
  assert.equal(resumed.event, 'message:send');
  assert.equal(resumed.payload.clientMessageId, 'same-message');
  resumed.ack(null, { ok: true, message: { id: 'accepted' } });
  assert.equal((await promise).id, 'accepted');
  f.connection.stop();
});

test('replaced sessions stop reconnecting and reject pending sends', async () => {
  const f = fixture();
  f.join();
  const promise = f.connection.send('message:send', { text: '대기' }, 'pending');
  const rejection = assert.rejects(promise, /종료/);
  f.handlers.get('session:replaced')({ message: '다른 창에서 접속했습니다.' });
  f.socket.disconnect();
  assert.equal(f.connection.desired, null);
  assert.equal(f.status.textContent, '연결 종료');
  assert.equal(f.errors[0].code, 'REPLACED');
  await rejection;
});

test('admin room deletion stops retries, rejects pending messages and never rejoins the deleted room', async () => {
  const f = fixture();
  f.join();
  const pending = f.connection.send('message:send', { text: '대기 중' }, 'deleted-room-message');
  const rejected = assert.rejects(pending, /종료/);
  const previousAck = f.outgoing.at(-1).ack;
  f.socket.disconnect();
  f.socket.connect();
  f.connection.failJoin({ code: 'NOT_FOUND', message: '강의실을 찾을 수 없습니다.' });
  assert.ok(f.timers.size > 0);
  const outgoingCount = f.outgoing.length;
  f.handlers.get('room:closed')({ message: '관리자가 강의실을 삭제했습니다.' });
  await rejected;
  assert.equal(f.connection.desired, null);
  assert.equal(f.connection.pending.size, 0);
  assert.equal(f.connection.hadJoined, false);
  assert.equal(f.connection.recoveryDeadline, 0);
  assert.equal(f.connection.isReady(), false);
  assert.equal(f.connection.uploadToken, '');
  assert.equal(f.status.textContent, '강의실 종료');
  assert.equal(f.errors.at(-1).code, 'ROOM_CLOSED');
  assert.equal(f.timers.size, 0);
  previousAck(new Error('late timeout'));
  f.socket.disconnect();
  f.socket.connect();
  assert.equal(f.outgoing.length, outgoingCount);
  assert.equal(f.connection.desired, null);
});

test('missing room after restart retries briefly before returning an actionable error', () => {
  const f = fixture();
  f.join();
  f.socket.disconnect();
  f.socket.connect();
  f.connection.failJoin({ code: 'NOT_FOUND', message: '존재하지 않는 방입니다.' });
  assert.equal(f.errors.length, 0);
  assert.equal(f.status.textContent, '강의실 복구 대기 중');
  assert.ok(f.connection.desired);
  f.connection.recoveryDeadline = 1;
  f.connection.failJoin({ code: 'NOT_FOUND', message: '존재하지 않는 방입니다.' });
  assert.equal(f.errors.length, 1);
  assert.equal(f.connection.desired, null);
  assert.equal(f.timers.size, 0);
});

test('staff reconnect obtains a fresh token instead of replaying the previous JWT', async () => {
  const f = fixture();
  let token = 'old';
  f.connection.join(async () => ({ roomCode: '123456', token }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.outgoing.at(-1).payload.token, 'old');
  f.connection.acceptSnapshot({ participantId: 'staff-one', uploadToken: 'first' });
  f.socket.disconnect();
  token = 'refreshed';
  f.socket.connect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.outgoing.at(-1).payload.token, 'refreshed');
  f.connection.stop();
});

test('HTTP errors are surfaced with server explanation instead of treated as success', async () => {
  const f = fixture();
  f.context.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: '요청이 많습니다.' }) });
  await assert.rejects(f.context.eduRequestJson('/api/ai/chat'), /요청이 많습니다/);
  assert.equal(f.timers.size, 0);
});

test('fatal join failure and explicit room switch cancel old pending messages', async () => {
  for (const fatal of [true, false]) {
    const f = fixture();
    f.join();
    const pending = f.connection.send('message:send', { text: 'Private to first room' }, 'old-room-message');
    const rejected = assert.rejects(pending, /종료/);
    if (fatal) f.connection.failJoin({ code: 'AUTH', message: '로그인이 만료되었습니다.' });
    f.connection.join({ roomCode: '654321', name: '학생' });
    f.connection.acceptSnapshot({ participantId: 'different-member', uploadToken: 'different-token' });
    await rejected;
    assert.equal(f.connection.pending.size, 0);
    assert.equal(f.outgoing.filter(item => item.event === 'message:send').length, 1);
    f.connection.stop();
  }
});
