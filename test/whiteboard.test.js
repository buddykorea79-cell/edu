const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  let nextId = 0;
  const frames = new Map();
  const timers = new Map();
  const trace = [];
  const sent = [];
  const images = [];
  const notices = [];
  function element() {
    return {
      listeners: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      appendChild() {},
    };
  }
  const context2d = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { trace.push('stroke'); },
    clearRect() { trace.push('clear'); },
    drawImage(img) { trace.push(img.src); },
  };
  const canvas = Object.assign(element(), {
    width: 0, height: 0,
    getContext() { return context2d; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    setPointerCapture() {},
  });
  const wrap = Object.assign(element(), { clientWidth: 800, clientHeight: 600 });
  const socket = {
    connected: true, roomReady: true, handlers: {},
    on(name, fn) { this.handlers[name] = fn; },
    timeout() { return this; },
    emit(name, payload, ack) { sent.push({ name, payload }); if (ack) ack(null, { ok: true }); },
  };
  const window = { devicePixelRatio: 1, addEventListener() {} };
  const sandbox = {
    window,
    document: {
      getElementById(id) { return { 'wb-canvas': canvas, 'wb-wrap': wrap }[id] || null; },
      addEventListener() {}, querySelectorAll() { return []; }, createElement: element,
    },
    Image: class { constructor() { images.push(this); } },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    showToast(message) { notices.push(message); },
    alert(message) { notices.push(message); },
    AbortController,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/whiteboard.js'), 'utf8'), sandbox);
  window.Whiteboard.init({ socket, canClear: false });
  function frame() {
    const jobs = [...frames.values()]; frames.clear(); jobs.forEach(fn => fn());
  }
  function drainFrames() {
    let remaining = 1000;
    while (frames.size && remaining-- > 0) frame();
    assert.ok(remaining > 0, 'render scheduling must finish');
  }
  function timer() {
    const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn());
  }
  function pointer(event, x = 10, y = 10) {
    canvas.listeners[event]({ pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y });
  }
  return { board: window.Whiteboard, socket, canvas, wrap, sent, images, trace, notices,
    frames, frame, drainFrames, timer, pointer };
}

const stroke = { type: 'stroke', x0: 0, y0: 0, x1: 1, y1: 1, width: 3, color: '#000', erase: false };

test('high-frequency pointer moves produce bounded batches and render only server-confirmed strokes', () => {
  const s = setup();
  s.board.load([]); s.drainFrames(); s.trace.length = 0;
  s.pointer('pointerdown');
  for (let i = 0; i < 100; i++) s.pointer('pointermove', i + 20);
  s.frame();
  assert.equal(s.sent.length, 0);
  s.timer();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].name, 'whiteboard:drawBatch');
  assert.equal(s.sent[0].payload.length, 1);
  assert.deepEqual(s.trace, []);
  s.socket.handlers['whiteboard:drawBatch'](s.sent[0].payload);
  s.drainFrames();
  assert.deepEqual(s.trace, ['stroke']);
});

test('disconnect drops pending drawing and prevents offline Socket.IO buffering', () => {
  const s = setup();
  s.pointer('pointerdown'); s.pointer('pointermove', 200); s.frame();
  s.socket.connected = false;
  s.socket.handlers.disconnect();
  s.timer();
  s.pointer('pointerdown'); s.pointer('pointermove', 300); s.frame(); s.timer();
  assert.equal(s.sent.length, 0);
  s.socket.connected = true;
  s.board.load([]); s.timer();
  assert.equal(s.sent.length, 0);
});

test('large snapshots are capped and replayed in chunks without redundant tab-show redraws', () => {
  const s = setup();
  s.board.load(Array.from({ length: 10005 }, () => ({ ...stroke })));
  s.frame();
  assert.equal(s.trace.filter(value => value === 'stroke').length, 200);
  s.drainFrames();
  assert.equal(s.trace.filter(value => value === 'stroke').length, 10000);
  s.trace.length = 0;
  s.board.show(); s.drainFrames();
  assert.deepEqual(s.trace, []);
  s.socket.handlers['whiteboard:draw'](stroke); s.drainFrames();
  assert.deepEqual(s.trace, [], 'server cap must also bound client history');
});

test('asynchronous images replay in server order and clearing releases cached images', () => {
  const s = setup();
  const image = { type: 'image', url: '/uploads/a.png', x: 0, y: 0, w: 0.5, h: 0.5 };
  s.board.load([image, stroke]); s.drainFrames();
  assert.deepEqual(s.trace, ['clear', 'stroke']);
  s.images[0].onload(); s.drainFrames();
  assert.deepEqual(s.trace.slice(-3), ['clear', '/uploads/a.png', 'stroke']);
  s.socket.handlers['whiteboard:cleared'](); s.drainFrames();
  assert.equal(s.images[0].onload, null);
  assert.equal(s.images[0].src, '');
  assert.equal(s.trace.at(-1), 'clear');
});

test('hidden boards accumulate bounded state without drawing until shown', () => {
  const s = setup();
  s.wrap.clientWidth = 0;
  s.board.load([]);
  for (let i = 0; i < 100; i++) s.socket.handlers['whiteboard:drawBatch']([stroke]);
  assert.equal(s.frames.size, 0);
  s.wrap.clientWidth = 800;
  s.board.show(); s.drainFrames();
  assert.equal(s.trace.filter(value => value === 'stroke').length, 100);
});
