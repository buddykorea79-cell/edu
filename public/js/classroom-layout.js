'use strict';

// The roster is always available beside desktop chat and becomes a right-hand
// drawer on narrow screens. It shares no state with room membership or messages.
(function (global) {
  const document = global.document;
  const panel = document.getElementById('participants-panel');
  const toggle = document.getElementById('participants-toggle');
  const closeButton = document.getElementById('participants-close');
  const room = document.getElementById('screen-room');
  const chat = document.querySelector('[data-pane="chat"]');
  if (!panel || !toggle || !closeButton || !room || !chat) return;

  const mobile = global.matchMedia?.('(max-width: 768px)');
  const isMobile = () => mobile ? mobile.matches : global.innerWidth <= 768;
  const isChatVisible = () => !room.classList.contains('hidden') && chat.classList.contains('active');
  const originalRole = panel.getAttribute('role');
  const overlay = document.createElement('div');
  overlay.className = 'participants-overlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  document.body.appendChild(overlay);
  let opened = false;

  function closeParticipants(returnFocus = false) {
    const wasOpen = opened;
    opened = false;
    panel.classList.remove('open');
    panel.inert = isMobile();
    overlay.classList.remove('visible');
    overlay.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    panel.removeAttribute('aria-modal');
    if (originalRole === null) panel.removeAttribute('role');
    else panel.setAttribute('role', originalRole);
    if (returnFocus && wasOpen && isMobile() && isChatVisible()) toggle.focus();
  }

  function openParticipants() {
    if (!isMobile() || !isChatVisible()) return;
    document.getElementById('sidebar')?.classList.remove('open');
    document.querySelectorAll('.sidebar-overlay').forEach(item => item.classList.remove('visible'));
    document.getElementById('mobile-menu-btn')?.setAttribute('aria-expanded', 'false');
    global.EduTalkEmojiPicker?.close();
    opened = true;
    panel.inert = false;
    panel.classList.add('open');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    overlay.hidden = false;
    overlay.classList.add('visible');
    toggle.setAttribute('aria-expanded', 'true');
    closeButton.focus();
  }

  toggle.addEventListener('click', () => opened ? closeParticipants(true) : openParticipants());
  closeButton.addEventListener('click', () => closeParticipants(true));
  overlay.addEventListener('click', () => closeParticipants(true));
  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => closeParticipants());
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => closeParticipants()));

  document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeParticipants(true);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getClientRects().length > 0);
    const first = focusable[0] || closeButton;
    const last = focusable[focusable.length - 1] || closeButton;
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  });

  const updateViewport = () => {
    if (!isMobile()) closeParticipants();
    else panel.inert = !opened;
  };
  global.addEventListener('resize', updateViewport);
  mobile?.addEventListener?.('change', updateViewport);

  // Socket events can change the selected tab without a click, or return the
  // page to its entry screen. Neither case should leave a blocking overlay.
  if (global.MutationObserver) {
    const observer = new global.MutationObserver(() => {
      if (opened && !isChatVisible()) closeParticipants();
    });
    observer.observe(room, { attributes: true, attributeFilter: ['class'] });
    observer.observe(chat, { attributes: true, attributeFilter: ['class'] });
  }

  global.EduTalkClassroomLayout = { closeParticipants };
  closeParticipants();
})(window);
