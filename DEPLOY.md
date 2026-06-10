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

> `config/instructor_password.txt`(강사 비밀번호)도 함께 커밋됩니다.
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

- **강사 등록**: `/instructor.html` 에서 이름·이메일·비밀번호(최소 정보)로
  등록 신청 → 관리자 승인 후 로그인하여 강의실을 열 수 있습니다.
- **관리자 페이지**: `/admin.html` — 강사 등록 신청을 승인/거절/삭제합니다.
  관리자 비밀번호는 `config/admin_password.txt` 에서 변경합니다
  (파일이 없으면 `config/instructor_password.txt` 값을 대신 사용).
- **계정 저장 위치**: `data/instructors.json` (git에 포함되지 않음).
  ⚠ Render 무료 플랜은 디스크가 휘발성이라 **재배포/재시작 시 강사 계정이
  초기화**됩니다. 계정을 영구 보관하려면 Render Disk를 `data/` 에 마운트하거나
  외부 DB로 옮겨야 합니다.
- **세션 토큰**: 로그인 토큰은 서버 메모리에만 있으므로 서버가 재시작되면
  강사는 다시 로그인해야 합니다.
