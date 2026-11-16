'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(request, { configured = true, signedIn = true } = {}) {
  const elements = new Map();
  const notices = [];
  let signOuts = 0;
  const calls = [];
  function element() {
    const classes = new Set();
    const handlers = new Map();
    return { style: {}, disabled: false, hidden: false, textContent: '', innerHTML: '', dataset: {}, handlers,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value), toggle(value, on) { on ? classes.add(value) : classes.delete(value); } },
      addEventListener(event, callback) { handlers.set(event, callback); }, querySelectorAll: () => [], remove() {} };
  }
  const auth = {
    getSession: async () => ({ data: { session: signedIn ? { access_token: 'supabase-token' } : null } }),
    signOut: async () => { signOuts++; return { error: null }; },
    signInWithOAuth: async () => ({ error: null }),
  };
  const context = {
    document: {
      hidden: false,
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element,
      body: { appendChild: node => notices.push(node.textContent) },
      addEventListener() {},
    },
    location: { origin: 'http://localhost' },
    supabase: { createClient: () => ({ auth }) },
    eduRequestJson: async (url, options, timeout) => {
      calls.push({ url, options, timeout });
      if (url === '/api/config') return configured ? { supabaseUrl: 'http://auth.test', supabaseAnonKey: 'anon' } : {};
      return request(url, options);
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, confirm: () => true,
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8'), context);
  return { context, elements, notices, calls, signOuts: () => signOuts,
    settle: () => new Promise(resolve => setImmediate(resolve)) };
}
const responseError = (status, message) => Object.assign(new Error(message), { status });
const rooms = (privateFields = false, lectureName = '열린 수업') => ({ ok: true, roomCount: 1, roomLimit: 5, totalParticipants: 3,
  rooms: [{ roomCode: '123456', lectureName, participantCount: 3, capacity: 50,
    ...(privateFields ? { createdAt: Date.UTC(2026, 10, 16, 4, 30) } : {}) }] });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function assertPublicView(f) {
  assert.equal(f.elements.get('stat-rooms').textContent, 1);
  assert.equal(f.elements.get('stat-limit').textContent, 5);
  assert.equal(f.elements.get('stat-participants').textContent, 3);
  assert.equal(f.elements.get('created-heading').classList.contains('hidden'), true);
  assert.equal(f.elements.get('actions-heading').classList.contains('hidden'), true);
  assert.doesNotMatch(f.elements.get('room-rows').innerHTML, /admin-date|data-code=|KST/);
}

test('any visitor can inspect room counts and participants without signing in', async () => {
  const f = fixture(async url => {
    assert.equal(url, '/api/rooms');
    return rooms();
  }, { signedIn: false });
  await f.settle();
  assertPublicView(f);
  assert.match(f.elements.get('room-rows').innerHTML, /열린 수업/);
  assert.equal(f.calls.find(call => call.url === '/api/rooms').options.headers['X-Admin-Token'], undefined);
  assert.equal(f.calls.some(call => call.url === '/api/admin/auth'), false);
  assert.equal(f.elements.get('refresh-btn').disabled, false);
  await f.context.removeRoom('123456', '열린 수업');
  assert.equal(f.calls.some(call => call.options?.method === 'DELETE'), false);
});

test('missing Google configuration keeps public statistics available and disables only admin login', async () => {
  const f = fixture(async url => {
    assert.equal(url, '/api/rooms');
    return rooms();
  }, { configured: false });
  await f.settle();
  assertPublicView(f);
  assert.equal(f.elements.get('google-login-btn').disabled, true);
  assert.equal(f.elements.get('login-loading').classList.contains('hidden'), true);
  assert.equal(f.calls.some(call => call.url === '/api/admin/auth'), false);
});

test('temporary or non-admin authentication failures do not hide public data or sign users out', async () => {
  for (const [status, message] of [[503, '인증 서버에 연결할 수 없습니다.'], [403, '관리자 계정이 아닙니다.']]) {
    const f = fixture(async url => {
      if (url === '/api/rooms') return rooms();
      assert.equal(url, '/api/admin/auth');
      throw responseError(status, message);
    });
    await f.settle();
    assertPublicView(f);
    assert.equal(f.signOuts(), 0);
    assert.equal(f.elements.get('login-error').textContent, message);
    assert.equal(f.elements.get('login-error').hidden, false);
    assert.equal(f.calls.find(call => call.url === '/api/admin/auth').timeout, 15000);
  }
});

test('authenticated administrator sees creation time in Korea time and deletion controls', async () => {
  const f = fixture(async url => {
    if (url === '/api/rooms') return rooms();
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    assert.equal(url, '/api/admin/rooms');
    return rooms(true, '<수업>');
  });
  await f.settle();
  assert.equal(f.elements.get('created-heading').classList.contains('hidden'), false);
  assert.equal(f.elements.get('actions-heading').classList.contains('hidden'), false);
  assert.match(f.elements.get('room-rows').innerHTML, /admin-date/);
  assert.match(f.elements.get('room-rows').innerHTML, /13:30/);
  assert.match(f.elements.get('room-rows').innerHTML, /KST/);
  assert.match(f.elements.get('room-rows').innerHTML, /data-code="123456"/);
  assert.match(f.elements.get('room-rows').innerHTML, /&lt;수업&gt;/);
  assert.equal(f.calls.find(call => call.url === '/api/admin/rooms').options.headers['X-Admin-Token'], 'admin-token');
});

test('concurrent clicks delete a room once and failed deletion releases its controls', async () => {
  const pending = deferred();
  let deletes = 0;
  const f = fixture(async (url, options) => {
    if (url === '/api/rooms') return rooms();
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    if (url === '/api/admin/rooms') return rooms(true);
    assert.equal(url, '/api/admin/rooms/123456');
    assert.equal(options.method, 'DELETE');
    deletes++;
    await pending.promise;
    throw responseError(503, '잠시 후 다시 시도하세요.');
  });
  await f.settle();
  const first = f.context.removeRoom('123456', '열린 수업');
  await f.context.removeRoom('123456', '열린 수업');
  assert.equal(deletes, 1);
  assert.match(f.elements.get('room-rows').innerHTML, / disabled/);
  pending.resolve();
  await first;
  assert.ok(f.notices.some(text => text.includes('삭제하지 못했습니다')));
  assert.doesNotMatch(f.elements.get('room-rows').innerHTML, / disabled/);
  assert.equal(f.elements.get('refresh-btn').disabled, false);
});

test('successful deletion refreshes the list and releases the deleted room guard', async () => {
  let deleted = false;
  const f = fixture(async (url, options) => {
    if (url === '/api/rooms') return rooms();
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    if (url === '/api/admin/rooms') return deleted ? { ok: true, roomCount: 0, roomLimit: 5, totalParticipants: 0, rooms: [] } : rooms(true);
    assert.equal(options.method, 'DELETE');
    deleted = true;
    return { ok: true };
  });
  await f.settle();
  await f.context.removeRoom('123456', '열린 수업');
  assert.equal(f.elements.get('stat-rooms').textContent, 0);
  assert.match(f.elements.get('room-rows').innerHTML, /아직 열린 강의실/);
  assert.ok(f.notices.some(text => text.includes('강의실을 삭제했습니다')));
  assert.equal(f.elements.get('refresh-btn').disabled, false);
});

test('expired admin token immediately removes private columns while public refresh is pending', async () => {
  const publicRefresh = deferred();
  let publicCalls = 0;
  const f = fixture(async url => {
    if (url === '/api/rooms') return ++publicCalls === 1 ? rooms() : publicRefresh.promise;
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    if (url === '/api/admin/rooms') return rooms(true);
    throw responseError(401, '인증이 필요합니다.');
  });
  await f.settle();
  const deletion = f.context.removeRoom('123456', '열린 수업');
  await f.settle();
  assertPublicView(f);
  assert.equal(f.signOuts(), 0);
  assert.match(f.elements.get('login-error').textContent, /관리자 인증이 만료/);
  publicRefresh.resolve(rooms());
  await deletion;
  assertPublicView(f);
  assert.equal(f.elements.get('refresh-btn').disabled, false);
});

test('stale private responses after authentication expiry cannot republish private information', async () => {
  const stalePrivate = deferred();
  let privateCalls = 0;
  const f = fixture(async url => {
    if (url === '/api/rooms') return rooms();
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    if (url === '/api/admin/rooms') return ++privateCalls === 1 ? rooms(true) : stalePrivate.promise;
    throw responseError(401, '인증이 필요합니다.');
  });
  await f.settle();
  const oldLoad = f.context.loadRooms();
  await f.context.removeRoom('123456', '열린 수업');
  assertPublicView(f);
  stalePrivate.resolve(rooms(true, '만료된 비공개 응답'));
  await oldLoad;
  assertPublicView(f);
  assert.doesNotMatch(f.elements.get('room-rows').innerHTML, /만료된 비공개 응답/);
  assert.equal(f.elements.get('refresh-btn').disabled, false);
});

test('late initial public response cannot overwrite a newer authenticated list', async () => {
  const stalePublic = deferred();
  const f = fixture(async url => {
    if (url === '/api/rooms') return stalePublic.promise;
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    return rooms(true, '관리자 최신 응답');
  });
  await f.settle();
  stalePublic.resolve(rooms(false, '오래된 공개 응답'));
  await f.settle();
  assert.match(f.elements.get('room-rows').innerHTML, /관리자 최신 응답/);
  assert.doesNotMatch(f.elements.get('room-rows').innerHTML, /오래된 공개 응답/);
  assert.match(f.elements.get('room-rows').innerHTML, /KST/);
});
