'use strict';

(function (global) {
  const categories = [
    { name: '표정', icon: '😊', items: [
      ['😀', '활짝 웃는 얼굴'], ['😄', '눈웃음'], ['😊', '미소'], ['😂', '웃음 눈물'],
      ['🤣', '크게 웃음'], ['😍', '하트 눈'], ['🥰', '사랑스러운 얼굴'], ['😘', '입맞춤'],
      ['😉', '윙크'], ['😎', '멋진 얼굴'], ['🤔', '생각 중'], ['🧐', '궁금해요'],
      ['😮', '놀람'], ['🥹', '감동'], ['🥺', '부탁해요'], ['😢', '슬픔'],
      ['😭', '울음'], ['😅', '머쓱한 웃음'], ['😴', '졸려요'], ['😤', '힘내요'],
    ] },
    { name: '손모양', icon: '👋', items: [
      ['👍', '좋아요'], ['👎', '아쉬워요'], ['👏', '박수'], ['🙌', '만세'],
      ['👋', '인사'], ['🤚', '손 들기'], ['✋', '잠깐만요'], ['👌', '오케이'],
      ['✌️', '브이'], ['🤞', '행운을 빌어요'], ['🤟', '사랑해요 손짓'], ['🤘', '신나요'],
      ['🤙', '연락해요'], ['💪', '힘내세요'], ['🙏', '감사해요'], ['🤝', '악수'],
      ['🫶', '손 하트'], ['👊', '파이팅'], ['☝️', '한 가지 질문'], ['👉', '여기를 보세요'],
    ] },
    { name: '하트', icon: '❤️', items: [
      ['❤️', '빨간 하트'], ['🧡', '주황 하트'], ['💛', '노란 하트'], ['💚', '초록 하트'],
      ['💙', '파란 하트'], ['💜', '보라 하트'], ['🩷', '분홍 하트'], ['🩵', '하늘색 하트'],
      ['🤍', '흰 하트'], ['🖤', '검은 하트'], ['🤎', '갈색 하트'], ['💖', '반짝이는 하트'],
      ['💕', '두 개의 하트'], ['💗', '커지는 하트'], ['💓', '두근두근 하트'], ['💝', '선물 하트'],
    ] },
    { name: '응원', icon: '🎉', items: [
      ['🎉', '축하해요'], ['🎊', '축하 꽃가루'], ['✨', '반짝반짝'], ['🌟', '빛나는 별'],
      ['🔥', '열정'], ['💯', '백 점'], ['✅', '확인했어요'], ['🎯', '목표 달성'],
      ['🏆', '최고예요'], ['💡', '아이디어'], ['📚', '공부'], ['☕', '잠깐 쉬어요'],
    ] },
  ];

  // maxlength is measured in UTF-16 by HTML inputs and the chat server. Reject
  // the whole emoji when it does not fit, rather than cutting a joined sequence.
  function insertEmoji(input, emoji, range) {
    if (input.disabled || input.readOnly) return false;
    const value = input.value;
    const start = Math.max(0, Math.min(range?.start ?? input.selectionStart ?? value.length, value.length));
    const end = Math.max(start, Math.min(range?.end ?? input.selectionEnd ?? start, value.length));
    if (input.maxLength >= 0 && value.length - (end - start) + emoji.length > input.maxLength) return false;
    input.focus();
    input.setRangeText(emoji, start, end, 'end');
    const InputEvent = input.ownerDocument?.defaultView?.Event || global.Event;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  }

  function mount() {
    const document = global.document;
    const input = document.getElementById('chat-input');
    if (!input || document.getElementById('chat-emoji-toggle')) return;
    const composer = input.closest('.chat-input-area');
    if (!composer) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'chat-emoji-toggle';
    button.className = 'chat-emoji-toggle';
    button.textContent = '😊';
    button.title = '이모지 선택';
    button.setAttribute('aria-label', '이모지 선택');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'chat-emoji-picker');
    button.setAttribute('aria-expanded', 'false');
    composer.insertBefore(button, input);

    const panel = document.createElement('div');
    panel.id = 'chat-emoji-picker';
    panel.className = 'chat-emoji-picker';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '채팅 이모지 선택');
    const header = document.createElement('div');
    header.className = 'chat-emoji-header';
    const title = document.createElement('strong');
    title.textContent = '마음을 전하는 이모지';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'chat-emoji-close';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', '이모지 선택 닫기');
    header.append(title, closeButton);

    const categoryBar = document.createElement('div');
    categoryBar.className = 'chat-emoji-categories';
    categoryBar.setAttribute('role', 'group');
    categoryBar.setAttribute('aria-label', '이모지 종류');
    const grid = document.createElement('div');
    grid.className = 'chat-emoji-options';
    const status = document.createElement('div');
    status.className = 'chat-emoji-status';
    status.setAttribute('role', 'status');
    panel.append(header, categoryBar, grid, status);
    document.body.appendChild(panel);

    let selection;
    function rememberSelection() {
      selection = { start: input.selectionStart, end: input.selectionEnd };
    }
    function close(returnFocus = false) {
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (returnFocus) button.focus();
    }
    function position() {
      if (panel.hidden) return;
      const viewport = global.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0;
      const topEdge = viewport?.offsetTop || 0;
      const width = viewport?.width || global.innerWidth;
      const height = viewport?.height || global.innerHeight;
      const anchor = button.getBoundingClientRect();
      panel.style.maxHeight = Math.max(100, height - 24) + 'px';
      panel.style.width = Math.min(340, width - 24) + 'px';
      panel.style.left = Math.max(leftEdge + 12, Math.min(anchor.left, leftEdge + width - panel.offsetWidth - 12)) + 'px';
      panel.style.top = Math.max(topEdge + 12, Math.min(anchor.top - panel.offsetHeight - 10, topEdge + height - panel.offsetHeight - 12)) + 'px';
    }
    function renderCategory(index) {
      Array.from(categoryBar.children).forEach((item, i) => item.setAttribute('aria-pressed', String(i === index)));
      grid.replaceChildren();
      grid.setAttribute('aria-label', categories[index].name);
      categories[index].items.forEach(([emoji, label]) => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'chat-emoji-choice';
        choice.textContent = emoji;
        choice.title = label;
        choice.setAttribute('aria-label', label);
        choice.addEventListener('click', () => {
          if (insertEmoji(input, emoji, selection)) close();
          else status.textContent = input.disabled || input.readOnly
            ? '지금은 메시지를 입력할 수 없습니다.' : '메시지 길이 제한으로 이모지를 추가할 수 없습니다.';
        });
        grid.appendChild(choice);
      });
      status.textContent = '선택하면 메시지에 추가됩니다.';
      position();
    }
    categories.forEach((category, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = category.icon + ' ' + category.name;
      item.addEventListener('click', () => renderCategory(index));
      categoryBar.appendChild(item);
    });
    renderCategory(0);

    button.addEventListener('pointerdown', rememberSelection);
    button.addEventListener('click', () => {
      if (!panel.hidden) { close(true); return; }
      rememberSelection();
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      position();
      categoryBar.querySelector('[aria-pressed="true"]').focus();
    });
    closeButton.addEventListener('click', () => close(true));
    document.addEventListener('pointerdown', event => {
      if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close();
    });
    document.addEventListener('focusin', event => {
      if (!panel.hidden && !panel.contains(event.target) && event.target !== button) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(true); }
    });
    global.EduTalkEmojiPicker = { close };
    global.addEventListener('resize', position);
    global.visualViewport?.addEventListener('resize', position);
    global.visualViewport?.addEventListener('scroll', position);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { insertEmoji };
  if (global.document) {
    if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
