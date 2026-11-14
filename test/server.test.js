'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

// This process is a local smoke test; never use a developer's live auth project.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
const app = require('../server');

test('production entry point wires static assets, health and safe API errors', async t => {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const health = await fetch(url + '/api/ping');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await health.json()).ok, true);
  for (const file of ['/', '/student.html', '/instructor.html', '/admin.html', '/css/style.css', '/js/connection.js', '/vendor/supabase.js', '/socket.io/socket.io.js']) {
    const response = await fetch(url + file);
    assert.equal(response.status, 200, file);
    assert.ok((await response.text()).length > 100, file);
  }
  for (const route of ['/api/upload', '/api/ai/chat', '/api/instructor/session', '/api/admin/auth']) {
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
