const test = require('node:test');
const assert = require('node:assert/strict');
const { insertEmoji } = require('../public/js/emoji-picker');

function input(value, start = value.length, end = start, maxLength = 2000) {
  return {
    value, selectionStart: start, selectionEnd: end, maxLength,
    events: [], focused: false,
    focus() { this.focused = true; },
    setRangeText(text, from, to, mode) {
      assert.equal(mode, 'end');
      this.value = this.value.slice(0, from) + text + this.value.slice(to);
      this.selectionStart = this.selectionEnd = from + text.length;
    },
    dispatchEvent(event) { this.events.push(event); },
  };
}

test('chat emoji inserts at the saved caret and retains the rest of the draft', () => {
  const draft = input('오늘도 좋은 수업', 10);
  assert.equal(insertEmoji(draft, '👍', { start: 4, end: 4 }), true);
  assert.equal(draft.value, '오늘도 👍좋은 수업');
  assert.equal(draft.selectionStart, 6);
  assert.equal(draft.selectionEnd, 6);
  assert.equal(draft.focused, true);
  assert.equal(draft.events.length, 1);
  assert.equal(draft.events[0].type, 'input');
  assert.equal(draft.events[0].bubbles, true);
});

test('emoji replaces selected text and counts the removed selection against maxlength', () => {
  const draft = input('고마워요!', 0, 4, 5);
  assert.equal(insertEmoji(draft, '❤️'), true);
  assert.equal(draft.value, '❤️!');
  assert.equal(draft.selectionStart, '❤️'.length);
});

test('length limit rejects complete multi-codepoint emoji without changing draft or selection', () => {
  for (const emoji of ['👍', '❤️', '👨‍👩‍👧‍👦']) {
    const draft = input('a'.repeat(1999));
    assert.equal(insertEmoji(draft, emoji), false);
    assert.equal(draft.value, 'a'.repeat(1999));
    assert.equal(draft.selectionStart, 1999);
    assert.equal(draft.events.length, 0);
  }
});

test('emoji fits exactly at maxlength and does not modify disabled or readonly input', () => {
  const draft = input('a'.repeat(1998));
  assert.equal(insertEmoji(draft, '👍'), true);
  assert.equal(draft.value.length, 2000);
  for (const state of ['disabled', 'readOnly']) {
    const blocked = input('보관할 메시지');
    blocked[state] = true;
    assert.equal(insertEmoji(blocked, '😊'), false);
    assert.equal(blocked.value, '보관할 메시지');
    assert.equal(blocked.events.length, 0);
  }
});
