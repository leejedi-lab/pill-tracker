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
function saveState() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
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
  const meds = state.meds.filter(m => (m.created || '0000-00-00') <= dk);
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
  let expected = 0, taken = 0;
  for (const m of state.meds) {
    for (const s of m.slots) {
      expected++;
      if (dayLog[`${m.id}|${s}`]) taken++;
    }
  }
  const pct = expected ? Math.round((taken / expected) * 100) : 0;

  // 재고 부족 경고 배너
  const lowMeds = state.meds.filter(isLow);
  const banner = lowMeds.length
    ? `<div class="alert-banner warn">⚠️ <b>약이 얼마 남지 않았어요:</b> ${
        lowMeds.map(m => `${esc(m.name)} (${daysLeft(m)}일치)`).join(', ')
      }</div>`
    : '';

  // 시간대별 복용 카드
  let slotsHtml = '';
  for (const slot of SLOTS) {
    const meds = state.meds.filter(m => m.slots.includes(slot.id));
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
    html += `
      <div class="card med-card">
        <div class="med-top">
          <div>
            <div class="med-name">${esc(m.name)}</div>
            <div class="med-chips">
              ${m.slots.map(s => `<span class="chip primary">${slotLabel(s)}</span>`).join('')}
              <span class="chip">1회 ${m.dose}${esc(m.unit)}</span>
            </div>
          </div>
        </div>
        <div class="stock-row">
          <div class="stock-num ${low ? 'low' : ''}">
            ${m.stock}${esc(m.unit)} 남음
            <small>(약 ${left === Infinity ? '-' : left + '일치'})</small>
          </div>
          <div class="med-actions">
            <button class="btn-sm" data-action="refill" data-med="${m.id}">재고 추가</button>
            <button class="btn-sm" data-action="edit" data-med="${m.id}">수정</button>
            <button class="btn-sm danger" data-action="delete" data-med="${m.id}">삭제</button>
          </div>
        </div>
      </div>`;
  }

  if (state.meds.length === 0) {
    html = `
      <div class="empty-state">
        <span class="emoji">💊</span>
        복용 중인 약을 등록해 보세요.
      </div>`;
  }

  view.innerHTML = html + `<button class="btn-primary" data-action="add">＋ 약 추가</button>`;
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
  const selMeds = state.meds.filter(m => (m.created || '0000-00-00') <= selectedDate);
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
  ui.modal.draft = {
    name: get('f-name').value,
    dose: parseInt(get('f-dose').value, 10) || 1,
    unit: get('f-unit').value,
    stock: parseInt(get('f-stock').value, 10) || 0,
    lowDays: parseInt(get('f-lowdays').value, 10) || 3,
    slots: [...modalRoot.querySelectorAll('.slot-opt.on')].map(b => b.dataset.slot),
  };
  saveUi();
}

function saveMedForm(medId) {
  const name = document.getElementById('f-name').value.trim();
  const dose = Math.max(1, parseInt(document.getElementById('f-dose').value, 10) || 1);
  const unit = document.getElementById('f-unit').value;
  const stock = Math.max(0, parseInt(document.getElementById('f-stock').value, 10) || 0);
  const lowDays = Math.max(1, parseInt(document.getElementById('f-lowdays').value, 10) || 3);
  const slots = [...modalRoot.querySelectorAll('.slot-opt.on')].map(b => b.dataset.slot);

  if (!name) { document.getElementById('f-name').focus(); return; }
  if (slots.length === 0) return;

  if (medId) {
    const med = state.meds.find(m => m.id === medId);
    Object.assign(med, { name, dose, unit, stock, lowDays, slots });
  } else {
    state.meds.push({
      id: uid(), name, dose, unit, stock, lowDays, slots,
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
