'use strict';

/* ── 상수 ─────────────────────────── */
const SLOTS = [
  { id: 'morning', label: '아침', icon: '🌅' },
  { id: 'noon',    label: '점심', icon: '☀️' },
  { id: 'evening', label: '저녁', icon: '🌆' },
  { id: 'night',   label: '취침 전', icon: '🌙' },
];
const UNITS = ['정', '캡슐', '포', 'ml'];
const STORE_KEY = 'pill-tracker-v1';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/* ── 상태 ─────────────────────────── */
// state.meds: [{ id, name, dose, unit, slots:[], stock, lowDays, created }]
// state.log:  { 'YYYY-MM-DD': { 'medId|slotId': timestamp } }
let state = loadState();

/* UI 상태(보던 탭, 입력 중이던 모달)를 sessionStorage에 보존.
   페이지가 새로고침돼도 — iOS가 앱 전환 후 웹앱을 다시 로드하는 경우 포함 —
   입력하던 내용이 사라지지 않도록 한다. */
const UI_KEY = 'pill-tracker-ui';
function loadUi() {
  try { return JSON.parse(sessionStorage.getItem(UI_KEY)) || {}; } catch (e) { return {}; }
}
let ui = loadUi();
function saveUi() {
  sessionStorage.setItem(UI_KEY, JSON.stringify(ui));
}

let currentTab = ui.tab || 'today';
let calCursor = startOfMonth(new Date());
let selectedDate = dateKey(new Date());

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 손상된 데이터는 초기화 */ }
  return { meds: [], log: {} };
}

/* ── 동기화 설정 ───────────────────────
   sync = { mode: 'local'|'cloud', config: {firebaseConfig}, code: '동기화코드' }
   로컬 전용이 기본값. 클라우드는 사용자가 명시적으로 켤 때만 동작한다. */
const SYNC_KEY = 'pill-tracker-sync';
let sync = loadSync();
let syncStatus = 'local';     // Cloud 모듈이 알려주는 현재 상태
let applyingRemote = false;   // 원격 데이터 적용 중에는 다시 push하지 않도록
let pushTimer = null;

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || { mode: 'local' }; }
  catch (e) { return { mode: 'local' }; }
}
function saveSync() {
  localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
}

function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  // 클라우드 모드면 변경분을 잠시 모았다가 한 번에 올린다 (디바운스)
  if (sync.mode === 'cloud' && !applyingRemote && window.Cloud && Cloud.status !== 'local') {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => Cloud.push(state), 400);
  }
}

/* 다른 기기(또는 클라우드)에서 받은 데이터를 로컬에 반영 */
function applyRemote(data) {
  if (!data || !Array.isArray(data.meds)) return;
  applyingRemote = true;
  state = { meds: data.meds, log: data.log || {} };
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  applyingRemote = false;
  render();
}

/* Cloud 모듈 상태 변화 → 화면 갱신 */
function onCloudStatus(s) {
  syncStatus = s;
  if (currentTab === 'meds') render();
}

/* 앱 시작 시 이미 클라우드로 설정돼 있으면 자동 연결 */
async function resumeCloud() {
  if (sync.mode !== 'cloud' || !sync.config || !sync.code || !window.Cloud) return;
  const res = await Cloud.start(sync.config, sync.code, {
    onStatus: onCloudStatus,
    onRemote: applyRemote,
  });
  if (!res.ok) {
    onCloudStatus('error');
    return;
  }
  // 클라우드에 데이터가 있으면 그것을 받고, 없으면 이 기기 데이터를 올림
  if (res.existed && res.data) applyRemote(res.data);
  else Cloud.push(state);
}

/* ── 유틸 ─────────────────────────── */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function shiftDate(baseKey, n) {
  const [y, m, d] = baseKey.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + n));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function slotLabel(id) {
  const s = SLOTS.find(s => s.id === id);
  return s ? s.label : id;
}
function dailyUse(med) {
  return med.dose * med.slots.length;
}
function daysLeft(med) {
  const use = dailyUse(med);
  if (use <= 0) return Infinity;
  return Math.floor(med.stock / use);
}
function isLow(med) {
  return daysLeft(med) <= (med.lowDays ?? 3);
}

/* 약의 현재 상태: 'active'(복용 중) | 'paused'(수동 비활성) | 'ended'(기간 만료) */
function medStatus(med) {
  if (med.active === false) return 'paused';
  if (med.endDate && dateKey(new Date()) > med.endDate) return 'ended';
  return 'active';
}

/* 특정 날짜(dk)에 이 약이 복용 대상인지 — 오늘 목록·기록·달력 계산에 사용.
   - 등록일 이전이거나 종료일 이후면 대상 아님
   - 오늘/미래 날짜는 수동 비활성(active=false)이면 제외 (과거 기록은 그대로 유지) */
function isExpectedOn(med, dk) {
  if (!med.slots || med.slots.length === 0) return false;
  if ((med.created || '0000-00-00') > dk) return false;
  if (med.endDate && dk > med.endDate) return false;
  if (dk >= dateKey(new Date()) && med.active === false) return false;
  return true;
}
function fmtDateKo(dk) {
  const [y, m, d] = dk.split('-').map(Number);
  const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${wd})`;
}

/* ── 복용 체크 토글 ────────────────── */
function toggleDose(medId, slotId) {
  const med = state.meds.find(m => m.id === medId);
  if (!med) return;
  const tk = dateKey(new Date());
  if (!state.log[tk]) state.log[tk] = {};
  const k = `${medId}|${slotId}`;
  if (state.log[tk][k]) {
    delete state.log[tk][k];
    med.stock += med.dose;            // 체크 해제 → 재고 복구
  } else {
    state.log[tk][k] = Date.now();
    med.stock = Math.max(0, med.stock - med.dose);  // 체크 → 재고 차감
  }
  saveState();
  render();
}

/* ── 날짜별 복용 현황 ──────────────── */
function dayStatus(dk) {
  const todayK = dateKey(new Date());
  const meds = state.meds.filter(m => isExpectedOn(m, dk));
  let expected = 0, taken = 0;
  const dayLog = state.log[dk] || {};
  for (const m of meds) {
    for (const s of m.slots) {
      expected++;
      if (dayLog[`${m.id}|${s}`]) taken++;
    }
  }
  if (expected === 0) return 'none';
  if (dk > todayK) return 'future';
  if (taken === expected) return 'full';
  if (taken > 0) return 'partial';
  if (dk === todayK) return 'pending';
  return 'missed';
}

/* ── 렌더링: 공통 ──────────────────── */
const view = document.getElementById('view');
const headerTitle = document.getElementById('header-title');
const headerSub = document.getElementById('header-sub');

function render() {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === currentTab));
  if (currentTab === 'today') renderToday();
  else if (currentTab === 'meds') renderMeds();
  else renderHistory();
}

/* ── 렌더링: 오늘 탭 ───────────────── */
function renderToday() {
  const now = new Date();
  headerTitle.textContent = '오늘의 복약';
  headerSub.textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 (${WEEKDAYS[now.getDay()]})`;

  if (state.meds.length === 0) {
    view.innerHTML = `
      <div class="empty-state">
        <span class="emoji">💊</span>
        아직 등록된 약이 없습니다.<br>
        <b>내 약</b> 탭에서 복용 중인 약을 추가해 주세요.
      </div>`;
    return;
  }

  const tk = dateKey(now);
  const dayLog = state.log[tk] || {};

  // 오늘 복용 대상(활성 + 기간 내) 약만 집계
  const todayMeds = state.meds.filter(m => isExpectedOn(m, tk));
  if (todayMeds.length === 0) {
    view.innerHTML = `
      <div class="empty-state">
        <span class="emoji">🌙</span>
        오늘 복용 예정인 약이 없어요.<br>
        <b>내 약</b> 탭에서 약을 추가하거나 활성화해 주세요.
      </div>`;
    return;
  }

  let expected = 0, taken = 0;
  for (const m of todayMeds) {
    for (const s of m.slots) {
      expected++;
      if (dayLog[`${m.id}|${s}`]) taken++;
    }
  }
  const pct = expected ? Math.round((taken / expected) * 100) : 0;

  // 재고 부족 경고 배너 (복용 중인 약만)
  const lowMeds = todayMeds.filter(isLow);
  const banner = lowMeds.length
    ? `<div class="alert-banner warn">⚠️ <b>약이 얼마 남지 않았어요:</b> ${
        lowMeds.map(m => `${esc(m.name)} (${daysLeft(m)}일치)`).join(', ')
      }</div>`
    : '';

  // 시간대별 복용 카드
  let slotsHtml = '';
  for (const slot of SLOTS) {
    const meds = todayMeds.filter(m => m.slots.includes(slot.id));
    if (meds.length === 0) continue;
    slotsHtml += `<div class="slot-title">${slot.icon} ${slot.label}</div>`;
    for (const m of meds) {
      const done = !!dayLog[`${m.id}|${slot.id}`];
      const low = isLow(m);
      slotsHtml += `
        <button class="dose-card${done ? ' taken' : ''}" data-action="toggle"
                data-med="${m.id}" data-slot="${slot.id}">
          <span class="dose-check">✓</span>
          <span class="dose-info">
            <div class="dose-name">${esc(m.name)}</div>
            <div class="dose-meta">${m.dose}${esc(m.unit)} ·
              <span class="${low ? 'low' : ''}">남은 약 ${m.stock}${esc(m.unit)}</span>
            </div>
          </span>
        </button>`;
    }
  }

  view.innerHTML = `
    ${banner}
    <div class="card progress-card">
      <div class="progress-label">
        <span class="big">${
          taken === expected ? '오늘 복약 완료! 🎉' : '오늘의 진행 상황'
        }</span>
        <span class="count">${taken} / ${expected} 복용</span>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    ${slotsHtml}`;
}

/* ── 렌더링: 내 약 탭 ──────────────── */
function renderMeds() {
  headerTitle.textContent = '내 약';
  headerSub.textContent = `${state.meds.length}개 등록됨`;

  let html = '';
  for (const m of state.meds) {
    const left = daysLeft(m);
    const low = isLow(m);
    const status = medStatus(m);

    // 상태 칩
    const statusChip =
      status === 'paused' ? `<span class="chip chip-paused">비활성</span>` :
      status === 'ended'  ? `<span class="chip chip-ended">기간 만료</span>` : '';
    // 복용 기간 칩
    const periodChip = m.endDate
      ? `<span class="chip">~${m.endDate.slice(5).replace('-', '/')}까지</span>` : '';

    // 상태별 액션 버튼
    let actions = '';
    if (status === 'active') {
      actions = `
        <button class="btn-sm" data-action="refill" data-med="${m.id}">재고 추가</button>
        <button class="btn-sm" data-action="edit" data-med="${m.id}">수정</button>
        <button class="btn-sm" data-action="set-active" data-med="${m.id}" data-val="0">비활성화</button>
        <button class="btn-sm danger" data-action="delete" data-med="${m.id}">삭제</button>`;
    } else if (status === 'paused') {
      actions = `
        <button class="btn-sm" data-action="edit" data-med="${m.id}">수정</button>
        <button class="btn-sm activate" data-action="set-active" data-med="${m.id}" data-val="1">활성화</button>
        <button class="btn-sm danger" data-action="delete" data-med="${m.id}">삭제</button>`;
    } else { // ended
      actions = `
        <button class="btn-sm" data-action="edit" data-med="${m.id}">수정</button>
        <button class="btn-sm activate" data-action="restart-med" data-med="${m.id}">다시 시작</button>
        <button class="btn-sm danger" data-action="delete" data-med="${m.id}">삭제</button>`;
    }

    html += `
      <div class="card med-card${status !== 'active' ? ' inactive' : ''}">
        <div class="med-top">
          <div>
            <div class="med-name">${esc(m.name)} ${statusChip}</div>
            <div class="med-chips">
              ${m.slots.map(s => `<span class="chip primary">${slotLabel(s)}</span>`).join('')}
              <span class="chip">1회 ${m.dose}${esc(m.unit)}</span>
              ${periodChip}
            </div>
          </div>
        </div>
        <div class="stock-row">
          <div class="stock-num ${low && status === 'active' ? 'low' : ''}">
            ${m.stock}${esc(m.unit)} 남음
            <small>(약 ${left === Infinity ? '-' : left + '일치'})</small>
          </div>
        </div>
        <div class="med-actions">${actions}</div>
      </div>`;
  }

  if (state.meds.length === 0) {
    html = `
      <div class="empty-state">
        <span class="emoji">💊</span>
        복용 중인 약을 등록해 보세요.
      </div>`;
  }

  view.innerHTML = html
    + `<button class="btn-primary" data-action="add">＋ 약 추가</button>`
    + syncCardHtml()
    + `<div class="card backup-card">
         <div class="backup-title">데이터 백업</div>
         <div class="backup-desc">
           복약 기록은 이 기기에만 저장됩니다. 가끔 백업 파일을 만들어
           <b>iCloud Drive(파일 앱)</b>에 저장해 두면, 기기를 바꾸거나
           실수로 데이터가 지워져도 안전하게 복원할 수 있어요.
         </div>
         <div class="backup-btns">
           <button class="btn-sm" data-action="export-data">⬆️ 백업 내보내기</button>
           <button class="btn-sm" data-action="import-data">⬇️ 백업 가져오기</button>
         </div>
       </div>`;
}

/* ── 렌더링: 기록 탭 ───────────────── */
function renderHistory() {
  headerTitle.textContent = '복약 기록';
  headerSub.textContent = '';

  const y = calCursor.getFullYear();
  const mo = calCursor.getMonth();
  const firstWd = new Date(y, mo, 1).getDay();
  const lastDay = new Date(y, mo + 1, 0).getDate();
  const todayK = dateKey(new Date());

  let cells = WEEKDAYS.map(w => `<div class="cal-wd">${w}</div>`).join('');
  for (let i = 0; i < firstWd; i++) cells += `<div class="cal-day out"></div>`;
  for (let d = 1; d <= lastDay; d++) {
    const dk = dateKey(new Date(y, mo, d));
    const st = dayStatus(dk);
    const dot = (st === 'full' || st === 'partial' || st === 'missed')
      ? `<span class="cal-dot ${st}"></span>` : `<span class="cal-dot"></span>`;
    cells += `
      <button class="cal-day${dk === selectedDate ? ' selected' : ''}${dk === todayK ? ' today-mark' : ''}"
              data-action="pick-day" data-date="${dk}">
        ${d}${dot}
      </button>`;
  }

  // 선택한 날짜 상세
  const selMeds = state.meds.filter(m => isExpectedOn(m, selectedDate));
  const selLog = state.log[selectedDate] || {};
  let detail = '';
  if (selMeds.length === 0) {
    detail = `<div class="empty-state" style="padding:24px">이 날짜의 기록이 없습니다.</div>`;
  } else {
    for (const m of selMeds) {
      for (const s of m.slots) {
        const took = !!selLog[`${m.id}|${s}`];
        const future = selectedDate > todayK;
        detail += `
          <div class="detail-row">
            <span>${esc(m.name)} <small style="color:var(--text-sub)">· ${slotLabel(s)}</small></span>
            <span class="detail-status ${future ? 'na' : took ? 'ok' : 'no'}">
              ${future ? '예정' : took ? '복용함 ✓' : '안 먹음'}
            </span>
          </div>`;
      }
    }
  }

  view.innerHTML = `
    <div class="cal-nav">
      <button data-action="cal-prev">‹</button>
      <h2>${y}년 ${mo + 1}월</h2>
      <button data-action="cal-next">›</button>
    </div>
    <div class="card">
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">
        <span><span class="cal-dot full"></span>모두 복용</span>
        <span><span class="cal-dot partial"></span>일부 복용</span>
        <span><span class="cal-dot missed"></span>안 먹음</span>
      </div>
    </div>
    <div class="card day-detail">
      <h3>${fmtDateKo(selectedDate)}</h3>
      ${detail}
    </div>`;
}

/* ── 모달: 약 추가/수정 ─────────────── */
const modalRoot = document.getElementById('modal-root');

function openMedForm(med, draft) {
  const isEdit = !!med;
  const m = draft || med || { name: '', dose: 1, unit: '정', slots: ['morning'], stock: 30, lowDays: 3 };

  ui.modal = { kind: 'med', medId: isEdit ? med.id : null, draft: { ...m } };
  saveUi();

  modalRoot.innerHTML = `
    <div class="modal-overlay" data-action="modal-dismiss">
      <div class="modal-sheet">
        <h2>${isEdit ? '약 정보 수정' : '새 약 추가'}</h2>
        <div class="field">
          <label>약 이름</label>
          <input type="text" id="f-name" value="${esc(m.name)}" placeholder="예: 혈압약, 오메가3">
        </div>
        <div class="field">
          <label>복용 시간 (해당하는 시간 모두 선택)</label>
          <div class="slot-picker">
            ${SLOTS.map(s => `
              <button type="button" class="slot-opt${m.slots.includes(s.id) ? ' on' : ''}"
                      data-action="slot-toggle" data-slot="${s.id}">${s.icon} ${s.label}</button>
            `).join('')}
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>1회 복용량</label>
            <input type="number" id="f-dose" value="${m.dose}" min="1" inputmode="numeric">
          </div>
          <div class="field">
            <label>단위</label>
            <select id="f-unit">
              ${UNITS.map(u => `<option value="${u}"${u === m.unit ? ' selected' : ''}>${u}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>현재 보유 수량</label>
            <input type="number" id="f-stock" value="${m.stock}" min="0" inputmode="numeric">
          </div>
          <div class="field">
            <label>며칠치 남으면 경고?</label>
            <input type="number" id="f-lowdays" value="${m.lowDays ?? 3}" min="1" inputmode="numeric">
          </div>
        </div>
        <div class="field">
          <label>복용 기간</label>
          <div class="slot-picker">
            <button type="button" class="slot-opt period-opt${m.endDate ? '' : ' on'}"
                    data-action="period-mode" data-mode="ongoing">계속 복용</button>
            <button type="button" class="slot-opt period-opt${m.endDate ? ' on' : ''}"
                    data-action="period-mode" data-mode="fixed">기간 지정</button>
          </div>
          <div id="period-detail" style="margin-top:10px;${m.endDate ? '' : 'display:none'}">
            <div class="period-chips">
              ${[3, 5, 7, 14, 30].map(n =>
                `<button type="button" class="chip-btn" data-action="period-days" data-days="${n}">${n}일</button>`
              ).join('')}
            </div>
            <label style="display:block;font-size:0.85rem;font-weight:700;color:var(--text-sub);margin:10px 0 6px">복용 종료일 (이 날까지 복용)</label>
            <input type="date" id="f-enddate" value="${m.endDate || ''}">
          </div>
        </div>
        <div class="modal-btns">
          <button class="btn-cancel" data-action="modal-close">취소</button>
          <button class="btn-save" data-action="med-save" data-med="${isEdit ? med.id : ''}">저장</button>
        </div>
      </div>
    </div>`;
}

function openRefillModal(med) {
  ui.modal = { kind: 'refill', medId: med.id };
  saveUi();
  modalRoot.innerHTML = `
    <div class="modal-overlay" data-action="modal-dismiss">
      <div class="modal-sheet">
        <h2>재고 추가 — ${esc(med.name)}</h2>
        <div class="field">
          <label>추가할 수량 (현재 ${med.stock}${esc(med.unit)})</label>
          <input type="number" id="f-refill" value="30" min="1" inputmode="numeric">
        </div>
        <div class="modal-btns">
          <button class="btn-cancel" data-action="modal-close">취소</button>
          <button class="btn-save" data-action="refill-save" data-med="${med.id}">추가</button>
        </div>
      </div>
    </div>`;
}

function closeModal() {
  modalRoot.innerHTML = '';
  ui.modal = null;
  saveUi();
}

/* 입력 중인 모달 내용을 UI 상태에 저장 (새로고침 대비) */
function captureMedDraft() {
  if (!ui.modal || ui.modal.kind !== 'med') return;
  const get = id => document.getElementById(id);
  if (!get('f-name')) return;
  const fixed = modalRoot.querySelector('.period-opt.on[data-mode="fixed"]');
  const endInput = get('f-enddate');
  ui.modal.draft = {
    name: get('f-name').value,
    dose: parseInt(get('f-dose').value, 10) || 1,
    unit: get('f-unit').value,
    stock: parseInt(get('f-stock').value, 10) || 0,
    lowDays: parseInt(get('f-lowdays').value, 10) || 3,
    slots: [...modalRoot.querySelectorAll('.slot-opt.on:not(.period-opt)')].map(b => b.dataset.slot),
    endDate: (fixed && endInput && endInput.value) ? endInput.value : null,
  };
  saveUi();
}

function saveMedForm(medId) {
  const name = document.getElementById('f-name').value.trim();
  const dose = Math.max(1, parseInt(document.getElementById('f-dose').value, 10) || 1);
  const unit = document.getElementById('f-unit').value;
  const stock = Math.max(0, parseInt(document.getElementById('f-stock').value, 10) || 0);
  const lowDays = Math.max(1, parseInt(document.getElementById('f-lowdays').value, 10) || 3);
  const slots = [...modalRoot.querySelectorAll('.slot-opt.on:not(.period-opt)')].map(b => b.dataset.slot);
  const fixed = modalRoot.querySelector('.period-opt.on[data-mode="fixed"]');
  const endInput = document.getElementById('f-enddate');
  const endDate = (fixed && endInput && endInput.value) ? endInput.value : null;

  if (!name) { document.getElementById('f-name').focus(); return; }
  if (slots.length === 0) return;

  if (medId) {
    const med = state.meds.find(m => m.id === medId);
    Object.assign(med, { name, dose, unit, stock, lowDays, slots, endDate });
  } else {
    state.meds.push({
      id: uid(), name, dose, unit, stock, lowDays, slots, endDate,
      active: true,
      created: dateKey(new Date()),
    });
  }
  saveState();
  closeModal();
  render();
}

/* ── 삭제 (두 번 탭 확인) ───────────── */
let deleteArm = null; // { medId, timer }

function handleDelete(medId, btn) {
  if (deleteArm && deleteArm.medId === medId) {
    clearTimeout(deleteArm.timer);
    deleteArm = null;
    state.meds = state.meds.filter(m => m.id !== medId);
    saveState();
    render();
    return;
  }
  if (deleteArm) clearTimeout(deleteArm.timer);
  btn.textContent = '한 번 더 누르면 삭제';
  btn.classList.add('confirm-state');
  deleteArm = {
    medId,
    timer: setTimeout(() => { deleteArm = null; render(); }, 3000),
  };
}

/* ── 백업 내보내기 / 가져오기 ───────── */
async function exportData() {
  const json = JSON.stringify(state, null, 2);
  const filename = `복약백업-${dateKey(new Date())}.json`;
  const blob = new Blob([json], { type: 'application/json' });

  // iOS에서는 공유 시트(→ "파일에 저장" → iCloud Drive)가 가장 안정적
  if (navigator.canShare) {
    const file = new File([blob], filename, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '복약 백업' });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 사용자가 취소
        // 공유 실패 시 아래 다운로드로 폴백
      }
    }
  }
  // PC 브라우저 등: 파일 다운로드
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      alert('백업 파일을 읽을 수 없습니다. 올바른 백업 파일인지 확인해 주세요.');
      return;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.meds)) {
      alert('이 파일은 복약 백업 파일이 아닌 것 같습니다.');
      return;
    }
    const count = data.meds.length;
    if (!confirm(`백업에서 약 ${count}개를 불러옵니다.\n현재 기기의 데이터는 백업 내용으로 덮어쓰여집니다. 계속할까요?`)) {
      return;
    }
    state = { meds: data.meds, log: data.log || {} };
    saveState();
    render();
    alert(`복원 완료! 약 ${count}개를 불러왔습니다.`);
  };
  reader.readAsText(file);
}

// 숨김 파일 입력: 가져오기 버튼이 누르면 파일 선택창을 띄움
const importInput = document.getElementById('import-file');
importInput.addEventListener('change', () => {
  if (importInput.files && importInput.files[0]) {
    importData(importInput.files[0]);
  }
  importInput.value = ''; // 같은 파일 다시 선택 가능하도록 초기화
});

/* ── 클라우드 동기화 UI ─────────────── */
function syncCardHtml() {
  if (sync.mode === 'cloud') {
    const badge = {
      connecting: ['연결 중…', 'badge-wait'],
      synced:     ['동기화됨', 'badge-on'],
      error:      ['연결 오류', 'badge-err'],
      local:      ['대기 중', 'badge-wait'],
    }[syncStatus] || ['동기화됨', 'badge-on'];
    return `
      <div class="card sync-card">
        <div class="sync-head">
          <span class="sync-title">☁️ 클라우드 동기화</span>
          <span class="sync-badge ${badge[1]}">${badge[0]}</span>
        </div>
        <div class="backup-desc">
          약을 체크할 때마다 클라우드에 자동 저장되고, 같은 동기화 코드를
          넣은 다른 기기와 실시간으로 공유됩니다.
        </div>
        ${syncStatus === 'error' ? `<div class="alert-banner warn" style="margin:0 0 12px">
          연결에 실패했습니다. 인터넷 연결과 Firebase 설정을 확인해 주세요.</div>` : ''}
        <div class="backup-btns">
          <button class="btn-sm" data-action="sync-showcode">📋 동기화 코드 보기</button>
          <button class="btn-sm danger" data-action="sync-off">동기화 끄기</button>
        </div>
      </div>`;
  }
  return `
    <div class="card sync-card">
      <div class="sync-head">
        <span class="sync-title">☁️ 클라우드 동기화</span>
        <span class="sync-badge badge-off">로컬 전용</span>
      </div>
      <div class="backup-desc">
        지금은 이 기기에만 데이터가 저장됩니다. 클라우드 동기화를 켜면
        기록할 때마다 자동 저장되고 여러 기기에서 같은 기록을 볼 수 있어요.
        (무료 Firebase 계정이 필요합니다.)
      </div>
      <div class="backup-btns">
        <button class="btn-sm" data-action="sync-setup">클라우드 동기화 설정</button>
      </div>
    </div>`;
}

// Firebase 설정 스니펫(또는 JSON)에서 설정 객체를 추출
function parseFirebaseConfig(text) {
  let t = (text || '').trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  let obj = null;
  try { obj = JSON.parse(t); }
  catch (e) {
    try { obj = Function('return (' + t + ')')(); } // 따옴표 없는 키 대응
    catch (e2) { return null; }
  }
  if (!obj || !obj.apiKey || !obj.projectId) return null;
  return obj;
}

function openSyncModal() {
  modalRoot.innerHTML = `
    <div class="modal-overlay" data-action="modal-dismiss">
      <div class="modal-sheet">
        <h2>클라우드 동기화 설정</h2>
        <div class="backup-desc" style="margin-bottom:16px">
          Firebase 콘솔에서 복사한 <b>firebaseConfig</b> 값을 붙여넣으세요.
          (설정 방법은 README의 안내를 참고하세요.)
        </div>
        <div class="field">
          <label>Firebase 설정</label>
          <textarea id="f-fbconfig" rows="6" placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "...", "appId": "..." }'></textarea>
        </div>
        <div class="field">
          <label>다른 기기에서 쓰던 동기화 코드가 있나요? (없으면 비워두세요)</label>
          <input type="text" id="f-synccode" placeholder="기존 코드 입력 (선택)">
        </div>
        <div class="modal-btns">
          <button class="btn-cancel" data-action="modal-close">취소</button>
          <button class="btn-save" data-action="sync-connect">연결</button>
        </div>
      </div>
    </div>`;
}

async function connectCloudFromModal() {
  const config = parseFirebaseConfig(document.getElementById('f-fbconfig').value);
  if (!config) {
    alert('Firebase 설정을 읽을 수 없습니다. firebaseConfig 전체를 붙여넣었는지 확인해 주세요.');
    return;
  }
  const existingCode = document.getElementById('f-synccode').value.trim();
  const joining = !!existingCode;
  if (joining &&
      !confirm('기존 코드로 연결하면 이 기기의 현재 데이터는 클라우드 데이터로 대체됩니다. 계속할까요?')) {
    return;
  }

  const code = existingCode || Cloud.randomCode();
  closeModal();

  const res = await Cloud.start(config, code, {
    onStatus: onCloudStatus,
    onRemote: applyRemote,
  });
  if (!res.ok) {
    alert('연결 실패: ' + (res.error || '알 수 없는 오류') +
          '\n\nFirebase 설정과 Firestore/익명 로그인 활성화 여부를 확인해 주세요.');
    sync = { mode: 'local' };
    saveSync();
    render();
    return;
  }

  sync = { mode: 'cloud', config, code };
  saveSync();

  if (joining) {
    if (res.existed && res.data) applyRemote(res.data);  // 클라우드 데이터 받기
  } else {
    await Cloud.push(state);                              // 이 기기 데이터 올리기
  }
  render();
  if (!joining) showSyncCode();  // 새로 만든 코드는 바로 보여줘서 다른 기기에 입력하게 함
}

function disableCloud() {
  if (!confirm('클라우드 동기화를 끕니다. 이 기기의 데이터는 그대로 남아 있고, 더 이상 자동 저장되지 않습니다. 계속할까요?')) return;
  if (window.Cloud) Cloud.stop();
  sync = { mode: 'local' };
  saveSync();
  syncStatus = 'local';
  render();
}

function showSyncCode() {
  if (!sync.code) return;
  modalRoot.innerHTML = `
    <div class="modal-overlay" data-action="modal-dismiss">
      <div class="modal-sheet">
        <h2>동기화 코드</h2>
        <div class="backup-desc" style="margin-bottom:12px">
          다른 기기(아이패드 등)에서 같은 기록을 보려면, 그 기기의 클라우드
          설정에서 아래 코드를 입력하세요. <b>이 코드는 비밀번호처럼 다루세요.</b>
        </div>
        <div class="sync-code-box" id="sync-code-text">${esc(sync.code)}</div>
        <div class="modal-btns">
          <button class="btn-cancel" data-action="modal-close">닫기</button>
          <button class="btn-save" data-action="sync-copycode">코드 복사</button>
        </div>
      </div>
    </div>`;
}

/* ── 이벤트 위임 ───────────────────── */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'toggle':
      toggleDose(el.dataset.med, el.dataset.slot);
      break;
    case 'add':
      openMedForm(null);
      break;
    case 'export-data':
      exportData();
      break;
    case 'import-data':
      importInput.click();
      break;
    case 'sync-setup':
      openSyncModal();
      break;
    case 'sync-connect':
      connectCloudFromModal();
      break;
    case 'sync-off':
      disableCloud();
      break;
    case 'sync-showcode':
      showSyncCode();
      break;
    case 'sync-copycode':
      if (navigator.clipboard && sync.code) {
        navigator.clipboard.writeText(sync.code)
          .then(() => alert('동기화 코드를 복사했습니다.'))
          .catch(() => alert('복사에 실패했습니다. 코드를 직접 선택해 복사해 주세요.'));
      }
      break;
    case 'edit':
      openMedForm(state.meds.find(m => m.id === el.dataset.med));
      break;
    case 'delete':
      handleDelete(el.dataset.med, el);
      break;
    case 'refill':
      openRefillModal(state.meds.find(m => m.id === el.dataset.med));
      break;
    case 'refill-save': {
      const med = state.meds.find(m => m.id === el.dataset.med);
      const amt = Math.max(0, parseInt(document.getElementById('f-refill').value, 10) || 0);
      med.stock += amt;
      saveState();
      closeModal();
      render();
      break;
    }
    case 'med-save':
      saveMedForm(el.dataset.med || null);
      break;
    case 'modal-close':
      closeModal();
      break;
    case 'modal-dismiss':
      if (e.target === el) closeModal(); // 시트 바깥 탭만 닫기
      break;
    case 'slot-toggle':
      el.classList.toggle('on');
      captureMedDraft();
      break;
    case 'period-mode': {
      modalRoot.querySelectorAll('.period-opt').forEach(b => b.classList.remove('on'));
      el.classList.add('on');
      const detail = document.getElementById('period-detail');
      const endInput = document.getElementById('f-enddate');
      if (el.dataset.mode === 'fixed') {
        detail.style.display = '';
        if (!endInput.value) endInput.value = shiftDate(dateKey(new Date()), 4); // 기본 5일치
      } else {
        detail.style.display = 'none';
      }
      captureMedDraft();
      break;
    }
    case 'period-days': {
      const n = parseInt(el.dataset.days, 10) || 1;
      document.getElementById('f-enddate').value = shiftDate(dateKey(new Date()), n - 1);
      captureMedDraft();
      break;
    }
    case 'set-active': {
      const med = state.meds.find(m => m.id === el.dataset.med);
      if (med) { med.active = el.dataset.val === '1'; saveState(); render(); }
      break;
    }
    case 'restart-med': {
      const med = state.meds.find(m => m.id === el.dataset.med);
      if (med) { med.active = true; med.endDate = null; saveState(); render(); }
      break;
    }
    case 'cal-prev':
      calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
      render();
      break;
    case 'cal-next':
      calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
      render();
      break;
    case 'pick-day':
      selectedDate = el.dataset.date;
      render();
      break;
  }
});

// 모달 안에서 타이핑할 때마다 임시 저장
modalRoot.addEventListener('input', captureMedDraft);
modalRoot.addEventListener('change', captureMedDraft);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    ui.tab = currentTab;
    saveUi();
    if (currentTab === 'history') {
      calCursor = startOfMonth(new Date());
      selectedDate = dateKey(new Date());
    }
    render();
  });
});

/* ── 자정 넘김 대응: 앱이 떠 있는 채로 날짜가 바뀌면 갱신 ── */
let lastDay = dateKey(new Date());
setInterval(() => {
  const nowDay = dateKey(new Date());
  if (nowDay !== lastDay) {
    lastDay = nowDay;
    render();
  }
}, 60 * 1000);

/* ── 서비스 워커 등록 (https/localhost에서만) ── */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();

/* 새로고침 전에 입력 중이던 모달 복원 */
if (ui.modal) {
  if (ui.modal.kind === 'med') {
    const med = ui.modal.medId ? state.meds.find(m => m.id === ui.modal.medId) : null;
    if (ui.modal.medId && !med) {
      ui.modal = null; saveUi();           // 수정 중이던 약이 삭제된 경우
    } else {
      openMedForm(med, ui.modal.draft);
    }
  } else if (ui.modal.kind === 'refill') {
    const med = state.meds.find(m => m.id === ui.modal.medId);
    if (med) openRefillModal(med);
    else { ui.modal = null; saveUi(); }
  }
}

/* 클라우드 모드로 설정돼 있으면 자동 연결 시도 */
resumeCloud();
