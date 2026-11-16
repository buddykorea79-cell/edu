'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const documentEvents = new Map();
  const windowEvents = new Map();
  const media = { matches: true, addEventListener() {} };
  let visibilityChanged;
  const document = { activeElement: null };
  function element() {
    const classes = new Set();
    const attributes = new Map();
    const events = new Map();
    return {
      hidden: false, inert: false, children: [],
      classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
      set className(value) { value.split(/\s+/).forEach(key => classes.add(key)); },
      getAttribute: key => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, value),
      removeAttribute: key => attributes.delete(key),
      addEventListener: (key, callback) => events.set(key, callback),
      focus() { document.activeElement = this; },
      click() { events.get('click')?.(); },
      appendChild(child) { this.children.push(child); },
      querySelectorAll() { return this.children; },
      contains(other) { return other === this || this.children.includes(other); },
      getClientRects() { return [{}]; },
    };
  }
  const ids = new Map(['participants-panel', 'participants-toggle', 'participants-close', 'screen-room', 'sidebar', 'mobile-menu-btn'].map(key => [key, element()]));
  const panel = ids.get('participants-panel');
  panel.children.push(ids.get('participants-close'));
  const chat = element();
  chat.classList.add('active');
  const tab = element();
  const sidebarOverlay = element();
  Object.assign(document, {
    body: element(),
    getElementById: id => ids.get(id),
    querySelector: () => chat,
    querySelectorAll: selector => selector === '.sidebar-overlay' ? [sidebarOverlay] : [tab],
    createElement: element,
    addEventListener: (key, callback) => documentEvents.set(key, callback),
  });
  const context = { document, matchMedia: () => media,
    addEventListener: (key, callback) => windowEvents.set(key, callback),
    MutationObserver: class { constructor(callback) { visibilityChanged = callback; } observe() {} },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/classroom-layout.js'), 'utf8'), context);
  return { ids, panel, chat, tab, document, sidebarOverlay, context, media,
    overlay: document.body.children[0], visibilityChanged: () => visibilityChanged(),
    resize: () => windowEvents.get('resize')(),
    key(key, shiftKey = false) { const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } }; documentEvents.get('keydown')(event); return event; } };
}

test('mobile participant drawer closes left navigation and manages focus and dismissal', () => {
  const f = fixture();
  const toggle = f.ids.get('participants-toggle');
  const close = f.ids.get('participants-close');
  f.ids.get('sidebar').classList.add('open');
  f.sidebarOverlay.classList.add('visible');
  toggle.click();
  assert.equal(f.panel.inert, false);
  assert.equal(f.panel.getAttribute('aria-modal'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.ids.get('sidebar').classList.contains('open'), false);
  assert.equal(f.sidebarOverlay.classList.contains('visible'), false);
  assert.equal(f.document.activeElement, close);
  assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.document.activeElement, close);
  f.key('Escape');
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.panel.inert, true);
  assert.equal(f.panel.getAttribute('aria-modal'), null);
  assert.equal(f.document.activeElement, toggle);
  toggle.click();
  f.overlay.click();
  assert.equal(f.overlay.hidden, true);
});

test('tab switches, room closure and left-menu activation dismiss the drawer without stealing focus', () => {
  const f = fixture();
  const toggle = f.ids.get('participants-toggle');
  const close = f.ids.get('participants-close');
  toggle.click();
  f.tab.click();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.document.activeElement, close);
  toggle.click();
  f.chat.classList.remove('active');
  f.visibilityChanged();
  assert.equal(f.overlay.hidden, true);
  toggle.click();
  assert.equal(f.overlay.hidden, true);
  f.chat.classList.add('active');
  toggle.click();
  f.ids.get('mobile-menu-btn').click();
  assert.equal(f.overlay.hidden, true);
  toggle.click();
  f.ids.get('screen-room').classList.add('hidden');
  f.visibilityChanged();
  assert.equal(f.overlay.hidden, true);
  toggle.click();
  assert.equal(f.overlay.hidden, true);
});

test('desktop resizing removes modal state and exposes the roster without forcing focus', () => {
  const f = fixture();
  f.ids.get('participants-toggle').click();
  f.media.matches = false;
  f.resize();
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.panel.inert, false);
  assert.equal(f.panel.getAttribute('role'), null);
  assert.equal(f.ids.get('participants-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, f.ids.get('participants-close'));
  f.ids.get('participants-toggle').click();
  assert.equal(f.overlay.hidden, true);
  f.media.matches = true;
  f.resize();
  assert.equal(f.panel.inert, true);
});
