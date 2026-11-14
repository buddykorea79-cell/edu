# EduTalk 배포 가이드 (Render)

EduTalk는 Socket.IO 실시간 연결과 메모리 상태를 사용하는 **단일 Node.js 서버**입니다.
기존 Render Web Service에서 실행합니다. Node.js 22 이상이 필요합니다.

## 이번 안정화 변경과 검증

- 연결이 다시 열릴 때 강의실에 자동 재입장하고 최근 메시지·설문·투표·자료·화이트보드를 복원합니다.
- 학생은 비공개 세션 식별자를 탭에 보관합니다. 잠깐 끊긴 학생의 자리는 2분간 유지하며, 중복 입장과 같은 투표의 이중 집계를 방지합니다.
- 채팅은 서버 확인(ACK)을 받고 동일 메시지 ID로 재시도합니다. 전송 실패 시 입력을 유지하고 오류를 표시합니다.
- 화이트보드 입력은 40ms 단위로 묶고 렌더링을 나눠 처리합니다. 오프라인에서 그린 내용을 무더기로 재전송하지 않습니다.
- 잘못된 이벤트·비동기 인증 실패가 서버를 종료하지 않도록 검증하고, 업로드와 AI 요청에 인증·용량·동시 실행·시간 제한을 적용했습니다.
- 서버의 자정에 모든 방을 삭제하던 동작을 없앴습니다. 접속 중인 방은 유지하며, 아무도 없는 방만 마지막 활동 6시간 뒤 정리합니다.
- 관리자 승인 변경을 진행 중인 강사 연결에도 적용하고, 인증 서버의 일시 오류와 실제 인증 실패를 구분합니다.

개발 검증 명령:

```bash
npm ci
npm test
npm run test:load
npm audit
```

`test:load`는 **로컬 임시 서버**에 학생 30명(웹소켓 15명·폴링 15명)과 강사를 연결합니다.
240개 메시지의 7,440건 전달, 중복 여부, 10명 연결 중단·복구, 투표 복원 등을 확인합니다.
AI 테스트는 외부 유료 API 대신 모의 제공자를 사용하며, 30명 동시 요청과 취소·시간 초과를 검증합니다.
이 테스트는 Render 인스턴스 성능이나 실제 AI 제공자의 요금·제한을 측정하지 않습니다.

## 1단계: GitHub에 코드 올리기

```bash
cd edutalk
git add .
git commit -m "Fix classroom connection reliability and refresh interface"
git push origin main
```

> 위 명령은 실제 배포 시 실행하는 예시입니다. 수정만으로 GitHub push나 운영 배포가 실행되지는 않습니다.
> `node_modules/`, `uploads/`는 `.gitignore`로 제외됩니다.

## 2단계: Render에서 배포

### 방법 A — render.yaml 자동 인식 (권장)

1. https://render.com 가입 후 로그인
2. **New +** → **Blueprint** 클릭
3. GitHub 저장소 연결 → EduTalk 저장소 선택
4. 저장소에 포함된 `render.yaml`을 Render가 자동으로 읽어 설정
5. **Apply** 클릭 → 배포 시작

### 방법 B — 수동 설정

1. **New +** → **Web Service** 클릭
2. GitHub 저장소 연결 → EduTalk 저장소 선택
3. 설정값 입력:
   - **Runtime**: Node
   - **Build Command**: `npm ci --omit=dev`
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/api/ping`
   - **Node version**: `22`
   - **인스턴스 수**: `1`
   - **Plan**: 현재 플랜 확인. `render.yaml`의 Free 설정은 유지했으며 유료 플랜으로 자동 변경하지 않습니다.
4. **Create Web Service** 클릭

## 3단계: 접속

배포가 완료되면 `https://edutalk-xxxx.onrender.com` 형태의 주소가 발급됩니다.
- 강사: `https://<주소>/instructor.html`
- 교육생: `https://<주소>/student.html`

## 참고 사항

- **배포 시점**: 수업이 끝난 뒤 배포하세요. 서버와 브라우저 코드를 함께 배포한 후 강사·학생 모두 페이지를 새로고침해야 새 프로토콜이 적용됩니다.
- **실제 장애 원인 확인**: Render의 장애 시각 로그에서 재시작·메모리 부족·배포 여부, CPU/메모리와 지연을 확인해야 합니다. 코드 결함은 수정했지만 운영 로그 없이 모든 끊김을 특정 원인으로 단정할 수 없습니다.
- **진단 로그**: 60초마다 `server_health` JSON 로그를 출력합니다. 현재 연결 수, RSS/힙 메모리(MB), 이벤트 루프 지연 p99(ms), 재연결·종료 사유 누계를 확인할 수 있습니다. 사용자 이름·메시지·인증 토큰은 포함하지 않습니다.
- **무료 플랜 슬립**: 15분간 HTTP 요청이나 기존 WebSocket의 수신 메시지가 없으면 잠듭니다. 활성 채팅을 하는 중의 끊김을 이 설정만으로 설명할 수는 없습니다. 상시 수업에는 슬립 없는 유료 인스턴스를 검토하세요. [Render 무료 서비스 안내](https://render.com/docs/free)
- **서버 재시작의 한계**: 방·대화·투표·자료 목록·보드는 메모리 상태라 프로세스 재시작/배포 시 사라집니다. 자동 재접속은 네트워크 단절을 복구하며, 사라진 기록을 복원하지 않습니다. 강사가 같은 방을 다시 만들면 학생은 최대 60초 복구 대기 중 자동 재입장을 시도합니다. 영속 보관이 필요하면 별도의 DB 저장 설계가 필요합니다.
- **인스턴스 수**: 상태 공유가 없으므로 1개로 운영하세요. 여러 인스턴스로 확장하려면 공유 저장소·Socket.IO 어댑터·폴링 세션 고정까지 함께 구성해야 합니다.
- **업로드 파일**: 기본 저장소는 임시 디스크입니다. 재시작/재배포 때 사라질 수 있고, 24시간이 지난 파일은 정기 삭제합니다. 파일은 개당 20MB, 동시 4개, 전체 저장 공간 256MB 제한입니다. `UPLOAD_DIR`로 저장 경로를 지정할 수 있지만 방 상태는 별도로 영속화해야 합니다. [Render 저장소 안내](https://render.com/docs/disks)
- **AI 요청**: 사용자당 1개, 서버 전체 기본 32개(환경변수 `AI_MAX_CONCURRENT`, 1~64), 최대 60초입니다. API 제공자의 별도 제한은 그대로 적용됩니다. 초과·실패를 화면에 표시하고 입력을 보존합니다.
- **보관 한도**: 방 5개, 학생 50명/방, 최근 메시지 500개, 설문 100개, 자료 100개, 화이트보드 10,000항목·이미지 32개입니다. 가득 찬 보드는 강사/조교가 지워야 추가할 수 있습니다.
- **포트**: 서버는 `process.env.PORT`를 사용하므로 Render가 주입하는
  포트에 자동으로 맞춰집니다. 별도 설정 불필요.

## 강사 계정 / 관리자 페이지

- **강사 로그인**: `/instructor.html` 에서 **Google 계정으로 로그인**합니다.
  첫 로그인 시 자동으로 등록 신청(pending)되며, 관리자 승인 후 강의실을
  열 수 있습니다.
- **관리자 페이지**: `/admin.html` — 강사 등록 신청을 승인/거절/삭제합니다.
  관리자는 `ADMIN_EMAIL` 환경변수(기본값 `buddykorea79@gmail.com`)의 Google
  계정으로만 접근하며, 첫 로그인 시 자동 승인됩니다.
  관리자 계정은 관리자 페이지에서 삭제할 수 없습니다.
- **방 입장**: 학생은 6자리 방 코드만으로 입장합니다 (방 비밀번호 없음).
- **필요 환경변수**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_ANON_KEY`. Supabase 대시보드에서 Google OAuth Provider 활성화 및
  Redirect URL(`/instructor.html`, `/admin.html`) 등록이 필요합니다.

  프로필 테이블 생성 SQL (Supabase SQL Editor 에서 1회 실행):

  ```sql
  CREATE TABLE IF NOT EXISTS instructor_profiles (
    user_id     UUID    PRIMARY KEY,
    email       TEXT    UNIQUE NOT NULL,
    name        TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'pending',
    created_at  BIGINT  NOT NULL,
    approved_at BIGINT
  );
  -- 프로필 승인 변경은 서버의 service_role을 통해서만 허용합니다.
  ALTER TABLE instructor_profiles ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE instructor_profiles FROM anon, authenticated;
  ```
- 기존 프로젝트도 위 프로필 접근 제한을 확인하세요. 이 코드 변경은 Supabase SQL을 자동 실행하지 않습니다.
- **세션**: 강사 인증은 Supabase JWT이며 재접속 시 최신 토큰을 사용합니다.
  관리자 페이지 토큰은 8시간 또는 서버 재시작까지 유효합니다.
