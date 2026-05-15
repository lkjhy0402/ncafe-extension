# NCAFE Tracker (Chrome Extension)

네이버 카페 글 발행 / 통계 / 가입 상태를 NCAFE 웹앱(`https://ncafe-web.vercel.app`)에 자동 동기화하는 Chrome 확장.

## 기능

| 시나리오 | 트리거 | 전송 데이터 | 표시 |
|---------|--------|------------|------|
| 본인 글 발행/조회 (첫 발견) | 글 페이지 진입 | 제목·본문·URL·통계 | "NCAFE에 저장됨" |
| 본인 글 재방문 | 같은 글 다시 열기 | 댓글·조회·좋아요 갱신 | "통계 업데이트됨" |
| 카페 메인 접속 | 가입 상태 추론 | 미가입/신입/정회원/확인불가 | "가입 상태 확인됨" |

본인 닉네임으로 작성한 글만 추적 (다른 사람 글은 무시).

## 설치 (개발자 모드)

1. `https://ncafe-web.vercel.app/extension`에서 ZIP 다운로드
2. ZIP 압축 해제 (어떤 폴더든)
3. Chrome 주소창: `chrome://extensions/`
4. 우상단 **개발자 모드** 켜기
5. **압축해제된 확장 프로그램 로드** → 압축 푼 폴더 선택
6. 주소창 우측 🎯 아이콘 클릭 → 토큰·닉네임 입력

## 설정값

| 키 | 형식 | 설명 |
|----|------|------|
| `ncafeToken` | 16진수 64자 | NCAFE `/extension` 페이지에서 발급 |
| `myNickname` | 텍스트 | 본인 카페 닉네임 (정확히 일치해야 추적) |

저장 위치: `chrome.storage.local` (PC별, Chrome 프로필별)

## 다중 PC 사용

영구 토큰 + 같은 닉네임으로 여러 PC에서 사용 가능:
- 각 PC에 확장 설치
- 같은 토큰 입력 → 같은 NCAFE 계정으로 자동 동기화
- 각 PC가 작성한 글이 NCAFE 한 곳에 모임

## 디렉토리 구조

```
ncafe-extension/
├── manifest.json                # Manifest V3
├── popup/
│   ├── popup.html               # 토큰·닉네임 UI
│   └── popup.js                 # storage 저장/검증
├── background/
│   └── service-worker.js        # API 호출 + 메시지 라우팅
├── content/
│   ├── post-page.js             # 글 페이지 추출
│   └── cafe-main.js             # 가입 상태 추론
├── lib/
│   └── toast.js                 # 우상단 토스트 (공유)
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

## 권한 (manifest.json)

| 권한 | 사유 |
|------|------|
| `storage` | 토큰·닉네임 저장 |
| `activeTab` | 현재 탭에서만 작동 |
| `host_permissions: cafe.naver.com/*` | 카페 페이지 DOM 접근 |
| `host_permissions: ncafe-web.vercel.app/*` | API 호출 |

권한 외엔 페이지를 건드리지 않음 (다른 사이트 X, 백그라운드 자동 X).

## API 엔드포인트

확장은 다음 두 엔드포인트만 호출:

- `GET /api/track/test` — 토큰 유효성 검증 (popup의 "연결 테스트")
- `POST /api/track` — 추적 데이터 전송
  - body: `{ "type": "post_published" | "post_stats" | "cafe_membership", "payload": {...} }`
  - header: `Authorization: Bearer <token>`

## 보안

- HTTPS만 사용 (cafe.naver.com, ncafe-web.vercel.app)
- 토큰은 chrome.storage.local에만 저장 (외부 서버 X, 클라우드 동기화 X)
- 다른 사람 글은 닉네임 필터로 차단
- 백그라운드 자동 실행 없음 (사용자가 카페 페이지 방문 시에만 작동)

## 빌드

ncafe-web 루트에서:

```bash
node scripts/build-extension.mjs
# → public/ncafe-extension.zip 생성
```

또는 `pnpm build:extension`.

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 토스트 안 뜸 | 닉네임 불일치 | popup에서 닉네임을 카페 닉네임과 동일하게 |
| "토큰이 설정되지 않음" | popup에서 저장 안 함 | popup → 토큰 입력 → 저장 |
| "유효하지 않은 토큰" | 토큰 만료 또는 오타 | `/extension` 페이지에서 재발급 |
| "카페를 찾을 수 없음" | NCAFE에 카페 미등록 | NCAFE `/cafes`에서 카페 추가 후 재시도 |
| DOM 셀렉터 fail | 네이버 카페 구조 변경 | content script의 `SELECTORS` 업데이트 (defensive coding으로 silent skip) |

## 버전

| 버전 | 변경 |
|------|------|
| 1.0.0 | 초기 출시 (post_published / post_stats / cafe_membership) |
