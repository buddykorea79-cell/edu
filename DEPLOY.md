# EduTalk 배포 가이드 (Render)

EduTalk는 Socket.io 실시간 연결과 메모리 상태를 사용하므로 **상시 실행 서버**가 필요합니다.
Vercel(서버리스)에서는 동작하지 않으며, Render의 Web Service에 배포해야 합니다.

## 1단계: GitHub에 코드 올리기

```bash
cd edutalk-v3
git init
git add .
git commit -m "EduTalk v3"
git branch -M main
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git push -u origin main
```

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
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
4. **Create Web Service** 클릭

## 3단계: 접속

배포가 완료되면 `https://edutalk-xxxx.onrender.com` 형태의 주소가 발급됩니다.
- 강사: `https://<주소>/instructor.html`
- 교육생: `https://<주소>/student.html`

## 참고 사항

- **무료 플랜 슬립**: 15분간 요청이 없으면 서버가 잠들고, 다음 첫 접속 시
  깨어나는 데 약 50초가 걸립니다. 강의 시작 전 미리 한 번 접속해 두세요.
- **메모리 상태**: 방·메시지·설문은 메모리에 저장되므로 서버가 재시작되면
  초기화됩니다. 한 강의 세션 동안만 유지하면 되는 용도라 문제없습니다.
- **업로드 파일**: 업로드된 파일은 서버 재시작/재배포 시 사라집니다.
  영구 보관이 필요하면 Render Disk(유료) 또는 S3 같은 외부 저장소가 필요합니다.
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
  ```
- **세션**: 강사 인증은 Supabase JWT 라 서버가 재시작돼도 유지됩니다.
  관리자 페이지 세션 토큰만 서버 메모리에 있어 재시작 시 재로그인이 필요합니다.
