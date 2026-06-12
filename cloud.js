'use strict';

/*
 * 클라우드 동기화 (Firebase Firestore) — 선택적 기능.
 *
 * 중요: 로컬 전용 모드에서는 이 파일의 어떤 코드도 네트워크를 타지 않습니다.
 * Firebase SDK는 Cloud.start()가 호출될 때(=사용자가 클라우드를 켤 때)만
 * CDN에서 동적으로 로드됩니다. 그래서 클라우드를 안 쓰는 사용자는
 * Firebase를 전혀 내려받지 않습니다.
 *
 * 데이터 구조: Firestore 문서  syncs/{동기화코드} = { meds, log, updatedAt }
 * 인증: 익명 로그인(Anonymous Auth). 동기화 코드가 기기 간 공유의 비밀키 역할.
 */
window.Cloud = (() => {
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.0';

  let fb = null;        // { authM, fsM, app, auth, db }
  let docRef = null;
  let unsub = null;     // onSnapshot 해제 함수
  let cbs = {};
  let status = 'local'; // 'local' | 'connecting' | 'synced' | 'error'

  function setStatus(s, detail) {
    status = s;
    if (cbs.onStatus) cbs.onStatus(s, detail);
  }

  async function loadSdk() {
    const [appM, authM, fsM] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    return { appM, authM, fsM };
  }

  // config + code로 연결하고 실시간 구독을 시작한다.
  // 반환: { ok, existed?, data?, error? }
  async function start(config, code, callbacks) {
    cbs = callbacks || {};
    setStatus('connecting');
    try {
      const { appM, authM, fsM } = await loadSdk();
      const app = appM.initializeApp(config, 'pill-tracker-' + Date.now());
      const auth = authM.getAuth(app);
      const db = fsM.getFirestore(app);

      await authM.signInAnonymously(auth);

      fb = { authM, fsM, app, auth, db };
      docRef = fsM.doc(db, 'syncs', code);

      // 최초 연결 시 클라우드에 기존 데이터가 있는지 확인
      const snap = await fsM.getDoc(docRef);
      const existed = snap.exists();

      // 실시간 구독: 다른 기기에서 바뀌면 자동 반영
      unsub = fsM.onSnapshot(
        docRef,
        (s) => {
          if (s.metadata.hasPendingWrites) return; // 내 쓰기의 echo는 무시
          if (s.exists() && cbs.onRemote) cbs.onRemote(s.data());
        },
        (err) => setStatus('error', err && err.message)
      );

      setStatus('synced');
      return { ok: true, existed, data: existed ? snap.data() : null };
    } catch (e) {
      setStatus('error', e && e.message);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // 현재 상태를 클라우드에 저장
  async function push(state) {
    if (!fb || !docRef) return;
    try {
      await fb.fsM.setDoc(docRef, {
        meds: state.meds,
        log: state.log,
        updatedAt: Date.now(),
      });
      setStatus('synced');
    } catch (e) {
      setStatus('error', e && e.message);
    }
  }

  // 동기화 중단 (로컬 데이터는 그대로 유지)
  function stop() {
    if (unsub) { unsub(); unsub = null; }
    docRef = null;
    fb = null;
    setStatus('local');
  }

  // 32자리 랜덤 동기화 코드 생성 (기기 간 공유용 비밀키)
  function randomCode() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    get status() { return status; },
    start,
    push,
    stop,
    randomCode,
  };
})();
