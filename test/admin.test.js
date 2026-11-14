'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(request) {
  const elements = new Map();
  const notices = [];
  let signOuts = 0;
  const calls = [];
  function element() {
    const classes = new Set();
    return { style: {}, disabled: false, textContent: '', innerHTML: '', dataset: {},
      classList: { add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value), toggle(value, on) { on ? classes.add(value) : classes.delete(value); } },
      addEventListener() {}, querySelectorAll: () => [], remove() {} };
  }
  const auth = {
    getSession: async () => ({ data: { session: { access_token: 'supabase-token' } } }),
    signOut: async () => { signOuts++; },
    signInWithOAuth: async () => ({ error: null }),
  };
  const context = {
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      createElement: element,
      body: { appendChild: node => notices.push(node.textContent) },
    },
    location: { origin: 'http://localhost' },
    supabase: { createClient: () => ({ auth }) },
    eduRequestJson: async (url, options, timeout) => {
      calls.push({ url, options, timeout });
      if (url === '/api/config') return { supabaseUrl: 'http://auth.test', supabaseAnonKey: 'anon' };
      return request(url, options);
    },
    setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8'), context);
  return { context, elements, notices, calls, signOuts: () => signOuts,
    settle: () => new Promise(resolve => setImmediate(resolve)) };
}
const responseError = (status, message) => Object.assign(new Error(message), { status });

test('temporary admin authentication failure preserves instructor login and displays the error', async () => {
  const f = fixture(async () => { throw responseError(503, '인증 서버에 연결할 수 없습니다.'); });
  await f.settle();
  assert.equal(f.signOuts(), 0);
  assert.match(f.elements.get('login-error').textContent, /인증 서버/);
  assert.equal(f.elements.get('login-form').classList.contains('hidden'), false);
  assert.equal(f.calls.find(call => call.url === '/api/admin/auth').timeout, 15000);
});

test('opening admin as a non-admin does not sign out a teaching account', async () => {
  const f = fixture(async () => { throw responseError(403, '관리자 계정이 아닙니다.'); });
  await f.settle();
  assert.equal(f.signOuts(), 0);
  assert.equal(f.elements.get('login-error').textContent, '관리자 계정이 아닙니다.');
});

test('admin list and mutation failures remain visible and release controls', async () => {
  const f = fixture(async url => {
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    throw responseError(503, '잠시 후 다시 시도하세요.');
  });
  await f.settle();
  assert.ok(f.notices.some(text => text.includes('목록을 불러오지 못했습니다')));
  await f.context.setStatus('teacher', 'approved');
  assert.ok(f.notices.some(text => text.includes('변경하지 못했습니다')));
  assert.equal(f.elements.get('refresh-btn').disabled, false);
  assert.equal(f.signOuts(), 0);
});

test('expired admin token returns to login without clearing Supabase authentication', async () => {
  const f = fixture(async url => {
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    if (url === '/api/admin/instructors') return { ok: true, instructors: [] };
    throw responseError(401, '인증이 필요합니다.');
  });
  await f.settle();
  await f.context.setStatus('teacher', 'approved');
  assert.equal(f.signOuts(), 0);
  assert.equal(f.elements.get('screen-admin').classList.contains('hidden'), true);
  assert.equal(f.elements.get('screen-login').classList.contains('hidden'), false);
  assert.match(f.elements.get('login-error').textContent, /관리자 인증이 만료/);
});

test('repeated clicks cannot concurrently mutate the same instructor', async () => {
  let resolveUpdate;
  const update = new Promise(resolve => { resolveUpdate = resolve; });
  let mutations = 0;
  const f = fixture(async url => {
    if (url === '/api/admin/auth') return { ok: true, token: 'admin-token' };
    if (url === '/api/admin/instructors') return { ok: true, instructors: [] };
    mutations++;
    return update;
  });
  await f.settle();
  const first = f.context.setStatus('teacher', 'approved');
  await f.context.setStatus('teacher', 'rejected');
  assert.equal(mutations, 1);
  resolveUpdate({ ok: true });
  await first;
  assert.equal(f.elements.get('refresh-btn').disabled, false);
});
