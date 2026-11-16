'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A minimal page shell, populated from the real HTML rather than an invented
// list of IDs. Booting the real entry script catches stale DOM event handlers.
function pageFixture(role) {
  const html = fs.readFileSync(path.join(__dirname, `../public/${role}.html`), 'utf8');
  function element() {
    const classes = new Set();
    const attributes = new Map();
    const listeners = new Map();
    return {
      style: {}, children: [], value: '', textContent: '', dataset: {}, open: false,
      classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, force) {
          const enabled = force ?? !classes.has(value);
          if (enabled) classes.add(value); else classes.delete(value);
          return enabled;
        },
      },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); value.split(/\s+/).filter(Boolean).forEach(value => classes.add(value)); },
      setAttribute: (key, value) => attributes.set(key, value),
      getAttribute: key => attributes.get(key),
      addEventListener(event, callback) { listeners.set(event, callback); },
      click() { return listeners.get('click')?.({ target: this }); },
      appendChild(child) { this.children.push(child); return child; },
      querySelectorAll() { return []; },
      focus() { this.focused = true; }, remove() {}, close() { this.open = false; },
      listeners,
    };
  }
  const ids = new Map();
  for (const match of html.matchAll(/<[a-z][\w-]*\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const node = element();
    node.className = /\bclass="([^"]*)"/.exec(match[1])?.[1] || '';
    ids.set(match[2], node);
  }
  const body = element();
  const socketHandlers = new Map();
  let options;
  let emojiCloses = 0;
  let participantCloses = 0;
  const context = {
    document: {
      body, getElementById: id => ids.get(id) || null,
      createElement: element, querySelectorAll: () => [], addEventListener() {},
    },
    io: () => ({ on: (event, callback) => socketHandlers.set(event, callback) }),
    EduTalkConnection: class {
      constructor(socket, config) { options = config; }
    },
    EduTalkEmojiPicker: { close: () => emojiCloses++ },
    EduTalkClassroomLayout: { closeParticipants: () => participantCloses++ },
    location: { origin: 'https://class.example', search: '' },
    navigator: {}, URLSearchParams,
    eduRequestJson: async () => ({ ok: true, token: 'browser-secret', room: null }),
    setTimeout() {}, clearInterval() {},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../public/js/${role}.js`), 'utf8'), context);
  return { html, ids, body, options, socketHandlers, emojiCloses: () => emojiCloses, participantCloses: () => participantCloses };
}

test('incoming student survey results dismiss competing overlays and focus the result controls', () => {
  const page = pageFixture('student');
  const invitation = page.ids.get('room-share-dialog');
  invitation.open = true;
  page.socketHandlers.get('survey:resultsShared')({
    question: '오늘 수업은 어떠셨나요?', options: ['좋아요', '다시 설명해 주세요'], results: [2, 1], total: 3,
  });
  assert.equal(page.participantCloses(), 1);
  assert.equal(page.emojiCloses(), 1);
  assert.equal(invitation.open, false);
  assert.equal(page.ids.get('results-modal').style.display, 'flex');
  assert.equal(page.ids.get('results-question').textContent, '오늘 수업은 어떠셨나요?');
  assert.equal(page.ids.get('results-close-btn').focused, true);
});

for (const role of ['instructor', 'student']) {
  test(`${role} page boots without removed AI elements and binds its remaining classroom controls`, async () => {
    const page = pageFixture(role);
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotMatch(page.html, /data-(?:tab|pane)="ai"|id="ai-|\/js\/markdown\.js/);
    const tabs = [...page.html.matchAll(/data-tab="([^"]+)"/g)].map(match => match[1]);
    const panes = [...page.html.matchAll(/data-pane="([^"]+)"/g)].map(match => match[1]);
    assert.equal(tabs.length, 4);
    assert.deepEqual(tabs, panes);
    assert.ok(page.ids.get('chat-send-btn').listeners.has('click'));
    assert.ok(page.ids.get('chat-input').listeners.has('keydown'));
    assert.ok(page.ids.get('file-upload-btn').listeners.has('click'));
    if (role === 'instructor') assert.equal(page.ids.get('setup-btn').disabled, false);
    else assert.ok(page.ids.get('join-btn').listeners.has('click'));
  });

  test(`${role} room closure dismisses mobile navigation and popups before returning to entry`, async () => {
    const page = pageFixture(role);
    await new Promise(resolve => setImmediate(resolve));
    const sidebar = page.ids.get('sidebar');
    const menu = page.ids.get('mobile-menu-btn');
    const overlay = page.body.children.find(node => node.classList.contains('sidebar-overlay'));
    const surveyModal = page.ids.get(role === 'instructor' ? 'custom-survey-modal' : 'results-modal');
    surveyModal.style.display = 'flex';
    if (role === 'instructor') page.ids.get('room-share-dialog').open = true;
    page.ids.get('screen-room').classList.remove('hidden');
    menu.click();
    assert.equal(sidebar.classList.contains('open'), true);
    assert.equal(overlay.classList.contains('visible'), true);
    page.options.onError({ code: 'ROOM_CLOSED', message: '관리자가 강의실을 삭제했습니다.' });
    assert.equal(sidebar.classList.contains('open'), false);
    assert.equal(overlay.classList.contains('visible'), false);
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    assert.equal(page.emojiCloses(), 1);
    assert.equal(surveyModal.style.display, 'none');
    if (role === 'instructor') assert.equal(page.ids.get('room-share-dialog').open, false);
    assert.equal(page.ids.get('screen-room').classList.contains('hidden'), true);
    assert.equal(page.ids.get(role === 'instructor' ? 'screen-setup' : 'screen-join').classList.contains('hidden'), false);
  });
}
