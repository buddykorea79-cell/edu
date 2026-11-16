'use strict';

// Room membership must be restored after every transport reconnect. Socket.IO's
// transport connection alone does not mean that the server has joined our room.
(function (global) {
  const randomId = () => global.crypto.randomUUID();

  class EduTalkConnection {
    constructor(socket, options) {
      this.socket = socket;
      this.options = options;
      this.desired = null;
      this.pending = new Map();
      this.generation = 0;
      this.joinTimer = null;
      this.joining = false;
      this.participantId = '';
      this.uploadToken = '';
      this.hadJoined = false;
      this.recoveryDeadline = 0;
      try {
        const key = 'edutalk-session-' + options.joinEvent;
        this.sessionId = sessionStorage.getItem(key) || randomId();
        sessionStorage.setItem(key, this.sessionId);
      } catch (_) {
        this.sessionId = randomId();
      }
      this.setReady(false, '연결 중');
      socket.on('connect', () => {
        this.setReady(false, this.desired ? '강의실 복구 중' : '입장 대기');
        this.attemptJoin();
      });
      socket.on('disconnect', () => {
        if (this.desired && this.hadJoined) this.recoveryDeadline = Date.now() + 60000;
        this.generation++;
        this.joining = false;
        clearTimeout(this.joinTimer);
        this.uploadToken = '';
        for (const item of this.pending.values()) item.sending = false;
        this.setReady(false, this.desired ? '연결 끊김 · 재연결 중' : '연결 종료');
      });
      socket.on('connect_error', () => this.setReady(false, '서버 연결을 다시 시도 중'));
      socket.on('session:replaced', ({ message } = {}) => {
        this.stop();
        this.setReady(false, '다른 창에서 접속됨');
        options.onError({ message: message || '다른 창에서 입장했습니다. 이 창에서 다시 입장하려면 새로고침하세요.', code: 'REPLACED' });
      });
      socket.on('room:closed', ({ message } = {}) => {
        this.stop();
        this.hadJoined = false;
        this.recoveryDeadline = 0;
        this.setReady(false, '강의실 종료');
        options.onError({ code: 'ROOM_CLOSED', message: message || '관리자가 강의실을 삭제했습니다.' });
      });
      // Backgrounded mobile tabs can miss the automatic reconnect window.
      const reconnect = () => {
        if (this.desired && !socket.connected) socket.connect();
      };
      global.addEventListener('online', reconnect);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reconnect();
      });
    }

    isReady() { return this.socket.connected && this.socket.roomReady === true; }

    setReady(ready, label) {
      this.socket.roomReady = ready;
      const dot = document.getElementById('conn-dot');
      if (dot) {
        dot.classList.toggle('connected', ready);
        dot.title = label;
      }
      const status = document.getElementById('connection-status');
      if (status) status.textContent = label;
      const mobileStatus = document.getElementById('mobile-connection-status');
      if (mobileStatus) mobileStatus.textContent = label;
    }

    join(payload) {
      if (this.joining) return;
      // A user-initiated join starts a new context. Pending messages from a
      // previous room must never be replayed into another classroom.
      if (this.desired) this.stop();
      this.hadJoined = false;
      this.recoveryDeadline = 0;
      this.desired = payload;
      this.setReady(false, '강의실 입장 중');
      if (this.socket.connected) this.attemptJoin();
      else this.socket.connect();
    }

    async attemptJoin() {
      if (!this.desired || !this.socket.connected || this.joining) return;
      this.joining = true;
      const generation = this.generation;
      let tokenTimer;
      try {
        const payload = typeof this.desired === 'function'
          ? await Promise.race([
            this.desired(),
            new Promise((_, reject) => { tokenTimer = setTimeout(() => reject(new Error('인증 확인 시간이 초과되었습니다.')), 15000); })
          ])
          : this.desired;
        if (generation !== this.generation || !this.desired || !this.socket.connected) return;
        this.socket.timeout(15000).emit(this.options.joinEvent, { ...payload, sessionId: this.sessionId }, (error, result) => {
          if (generation !== this.generation || this.isReady() || !this.desired) return;
          this.joining = false;
          if (error || !result || result.code === 'AUTH_UNAVAILABLE') {
            this.scheduleJoin();
          } else if (!result.ok) {
            this.failJoin(result);
          }
        });
      } catch (error) {
        if (generation !== this.generation) return;
        this.joining = false;
        if (error.code === 'AUTH') this.failJoin(error);
        else this.scheduleJoin();
      } finally {
        clearTimeout(tokenTimer);
      }
    }

    scheduleJoin() {
      clearTimeout(this.joinTimer);
      this.setReady(false, '강의실 연결을 다시 시도 중');
      this.joinTimer = setTimeout(() => this.attemptJoin(), 3000);
    }

    failJoin(error) {
      if (!this.desired) return;
      this.joining = false;
      if (error.code === 'AUTH_UNAVAILABLE') {
        this.scheduleJoin();
        return;
      }
      if (['NOT_FOUND', 'ROOM_NOT_FOUND'].includes(error.code) && this.hadJoined && Date.now() < this.recoveryDeadline) {
        this.scheduleJoin();
        this.setReady(false, '강의실 복구 대기 중');
        return;
      }
      this.stop();
      this.setReady(false, '입장 확인 필요');
      this.options.onError(error);
    }

    acceptSnapshot(data) {
      clearTimeout(this.joinTimer);
      this.joining = false;
      this.participantId = data.participantId || '';
      this.uploadToken = data.uploadToken || '';
      this.hadJoined = true;
      this.recoveryDeadline = 0;
      this.setReady(true, '연결됨');
      for (const item of this.pending.values()) this.transmit(item);
    }

    uploadHeaders() {
      if (!this.isReady()) throw new Error('연결 복구 후 다시 시도하세요.');
      return { 'X-Socket-Id': this.socket.id, 'X-Upload-Token': this.uploadToken };
    }

    emit(event, payload) {
      if (!this.isReady()) {
        this.options.onNotice('연결을 복구하는 중입니다. 연결된 뒤 다시 시도하세요.');
        return false;
      }
      this.socket.emit(event, payload);
      return true;
    }

    send(event, payload, clientMessageId = randomId()) {
      if (!this.isReady()) return Promise.reject(new Error('연결 복구 후 다시 전송하세요. 입력 내용은 유지됩니다.'));
      if (this.pending.size >= 10) return Promise.reject(new Error('전송 중인 메시지가 많습니다. 잠시 후 다시 시도하세요.'));
      return new Promise((resolve, reject) => {
        const item = { event, payload: { ...payload, clientMessageId }, resolve, reject, attempts: 0, sending: false };
        item.deadline = setTimeout(() => this.finish(item, new Error('전송 확인을 받지 못했습니다. 다시 전송하면 중복 없이 확인합니다.')), 45000);
        this.pending.set(clientMessageId, item);
        this.transmit(item);
      });
    }

    transmit(item) {
      if (!this.isReady() || item.sending || !this.pending.has(item.payload.clientMessageId)) return;
      item.sending = true;
      item.attempts++;
      const generation = this.generation;
      this.socket.timeout(5000).emit(item.event, item.payload, (error, result) => {
        if (generation !== this.generation || !this.pending.has(item.payload.clientMessageId)) return;
        item.sending = false;
        if (error) {
          if (item.attempts < 3) this.transmit(item);
          else this.finish(item, new Error('전송 확인이 지연됩니다. 입력 내용을 유지했으니 다시 전송하세요.'));
        } else if (!result || !result.ok) {
          this.finish(item, new Error(result?.message || result?.error || '전송하지 못했습니다. 다시 시도하세요.'));
        } else {
          this.finish(item, null, result.message);
        }
      });
    }

    finish(item, error, message) {
      if (!this.pending.delete(item.payload.clientMessageId)) return;
      clearTimeout(item.deadline);
      if (error) item.reject(error);
      else item.resolve(message);
    }

    stop() {
      this.desired = null;
      this.uploadToken = '';
      this.generation++;
      clearTimeout(this.joinTimer);
      this.joining = false;
      this.setReady(false, '연결 종료');
      for (const item of this.pending.values()) this.finish(item, new Error('강의실 연결이 종료되었습니다.'));
    }

    leave() {
      if (this.isReady()) this.socket.emit('room:leave');
      this.stop();
      this.socket.disconnect();
    }
  }

  // Abort covers response-body reads too, so an upstream partial response cannot
  // leave an upload or AI send button disabled forever.
  async function requestJson(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (response.ok) throw new Error('서버 응답을 읽지 못했습니다. 잠시 후 다시 시도하세요.');
        data = {};
      }
      if (!response.ok) {
        const error = new Error(data.error || `요청에 실패했습니다 (${response.status}). 잠시 후 다시 시도하세요.`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('응답 시간이 초과되었습니다. 잠시 후 다시 시도하세요.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  global.EduTalkConnection = EduTalkConnection;
  global.eduRequestJson = requestJson;
})(window);
