const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const { installHttpServices } = require('../lib/http-services');

const validChat = { apiKey: 'test-key', messages: [{ role: 'user', content: 'hello' }] };
const auth = (id = 'student-1') => ({ 'X-Socket-Id': id, 'X-Upload-Token': 'valid' });

async function setup(t, { aiTimeoutMs = 2000, maxAiRequests = 8, getSession } = {}) {
  const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'edutalk-http-test-'));
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const upstreams = [];
  const services = installHttpServices(app, {
    uploadsDir, aiTimeoutMs, maxAiRequests,
    getHttpSession: getSession || ((id, token) => id && token === 'valid' ? { participantId: id, roomCode: '123456' } : null),
    request(options, onResponse) {
      const req = new EventEmitter();
      req.options = options;
      req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = body => { req.body = JSON.parse(body); };
      req.respond = (status, payload) => {
        const response = new PassThrough();
        response.statusCode = status;
        req.response = response;
        onResponse(response);
        if (payload !== undefined) response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        return response;
      };
      upstreams.push(req);
      return req;
    },
  });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    services.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });
  const chat = (body = validChat, id = 'student-1', options = {}) => fetch(`${url}/api/ai/chat`, {
    method: 'POST', headers: { ...auth(id), 'Content-Type': 'application/json' },
    body: JSON.stringify(body), ...options,
  });
  async function waitForRequests(count) {
    for (let i = 0; i < 100; i++) {
      if (upstreams.length >= count) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`Expected ${count} upstream requests, got ${upstreams.length}`);
  }
  return { url, upstreams, chat, waitForRequests, uploadsDir, services };
}

function multipart(filename = 'class.txt', content = 'class file') {
  const data = new FormData();
  data.append('file', new Blob([content], { type: 'application/octet-stream' }), filename);
  return data;
}

test('AI and upload reject requests without an active room session', async t => {
  const s = await setup(t);
  for (const route of ['/api/ai/chat', '/api/upload']) {
    const response = await fetch(s.url + route, { method: 'POST' });
    assert.equal(response.status, 401);
  }
  assert.equal(s.upstreams.length, 0);
  assert.deepEqual(await fs.readdir(s.uploadsDir), []);
});

test('single-file multipart upload succeeds and uses a generated safe filename', async t => {
  const s = await setup(t);
  const response = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart('lesson.TXT') });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.match(body.url, /^\/uploads\/[a-f0-9-]+\.txt$/);
  assert.equal(body.filename, 'lesson.TXT');
  const files = await fs.readdir(s.uploadsDir);
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(path.join(s.uploadsDir, files[0]), 'utf8'), 'class file');
});

test('browser multipart uploads preserve Korean and mixed Unicode display filenames', async t => {
  const s = await setup(t);
  for (const filename of ['당첨자_20261116_0955.csv', '출석부_20261115_0021.csv', '수업 자료 résumé 日本語 😀.PDF', 'lesson_20261116.TXT']) {
    await t.test(filename, async () => {
      const response = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart(filename) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.filename, filename);
      assert.match(body.url, /^\/uploads\/[a-f0-9-]+\.(csv|pdf|txt)$/);
      assert.equal(await fs.readFile(path.join(s.uploadsDir, path.basename(body.url)), 'utf8'), 'class file');
    });
  }
});

test('explicit multipart filename charsets are respected without double decoding', async t => {
  const s = await setup(t);
  for (const [parameter, filename] of [
    [`UTF-8''${encodeURIComponent('한글_자료 😀.csv')}`, '한글_자료 😀.csv'],
    [`UTF-8''${encodeURIComponent('café_École.csv')}`, 'café_École.csv'],
    ["ISO-8859-1''caf%E9.csv", 'café.csv'],
  ]) {
    await t.test(parameter, async () => {
      const boundary = 'filename-charset-boundary';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fallback.csv"; filename*=${parameter}\r\nContent-Type: text/csv\r\n\r\nclass file\r\n--${boundary}--\r\n`;
      const response = await fetch(`${s.url}/api/upload`, {
        method: 'POST', headers: { ...auth(), 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body,
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.filename, filename);
      assert.match(result.url, /^\/uploads\/[a-f0-9-]+\.csv$/);
    });
  }
});

test('multipart rejects missing files, fields, extra files and oversized files without leftovers', async t => {
  const s = await setup(t);
  const fields = multipart(); fields.append('extra', 'value');
  const extraFile = multipart(); extraFile.append('file', new Blob(['extra']), 'extra.txt');
  const tooLarge = multipart('large.bin', Buffer.alloc(20 * 1024 * 1024 + 1));
  for (const body of [new FormData(), fields, extraFile, tooLarge]) {
    const response = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body });
    assert.equal(response.status, 400, await response.text());
    assert.deepEqual(await fs.readdir(s.uploadsDir), []);
  }
  // Rejected uploads must release the per-member and global concurrency slots.
  const next = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart() });
  assert.equal(next.status, 200, await next.text());
});

test('completed upload is discarded when room membership changed during the request', async t => {
  let checks = 0;
  const s = await setup(t, { getSession: () => ++checks === 1 ? { participantId: 'student' } : null });
  const response = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart() });
  assert.equal(response.status, 401, await response.text());
  assert.deepEqual(await fs.readdir(s.uploadsDir), []);
});

test('upload cannot finish in a different room or as a different participant with the same socket headers', async t => {
  for (const endingSession of [
    { participantId: 'student-1', roomCode: '654321' },
    { participantId: 'student-2', roomCode: '123456' },
  ]) {
    await t.test(`changed ${endingSession.roomCode === '123456' ? 'participant' : 'room'}`, async child => {
      let checks = 0;
      const s = await setup(child, { getSession: () => ++checks === 1
        ? { participantId: 'student-1', roomCode: '123456' } : endingSession });
      const response = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart() });
      assert.equal(response.status, 401, await response.text());
      assert.deepEqual(await fs.readdir(s.uploadsDir), []);
    });
  }
});

test('malformed AI requests are rejected before contacting provider', async t => {
  const s = await setup(t);
  const invalid = [
    {}, null, { ...validChat, apiKey: '\r\ninjected' },
    { ...validChat, messages: 'invalid' },
    { ...validChat, messages: [null] },
    { ...validChat, messages: [{ role: 'tool', content: 'x' }] },
    { ...validChat, messages: [{ role: 'user', content: 123 }] },
    { ...validChat, messages: [{ role: 'user', content: 'x'.repeat(20001) }] },
    { ...validChat, messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) },
    { ...validChat, model: {} },
  ];
  for (const body of invalid) {
    const response = await s.chat(body);
    assert.equal(response.status, 400);
  }
  assert.equal(s.upstreams.length, 0);
});

test('AI request strips extra fields and preserves split UTF-8 provider responses', async t => {
  const s = await setup(t);
  const responsePromise = s.chat({ ...validChat, messages: [{ role: 'user', content: '안녕', ignored: true }] });
  await s.waitForRequests(1);
  assert.deepEqual(s.upstreams[0].body.messages, [{ role: 'user', content: '안녕' }]);
  const upstream = s.upstreams[0].respond(200);
  const payload = Buffer.from(JSON.stringify({ choices: [{ message: { content: '안녕하세요' } }] }));
  for (const byte of payload) upstream.write(Buffer.from([byte]));
  upstream.end();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { content: '안녕하세요' });
  assert.equal(s.upstreams[0].destroyed, true);
});

test('AI concurrency is limited per member and globally, with slots released after completion', async t => {
  const s = await setup(t);
  const active = [];
  for (let i = 0; i < 8; i++) active.push(s.chat(validChat, `student-${i}`));
  await s.waitForRequests(8);
  const duplicate = await s.chat(validChat, 'student-0');
  assert.equal(duplicate.status, 429);
  const overCapacity = await s.chat(validChat, 'student-9');
  assert.equal(overCapacity.status, 429);
  assert.equal(overCapacity.headers.get('retry-after'), '5');
  s.upstreams.forEach(req => req.respond(200, { choices: [{ message: { content: 'ok' } }] }));
  for (const response of await Promise.all(active)) assert.equal(response.status, 200);
  const next = s.chat(validChat, 'student-9');
  await s.waitForRequests(9);
  s.upstreams[8].respond(200, { choices: [{ message: { content: 'ok' } }] });
  assert.equal((await next).status, 200);
});

test('30 students can request AI simultaneously within the configured 32-request limit', async t => {
  const s = await setup(t, { maxAiRequests: 32, aiTimeoutMs: 5000 });
  const active = Array.from({ length: 30 }, (_, index) => s.chat(validChat, `student-${index}`));
  await s.waitForRequests(30);
  assert.equal(s.upstreams.length, 30);
  s.upstreams.forEach((req, index) => req.respond(200, { choices: [{ message: { content: `answer-${index}` } }] }));
  const responses = await Promise.all(active);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match((await response.json()).content, /^answer-\d+$/);
  }
  assert.equal(s.upstreams.filter(req => req.destroyed).length, 30);
});

test('AI deadline cancels provider request and releases member slot', async t => {
  const s = await setup(t, { aiTimeoutMs: 30 });
  const response = await s.chat();
  assert.equal(response.status, 504);
  assert.equal(s.upstreams[0].destroyed, true);
  const next = s.chat();
  await s.waitForRequests(2);
  s.upstreams[1].respond(200, { choices: [{ message: { content: 'retry succeeded' } }] });
  assert.equal((await next).status, 200);
});

test('AI client abort cancels provider request and releases member slot', async t => {
  const s = await setup(t);
  const controller = new AbortController();
  const pending = s.chat(validChat, 'student-1', { signal: controller.signal }).catch(error => error);
  await s.waitForRequests(1);
  controller.abort();
  await pending;
  for (let i = 0; i < 100 && !s.upstreams[0].destroyed; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.upstreams[0].destroyed, true);
  const next = s.chat();
  await s.waitForRequests(2);
  s.upstreams[1].respond(200, { choices: [{ message: { content: 'retry succeeded' } }] });
  assert.equal((await next).status, 200);
});

test('AI provider malformed, error, aborted and oversized responses finish safely', async t => {
  const s = await setup(t);
  const cases = [
    req => req.emit('error', new Error('connection failed')),
    req => req.respond(200, 'not json'),
    req => req.respond(200, { choices: [] }),
    req => req.respond(503, { error: { message: 'unavailable' } }),
    req => req.respond(200).emit('aborted'),
    req => req.respond(200).end(Buffer.alloc(2 * 1024 * 1024 + 1)),
  ];
  for (let i = 0; i < cases.length; i++) {
    const pending = s.chat();
    await s.waitForRequests(i + 1);
    cases[i](s.upstreams[i]);
    assert.equal((await pending).status, 502);
    assert.equal(s.upstreams[i].destroyed, true);
  }
  const rateLimit = s.chat(); await s.waitForRequests(7);
  s.upstreams[6].respond(429, { error: { message: 'x'.repeat(1000) } });
  const response = await rateLimit;
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.length, 400);
});

test('aborted upload removes the partial file and releases the participant upload slot', async t => {
  const s = await setup(t);
  const pending = http.request(`${s.url}/api/upload`, {
    method: 'POST', headers: { ...auth(), 'Content-Type': 'multipart/form-data; boundary=class-boundary' },
  });
  pending.on('error', () => {});
  t.after(() => pending.destroy());
  pending.write('--class-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: application/octet-stream\r\n\r\n');
  pending.write(Buffer.alloc(8192));
  for (let i = 0; i < 100 && (await fs.readdir(s.uploadsDir)).length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await fs.readdir(s.uploadsDir)).length, 1);
  const duplicate = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart() });
  assert.equal(duplicate.status, 429);
  pending.destroy();
  for (let i = 0; i < 100 && (await fs.readdir(s.uploadsDir)).length > 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(await fs.readdir(s.uploadsDir), []);
  const next = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth(), body: multipart() });
  assert.equal(next.status, 200, await next.text());
});

test('global upload concurrency is capped at four and aborted uploads release all slots', async t => {
  const s = await setup(t);
  const pending = [];
  for (let i = 0; i < 4; i++) {
    const req = http.request(`${s.url}/api/upload`, {
      method: 'POST', headers: { ...auth(`student-${i}`), 'Content-Type': 'multipart/form-data; boundary=batch-boundary' },
    });
    req.on('error', () => {});
    req.write('--batch-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: application/octet-stream\r\n\r\n');
    req.write(Buffer.alloc(8192));
    pending.push(req);
  }
  t.after(() => pending.forEach(req => req.destroy()));
  for (let i = 0; i < 100 && (await fs.readdir(s.uploadsDir)).length < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await fs.readdir(s.uploadsDir)).length, 4);
  const overflow = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth('student-9'), body: multipart() });
  assert.equal(overflow.status, 429);
  pending.forEach(req => req.destroy());
  for (let i = 0; i < 100 && (await fs.readdir(s.uploadsDir)).length > 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(await fs.readdir(s.uploadsDir), []);
  const next = await fetch(`${s.url}/api/upload`, { method: 'POST', headers: auth('student-9'), body: multipart() });
  assert.equal(next.status, 200, await next.text());
});

test('upload cleanup removes expired files and retains recent files', async t => {
  const s = await setup(t);
  const oldFile = path.join(s.uploadsDir, 'old.txt');
  const newFile = path.join(s.uploadsDir, 'recent.txt');
  await fs.writeFile(oldFile, 'old');
  await fs.writeFile(newFile, 'new');
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(oldFile, oldTime, oldTime);
  await s.services.cleanupUploads();
  assert.deepEqual(await fs.readdir(s.uploadsDir), ['recent.txt']);
});

test('shutdown answers pending AI requests and destroys active uploads without leaving partial files', async t => {
  const s = await setup(t, { aiTimeoutMs: 5000 });
  const chats = Array.from({ length: 3 }, (_, index) => s.chat(validChat, `student-${index}`));
  await s.waitForRequests(3);
  const upload = http.request(`${s.url}/api/upload`, {
    method: 'POST', headers: { ...auth(), 'Content-Type': 'multipart/form-data; boundary=shutdown-boundary' },
  });
  upload.on('error', () => {});
  t.after(() => upload.destroy());
  upload.write('--shutdown-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\nContent-Type: application/octet-stream\r\n\r\n');
  upload.write(Buffer.alloc(8192));
  for (let i = 0; i < 100 && (await fs.readdir(s.uploadsDir)).length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await fs.readdir(s.uploadsDir)).length, 1);
  s.services.close();
  for (const response of await Promise.all(chats)) assert.equal(response.status, 503);
  assert.equal(s.upstreams.filter(req => req.destroyed).length, 3);
  for (let i = 0; i < 100 && (!upload.destroyed || (await fs.readdir(s.uploadsDir)).length > 0); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(upload.destroyed, true);
  assert.deepEqual(await fs.readdir(s.uploadsDir), []);
});
