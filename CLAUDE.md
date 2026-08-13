# CLAUDE.md

이 파일은 Claude Code가 이 저장소에서 작업할 때 참고하는 지침입니다.
사용자 기능 설명·Firebase 설정 절차는 [README.md](README.md)에 있으니 중복 기술하지 않습니다.

## 프로젝트 개요

개인용 복약 기록·재고 관리 PWA. 아이폰 홈 화면에 설치해 쓰는 것이 주 사용 형태입니다.

- **배포:** GitHub Pages — https://leejedi-lab.github.io/pill-tracker/ (`main` 브랜치 push = 배포)
- **저장소:** github.com/leejedi-lab/pill-tracker (public)
- **개발 환경:** Windows PC. 네이티브 iOS 빌드 불가 → PWA를 선택한 배경입니다.

## 빌드 시스템 없음

번들러·패키지 매니저·프레임워크가 없습니다. 순수 HTML/CSS/JS를 브라우저가 그대로 실행합니다.
`npm install`·빌드 단계를 도입하지 마세요. 로컬 확인은 `npx serve .` 또는 `index.html` 직접 열기(서비스 워커만 비활성).

## 아키텍처

| 파일 | 역할 |
|---|---|
| `index.html` | 정적 뼈대. `<main id="view">` 한 곳에 모든 화면을 그려 넣습니다. 탭바·`#modal-root`·숨김 파일 input만 고정 |
| `app.js` | 앱 로직 전체(약 1,000줄). 상수 → 상태 → 유틸 → 렌더 → 모달 → 이벤트 위임 순으로 섹션 주석(`/* ── ── */`)이 구분되어 있습니다 |
| `cloud.js` | 선택적 Firebase 동기화 모듈. `window.Cloud` 하나만 노출 |
| `sw.js` | 서비스 워커. 네트워크 우선 + 캐시 폴백 |
| `style.css` | 모바일 우선 CSS |

### 데이터 모델

```js
state = {
  meds: [{ id, name, dose, unit, slots: [], stock, lowDays, created }],
  log:  { 'YYYY-MM-DD': { 'medId|slotId': timestamp } }
}
```

저장 위치 — localStorage 3개 키가 전부입니다.

- `pill-tracker-v1` (`STORE_KEY`) — 위 `state`
- `pill-tracker-sync` (`SYNC_KEY`) — `{ mode: 'local'|'cloud', config, code }`
- `pill-tracker-ui` (`UI_KEY`, **sessionStorage**) — 보던 탭과 입력 중이던 모달 초안. iOS가 앱 전환 후 웹앱을 다시 로드해도 입력이 날아가지 않게 하는 장치입니다

### 렌더링·이벤트 패턴

- 상태가 바뀌면 `render()`가 현재 탭 전체를 문자열 HTML로 다시 그립니다. 가상 DOM·부분 갱신 없음. 새 UI를 붙일 때도 이 방식을 따르세요.
- 사용자 입력은 `document`에 건 **단일 클릭 위임**(`app.js:853~`)에서 `data-action` 속성으로 분기합니다. 개별 요소에 `addEventListener`를 달지 마세요 — 다시 그리는 순간 사라집니다.
- 사용자 입력값을 HTML에 넣을 때는 반드시 `esc()`를 거칩니다.

### 클라우드 동기화 계약

- 로컬 전용 모드에서는 Firebase 코드가 **네트워크를 전혀 타지 않습니다.** SDK는 `Cloud.start()` 시점에 CDN에서 동적 import 됩니다. 이 지연 로딩을 깨지 마세요.
- Firestore 구조: `syncs/{32자리 동기화 코드}` 단일 문서. 익명 로그인 사용.
- **단일 문서 접근(getDoc/onSnapshot/setDoc)만 사용합니다.** 컬렉션 조회(list)를 도입하면 보안 모델이 무너집니다 — 동기화 코드가 비밀키 역할을 하는 근거가 "코드를 모르면 문서를 나열조차 못 한다"는 규칙이기 때문입니다.
- `saveState()`는 400ms 디바운스로 push하고, 원격 반영 중에는 `applyingRemote` 플래그로 되쏘기를 막습니다. 이 루프를 건드릴 때 주의하세요.

## 배포 시 반드시 지킬 것

코드를 고치고 push하기 전에 **세 값을 함께 올립니다.** 하나라도 빠지면 이미 설치한 아이폰에 새 버전이 반영되지 않습니다.

1. `sw.js` — `CACHE_VERSION` (현재 `pill-tracker-v6`)
2. `app.js` — `APP_VERSION` (현재 `1.1.0`)
3. `app.js` — `BUILD_DATE` (현재 `2026-06-22`)

버전은 앱 모든 화면 하단에 표시되므로, 기기에서 반영 여부를 눈으로 확인할 수 있습니다.

`sw.js`의 `SHELL` 배열에 캐시할 파일 목록이 있습니다. **새 파일을 추가하면 이 배열에도 넣어야** 오프라인에서 동작합니다.

## 커밋 규약

- 브랜치는 `main` 하나. push 즉시 배포됩니다.
- 커밋 author는 저장소 로컬 설정으로 `leejedi-lab <leejedi-lab@users.noreply.github.com>` 고정 — 공개 저장소에 실제 이메일이 노출되지 않도록 한 조치입니다. 전역 git 설정으로 덮어쓰지 마세요.

## 알아둘 결정 사항

- **푸시 알림을 구현하지 않습니다.** iOS 웹앱 푸시 대신 아이폰 단축어 자동화(특정 시간 → **"앱 열기"** 동작)로 처리하기로 했습니다. 단축어에서 "URL 열기"는 Safari 탭으로 열려 localStorage가 분리되므로 쓰면 안 됩니다.
- **Firebase 연결은 아직 실사용 검증 전입니다.** 사용자가 본인 Firebase 프로젝트를 생성하지 않아 클라우드 경로는 코드상 완성 상태로만 있습니다. 이 영역을 수정하면 실기기 검증이 안 된다는 점을 전제하세요.
