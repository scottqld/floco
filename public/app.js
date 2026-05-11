'use strict';

// API base URL — empty for local dev, set via config.js for production
const API = (typeof CONFIG !== 'undefined' && CONFIG.API_URL) ? CONFIG.API_URL : '';

// ── Service Worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ── Access gate ────────────────────────────────────────────────────────────
const CODE_KEY = 'permit_code';

function getStoredCode() {
  return localStorage.getItem(CODE_KEY) || '';
}

function showGate(errorMsg) {
  const gate = document.getElementById('accessGate');
  gate.removeAttribute('hidden');
  const err = document.getElementById('accessError');
  if (errorMsg) { err.textContent = errorMsg; err.hidden = false; }
  else           { err.hidden = true; }
  document.getElementById('accessCodeInput').value = '';
  document.getElementById('accessCodeInput').focus();
}

function hideGate() {
  document.getElementById('accessGate').hidden = true;
}

async function validateCode(code) {
  try {
    const res = await fetch(`${API}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Code': code },
      body: '{}',
    });
    return res.status === 200;
  } catch { return false; }
}

document.getElementById('accessSubmitBtn').addEventListener('click', submitCode);
document.getElementById('accessCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitCode(); });

async function submitCode() {
  const code = document.getElementById('accessCodeInput').value.trim();
  if (!code) return;
  const btn = document.getElementById('accessSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  const valid = await validateCode(code);
  if (valid) {
    localStorage.setItem(CODE_KEY, code);
    hideGate();
    initClients();
  } else {
    showGate('Incorrect access code — please try again.');
  }
  btn.disabled = false;
  btn.textContent = 'Continue';
}

(async function initGate() {
  if (!API) { hideGate(); return; } // local dev — no auth
  const stored = getStoredCode();
  if (stored && await validateCode(stored)) { hideGate(); return; }
  localStorage.removeItem(CODE_KEY);
  showGate();
})();

// ── Authenticated fetch wrapper ────────────────────────────────────────────
function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers, 'X-Access-Code': getStoredCode() };
  return fetch(`${API}${path}`, { ...options, headers }).then(res => {
    if (res.status === 401) { localStorage.removeItem(CODE_KEY); showGate('Session expired — please re-enter your access code.'); }
    return res;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. EXIF ROTATION FIX
// ═══════════════════════════════════════════════════════════════════════════

function getExifOrientation(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const view = new DataView(e.target.result);
      if (view.getUint16(0, false) !== 0xFFD8) return resolve(1); // not a JPEG
      let offset = 2;
      while (offset < view.byteLength) {
        const marker = view.getUint16(offset, false);
        offset += 2;
        if (marker === 0xFFE1) {
          if (view.getUint32(offset + 2, false) !== 0x45786966) return resolve(1);
          const little = view.getUint16(offset + 8, false) === 0x4949;
          const ifdOffset = offset + 8 + view.getUint32(offset + 12, little);
          const tags = view.getUint16(ifdOffset, little);
          for (let i = 0; i < tags; i++) {
            if (view.getUint16(ifdOffset + 2 + i * 12, little) === 0x0112) {
              return resolve(view.getUint16(ifdOffset + 2 + i * 12 + 8, little));
            }
          }
          return resolve(1);
        }
        if ((marker & 0xFF00) !== 0xFF00) break;
        offset += view.getUint16(offset, false);
      }
      resolve(1);
    };
    reader.readAsArrayBuffer(file.slice(0, 64 * 1024));
  });
}

async function compressImage(file, maxPx, quality) {
  const orientation = await getExifOrientation(file);
  const swapped = orientation >= 5; // orientations 5-8 rotate 90°, swapping w/h

  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else       { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width  = swapped ? h : w;
        canvas.height = swapped ? w : h;
        const ctx = canvas.getContext('2d');
        // Apply EXIF transform before drawing
        switch (orientation) {
          case 2: ctx.transform(-1, 0, 0,  1, w, 0); break;
          case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
          case 4: ctx.transform( 1, 0, 0, -1, 0, h); break;
          case 5: ctx.transform( 0, 1, 1,  0, 0, 0); break;
          case 6: ctx.transform( 0, 1,-1,  0, h, 0); break;
          case 7: ctx.transform( 0,-1,-1,  0, h, w); break;
          case 8: ctx.transform( 0,-1, 1,  0, 0, w); break;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. AUTO-SAVE DRAFT (localStorage)
// ═══════════════════════════════════════════════════════════════════════════

const DRAFT_KEY = 'permit_draft';
let draftSaveTimer;

function saveDraft() {
  const fd = new FormData(document.getElementById('permitForm'));
  const draft = {};
  for (const [k, v] of fd.entries()) draft[k] = v;

  // Save signatures
  draft._sig_issuer    = sigIssuer    ? sigIssuer.toDataURL()    : null;
  draft._sig_issued_to = sigIssuedTo  ? sigIssuedTo.toDataURL()  : null;

  // Try saving photos (may exceed quota — handle gracefully)
  try {
    draft._initial_photo   = singlePhotos.initial_test_photo   ?? null;
    draft._after_photo     = singlePhotos.after_treatment_photo ?? null;
    draft._extra_photos    = [...extraPhotos];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota exceeded — save without photos
    try {
      delete draft._initial_photo;
      delete draft._after_photo;
      delete draft._extra_photos;
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch { /* storage unavailable */ }
  }
}

function scheduleSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraft, 600);
}

function loadDraft() {
  let raw;
  try { raw = localStorage.getItem(DRAFT_KEY); } catch { return; }
  if (!raw) return;

  let draft;
  try { draft = JSON.parse(raw); } catch { return; }

  const form = document.getElementById('permitForm');

  // Restore text / textarea / date / time / number inputs
  const textFields = [
    'client','site','site_address','basin','basin_reference',
    'valid_from_date','valid_from_time','valid_to_date','valid_to_time',
    'initial_test_ph','initial_test_ntu',
    'after_treatment_ph','after_treatment_ntu',
    'issued_by_name','issued_to_name','special_instructions',
  ];
  textFields.forEach(name => {
    const el = form.elements[name];
    if (el && draft[name] != null) el.value = draft[name];
  });

  // Restore radio
  if (draft.discharge_to) {
    const radio = form.querySelector(`input[name="discharge_to"][value="${CSS.escape(draft.discharge_to)}"]`);
    if (radio) radio.checked = true;
  }

  // Restore signatures
  if (draft._sig_issuer)    sigIssuer.loadFromDataURL(draft._sig_issuer);
  if (draft._sig_issued_to) sigIssuedTo.loadFromDataURL(draft._sig_issued_to);

  // Restore photos
  if (draft._initial_photo) {
    singlePhotos.initial_test_photo = draft._initial_photo;
    renderSinglePreview('initial_test_photo', draft._initial_photo);
  }
  if (draft._after_photo) {
    singlePhotos.after_treatment_photo = draft._after_photo;
    renderSinglePreview('after_treatment_photo', draft._after_photo);
  }
  if (Array.isArray(draft._extra_photos)) {
    draft._extra_photos.forEach(p => {
      extraPhotos.push(p);
      addExtraThumb(p, extraPhotos.length - 1);
    });
  }

  // Update pass/fail badges for restored readings
  updateBadge('initial_test_ph',    'badge_initial_ph',  'ph');
  updateBadge('initial_test_ntu',   'badge_initial_ntu', 'ntu');
  updateBadge('after_treatment_ph', 'badge_after_ph',    'ph');
  updateBadge('after_treatment_ntu','badge_after_ntu',   'ntu');

  // Show draft banner
  document.getElementById('draftBanner').hidden = false;
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. PASS/FAIL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════

// Limits (dewatering): pH 6.5–8.5 | NTU ≤375 (caution up to 412.5)
const LIMITS = {
  ph:  { lo: 6.5, hi: 8.5 },
  ntu: { pass: 375, caution: 412.5 },
};

function updateBadge(inputId, badgeId, type) {
  const input = document.getElementById(inputId);
  const badge = document.getElementById(badgeId);
  if (!input || !badge) return;

  const raw = input.value.trim();
  if (raw === '') { badge.textContent = ''; badge.className = 'reading-badge'; return; }

  const v = parseFloat(raw);
  if (isNaN(v)) { badge.textContent = ''; badge.className = 'reading-badge'; return; }

  let cls, label;
  if (type === 'ph') {
    if (v >= LIMITS.ph.lo && v <= LIMITS.ph.hi) { cls = 'pass';    label = '✓ Pass'; }
    else                                          { cls = 'fail';    label = '✗ Fail'; }
  } else {
    if (v <= LIMITS.ntu.pass)                     { cls = 'pass';    label = '✓ Pass'; }
    else if (v <= LIMITS.ntu.caution)             { cls = 'caution'; label = '⚠ Check'; }
    else                                          { cls = 'fail';    label = '✗ Fail'; }
  }
  badge.textContent = label;
  badge.className = `reading-badge ${cls}`;
}

// Wire up live badge updates + draft save on each reading field
[
  ['initial_test_ph',    'badge_initial_ph',  'ph'],
  ['initial_test_ntu',   'badge_initial_ntu', 'ntu'],
  ['after_treatment_ph', 'badge_after_ph',    'ph'],
  ['after_treatment_ntu','badge_after_ntu',   'ntu'],
].forEach(([inputId, badgeId, type]) => {
  document.getElementById(inputId)?.addEventListener('input', () => {
    updateBadge(inputId, badgeId, type);
    scheduleSave();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SIGNATURE PAD
// ═══════════════════════════════════════════════════════════════════════════

class SignaturePad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drawing = false;
    this.empty = true;
    this._resize();
    this._addPlaceholder();
    this._bind();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width  = (rect.width  || 400) * ratio;
    this.canvas.height = (rect.height || 130) * ratio;
    this.ctx.scale(ratio, ratio);
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 2;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  }

  _addPlaceholder() {
    const div = document.createElement('div');
    div.className = 'sig-placeholder';
    div.textContent = 'Sign here';
    this.placeholder = div;
    this.canvas.parentElement.appendChild(div);
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = e.touches ? e.touches[0] : e;
    return { x: s.clientX - r.left, y: s.clientY - r.top };
  }

  _start(e) {
    e.preventDefault();
    this.drawing = true;
    if (this.empty) { this.empty = false; this.placeholder.style.display = 'none'; }
    const p = this._pos(e);
    this.ctx.beginPath();
    this.ctx.moveTo(p.x, p.y);
  }

  _move(e) {
    if (!this.drawing) return;
    e.preventDefault();
    const p = this._pos(e);
    this.ctx.lineTo(p.x, p.y);
    this.ctx.stroke();
  }

  _end() {
    this.drawing = false;
    scheduleSave(); // save after each stroke
  }

  _bind() {
    this.canvas.addEventListener('mousedown',  this._start.bind(this));
    this.canvas.addEventListener('mousemove',  this._move.bind(this));
    this.canvas.addEventListener('mouseup',    this._end.bind(this));
    this.canvas.addEventListener('mouseleave', this._end.bind(this));
    this.canvas.addEventListener('touchstart', this._start.bind(this), { passive: false });
    this.canvas.addEventListener('touchmove',  this._move.bind(this),  { passive: false });
    this.canvas.addEventListener('touchend',   this._end.bind(this));
  }

  clear() {
    const r = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, r.width, r.height);
    this.empty = true;
    this.placeholder.style.display = '';
    scheduleSave();
  }

  toDataURL() { return this.empty ? null : this.canvas.toDataURL('image/png'); }

  loadFromDataURL(dataUrl) {
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const r = this.canvas.getBoundingClientRect();
      this.ctx.drawImage(img, 0, 0, r.width, r.height);
      this.empty = false;
      this.placeholder.style.display = 'none';
    };
    img.src = dataUrl;
  }
}

// ── Init signature pads ────────────────────────────────────────────────────
const sigIssuer   = new SignaturePad(document.getElementById('sigIssuer'));
const sigIssuedTo = new SignaturePad(document.getElementById('sigIssuedTo'));

document.querySelectorAll('.sig-clear-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.target === 'sigIssuer')   sigIssuer.clear();
    if (btn.dataset.target === 'sigIssuedTo') sigIssuedTo.clear();
  });
});

window.addEventListener('load', () => { sigIssuer._resize(); sigIssuedTo._resize(); });

// ═══════════════════════════════════════════════════════════════════════════
// PHOTO CAPTURE
// ═══════════════════════════════════════════════════════════════════════════

const singlePhotos = {};
const extraPhotos  = [];

// Single photo (per measurement row)
document.querySelectorAll('.btn-photo').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.querySelector(`.photo-file-input[data-field="${btn.dataset.target}"]`);
    input.value = '';
    input.click();
  });
});

document.querySelectorAll('.photo-file-input').forEach(input => {
  input.addEventListener('change', async () => {
    const field = input.dataset.field;
    const file  = input.files[0];
    if (!file) return;
    const dataUrl = await compressImage(file, 1280, 0.85);
    singlePhotos[field] = dataUrl;
    renderSinglePreview(field, dataUrl);
    scheduleSave();
  });
});

function renderSinglePreview(field, dataUrl) {
  const previewEl = document.getElementById(`${field}_preview`);
  previewEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'single-thumb';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = field;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'photo-remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    delete singlePhotos[field];
    previewEl.innerHTML = '';
    scheduleSave();
  });
  wrap.appendChild(img);
  wrap.appendChild(removeBtn);
  previewEl.appendChild(wrap);
}

// Extra photos
const extraPhotoInput = document.getElementById('extraPhotoInput');
const extraPhotoGrid  = document.getElementById('extraPhotoGrid');

document.getElementById('addPhotoBtn').addEventListener('click', () => {
  extraPhotoInput.value = '';
  extraPhotoInput.click();
});

extraPhotoInput.addEventListener('change', async () => {
  for (const file of Array.from(extraPhotoInput.files)) {
    const dataUrl = await compressImage(file, 1280, 0.85);
    extraPhotos.push(dataUrl);
    addExtraThumb(dataUrl, extraPhotos.length - 1);
    scheduleSave();
  }
});

function addExtraThumb(dataUrl, index) {
  const wrap = document.createElement('div');
  wrap.className = 'photo-thumb';
  wrap.dataset.index = index;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = `Photo ${index + 1}`;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'photo-remove';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    const idx = parseInt(wrap.dataset.index, 10);
    extraPhotos.splice(idx, 1);
    extraPhotoGrid.innerHTML = '';
    extraPhotos.forEach((p, i) => addExtraThumb(p, i));
    scheduleSave();
  });
  wrap.appendChild(img);
  wrap.appendChild(removeBtn);
  extraPhotoGrid.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════════════════════════
// FORM SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════

const form           = document.getElementById('permitForm');
const submitBtn      = document.getElementById('submitBtn');
const loadingOverlay = document.getElementById('loadingOverlay');

// Auto-save on any field change
form.addEventListener('input',  scheduleSave);
form.addEventListener('change', scheduleSave);

form.addEventListener('submit', async e => {
  e.preventDefault();

  if (!form.querySelector('input[name="discharge_to"]:checked')) {
    showToast('Please select a "Discharge To" option.', 'error');
    return;
  }
  if (!form.checkValidity()) {
    showToast('Please fill in all required fields.', 'error');
    return;
  }

  // Offline — queue for later
  if (!navigator.onLine) {
    const q = getQueue();
    q.push(collectData());
    saveQueue(q);
    advancePermitRef();
    saveOperatorName();
    clearDraft();
    showToast('No connection — permit saved and will send when back online.', '');
    setTimeout(() => { if (confirm('Permit queued. Reset for a new permit?')) { resetForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 1500);
    return;
  }

  submitBtn.disabled = true;
  loadingOverlay.hidden = false;

  try {
    const res  = await apiFetch('/api/submit', {
      method: 'POST',
      body: JSON.stringify(collectData()),
    });
    const json = await res.json();

    if (json.success) {
      advancePermitRef();
      saveOperatorName();
      clearDraft();
      showToast('Permit submitted and emailed!', 'success');
      setTimeout(() => { if (confirm('Permit sent. Reset for a new permit?')) { resetForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 1500);
    } else {
      showToast('Error: ' + (json.message || 'Submission failed'), 'error');
    }
  } catch {
    showToast('Network error – check your connection.', 'error');
  } finally {
    submitBtn.disabled = false;
    loadingOverlay.hidden = true;
  }
});

function collectData() {
  const fd = new FormData(form);
  const data = {};
  for (const [k, v] of fd.entries()) data[k] = v;
  data.issued_by_signature   = sigIssuer.toDataURL();
  data.issued_to_signature   = sigIssuedTo.toDataURL();
  data.initial_test_photo    = singlePhotos.initial_test_photo    ?? null;
  data.after_treatment_photo = singlePhotos.after_treatment_photo ?? null;
  data.additional_photos     = [...extraPhotos];
  data.cc_email              = document.getElementById('cc_email').value.trim();
  data.permit_reference      = document.getElementById('permitRef').textContent;
  return data;
}

function resetForm() {
  form.reset();
  sigIssuer.clear();
  sigIssuedTo.clear();
  Object.keys(singlePhotos).forEach(k => delete singlePhotos[k]);
  document.getElementById('initial_test_photo_preview').innerHTML  = '';
  document.getElementById('after_treatment_photo_preview').innerHTML = '';
  extraPhotos.length = 0;
  extraPhotoGrid.innerHTML = '';
  ['badge_initial_ph','badge_initial_ntu','badge_after_ph','badge_after_ntu']
    .forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = ''; el.className = 'reading-badge'; } });
  document.getElementById('draftBanner').hidden = true;
  clearDraft();
  setDefaults();
  showPermitRef();
  prefillOperatorName();
}

// Draft banner — discard button
document.getElementById('clearDraftBtn').addEventListener('click', () => {
  if (confirm('Discard saved draft and reset the form?')) {
    clearDraft();
    form.reset();
    resetForm();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════

let toastTimer;
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${type ? ' ' + type : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 4000);
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULTS + LOAD DRAFT ON START
// ═══════════════════════════════════════════════════════════════════════════

function setDefaults() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  document.getElementById('valid_from_date').value = dateStr;
  document.getElementById('valid_from_time').value = timeStr;
  const to = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);
  document.getElementById('valid_to_date').value =
    `${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}`;
  document.getElementById('valid_to_time').value = timeStr;
}

// ── Permit reference number ────────────────────────────────────────────────
const PERMIT_REF_KEY = 'permit_ref_counter';

function showPermitRef() {
  const n = parseInt(localStorage.getItem(PERMIT_REF_KEY) || '0', 10) + 1;
  document.getElementById('permitRef').textContent = `PTD-${String(n).padStart(4, '0')}`;
}

function advancePermitRef() {
  const n = parseInt(localStorage.getItem(PERMIT_REF_KEY) || '0', 10) + 1;
  localStorage.setItem(PERMIT_REF_KEY, String(n));
}

// ── Operator name pre-fill ─────────────────────────────────────────────────
const OPERATOR_KEY = 'permit_operator';

function prefillOperatorName() {
  const saved = localStorage.getItem(OPERATOR_KEY);
  if (saved) {
    const el = document.getElementById('issued_by_name');
    if (el && !el.value) el.value = saved;
  }
}

function saveOperatorName() {
  const name = document.getElementById('issued_by_name')?.value.trim();
  if (name) localStorage.setItem(OPERATOR_KEY, name);
}

// ── Offline queue ──────────────────────────────────────────────────────────
const QUEUE_KEY = 'permit_queue';

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}

function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* quota */ }
}

async function processQueue() {
  const queue = getQueue();
  if (!queue.length) return;
  showToast(`Sending ${queue.length} queued permit(s)…`);
  const remaining = [];
  for (const item of queue) {
    try {
      const res  = await apiFetch('/api/submit', {
        method: 'POST',
        body: JSON.stringify(item),
      });
      const json = await res.json();
      if (!json.success) remaining.push(item);
    } catch {
      remaining.push(item);
    }
  }
  saveQueue(remaining);
  const sent = queue.length - remaining.length;
  if (sent > 0) showToast(`${sent} queued permit(s) sent!`, 'success');
  if (remaining.length > 0) showToast(`${remaining.length} permit(s) still queued — check connection.`, 'error');
}

window.addEventListener('online', processQueue);

setDefaults();
showPermitRef();
loadDraft();    // restore any saved draft (overwrites defaults if draft exists)
prefillOperatorName();
initClients();  // load saved sites from server

// ═══════════════════════════════════════════════════════════════════════════
// SAVED SITES – CASCADING PICKERS (Client → Site → Basin)
// ═══════════════════════════════════════════════════════════════════════════

const SITE_FIELDS = ['client','site','site_address','basin','basin_reference'];

let allSites = [];

async function initClients() {
  try {
    allSites = await apiFetch('/api/clients').then(r => r.json());
    buildCascade(allSites);
  } catch { /* offline – skip */ }
}

function buildCascade(sites) {
  if (!Array.isArray(sites)) return;

  const clientInput = document.getElementById('pickClient');
  const clientList  = document.getElementById('pickClientList');
  const siteSel     = document.getElementById('pickSite');
  const basinSel    = document.getElementById('pickBasin');

  const clients = [...new Set(sites.map(s => s.client))].sort();
  let selectedClient = null;

  function basinLabel(b) {
    return [b.basin, b.basin_reference].filter(Boolean).join(' · ') || '(unnamed)';
  }

  function populateSites(client) {
    siteSel.innerHTML  = '<option value="">— Select site —</option>';
    basinSel.innerHTML = '<option value="">— Select basin —</option>';
    basinSel.disabled  = true;
    if (!client) { siteSel.disabled = true; return; }
    [...new Set(sites.filter(s => s.client === client).map(s => s.site))].sort()
      .forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        siteSel.appendChild(opt);
      });
    siteSel.disabled = false;
  }

  function showClientDropdown(filter) {
    const q = (filter || '').toLowerCase();
    const matches = q ? clients.filter(c => c.toLowerCase().includes(q)) : clients;
    clientList.innerHTML = '';
    if (!matches.length) { clientList.hidden = true; return; }
    matches.forEach(c => {
      const li = document.createElement('li');
      li.className = 'picker-option';
      li.textContent = c;
      li.addEventListener('mousedown', e => { e.preventDefault(); confirmClient(c); });
      clientList.appendChild(li);
    });
    clientList.hidden = false;
  }

  function confirmClient(client) {
    selectedClient = client;
    clientInput.value = client;
    clientList.hidden = true;
    document.getElementById('clearPickerBtn').hidden = false;
    populateSites(client);
  }

  const clearBtn = document.getElementById('clearPickerBtn');
  clearBtn.onclick = () => {
    clientInput.value = '';
    clientInput.dispatchEvent(new Event('input'));
    SITE_FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
    scheduleSave();
  };

  clientInput.oninput = () => {
    selectedClient = null;
    populateSites(null);
    showClientDropdown(clientInput.value);
    clearBtn.hidden = true;
  };
  clientInput.onfocus = () => { clientInput.select(); showClientDropdown(''); };
  clientInput.onblur  = () => {
    setTimeout(() => {
      clientList.hidden = true;
      if (clientInput.value.trim() !== (selectedClient || '')) {
        clientInput.value = selectedClient || '';
        if (!selectedClient) populateSites(null);
      }
    }, 150);
  };

  siteSel.onchange = () => {
    const site = siteSel.value;
    basinSel.innerHTML = '<option value="">— Select basin —</option>';
    if (!site) { basinSel.disabled = true; return; }

    const matches = sites.filter(s => s.client === selectedClient && s.site === site);
    if (matches.length === 1) { applySite(matches[0]); basinSel.disabled = true; return; }

    matches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id; opt.textContent = basinLabel(b);
      basinSel.appendChild(opt);
    });
    basinSel.disabled = false;
  };

  basinSel.onchange = () => {
    const record = sites.find(s => s.id === basinSel.value);
    if (record) applySite(record);
  };

  // Restore last used
  const lastId = localStorage.getItem(LAST_SITE_KEY);
  if (!lastId) return;
  const last = sites.find(s => s.id === lastId);
  if (!last) return;

  confirmClient(last.client);
  siteSel.value = last.site;

  const lastMatches = sites.filter(s => s.client === last.client && s.site === last.site);
  if (lastMatches.length > 1) {
    basinSel.innerHTML = '<option value="">— Select basin —</option>';
    lastMatches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id; opt.textContent = basinLabel(b);
      basinSel.appendChild(opt);
    });
    basinSel.disabled = false;
    basinSel.value = last.id;
  }

  if (!document.getElementById('client').value) applySite(last, true);
}

const LAST_SITE_KEY = 'permit_last_site';

function applySite(site, silent) {
  SITE_FIELDS.forEach(field => {
    const el = document.getElementById(field);
    if (el) el.value = site[field] || '';
  });
  try { localStorage.setItem(LAST_SITE_KEY, site.id); } catch {}
  if (!silent) {
    showToast(`Loaded: ${site.client} – ${site.site}`, 'success');
    scheduleSave();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG VIEWER
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('logBtn').addEventListener('click', openLog);
document.getElementById('logClose').addEventListener('click', () => { document.getElementById('logModal').hidden = true; });
document.getElementById('logModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });

async function openLog() {
  const modal       = document.getElementById('logModal');
  const list        = document.getElementById('logList');
  const searchInput = document.getElementById('logSearch');
  modal.hidden = false;
  list.innerHTML = '<p class="log-empty">Loading…</p>';
  searchInput.value = '';

  let entries = [];
  try {
    entries = await apiFetch('/api/log').then(r => r.json());
  } catch {
    list.innerHTML = '<p class="log-empty">Could not load — check connection.</p>';
    return;
  }

  function renderLog(q) {
    const filtered = q
      ? entries.filter(e => [e.client, e.site, e.issuedBy, e.issuedTo, e.dischargeTo]
          .some(v => v && v.toLowerCase().includes(q.toLowerCase())))
      : entries;
    if (!filtered.length) {
      list.innerHTML = `<p class="log-empty">${entries.length ? 'No matches.' : 'No submissions yet.'}</p>`;
      return;
    }
    list.innerHTML = filtered.map(e => {
      const date = e.timestamp ? new Date(e.timestamp).toLocaleString() : e.validFrom || '';
      return `<div class="log-entry">
        <div class="log-entry-top">
          <span class="log-entry-client">${esc(e.client)} – ${esc(e.site)}</span>
          <span class="log-entry-date">${date}</span>
        </div>
        <div class="log-entry-detail">Issued by ${esc(e.issuedBy)} → ${esc(e.issuedTo)} · ${esc(e.dischargeTo)}</div>
      </div>`;
    }).join('');
  }

  renderLog('');
  searchInput.oninput = () => renderLog(searchInput.value.trim());
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

// ═══════════════════════════════════════════════════════════════════════════
// ADD TO HOME SCREEN
// ═══════════════════════════════════════════════════════════════════════════

(function initA2HS() {
  const banner   = document.getElementById('a2hsBanner');
  const dismiss  = document.getElementById('a2hsDismiss');
  const A2HS_KEY = 'a2hs_dismissed';

  if (localStorage.getItem(A2HS_KEY)) return;
  if (window.navigator.standalone) return; // already installed on iOS

  // Android / Chrome: native install prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('a2hsText').textContent = 'Install this app for quick offline access.';
    banner.hidden = false;
    banner.querySelector('button:not(#a2hsDismiss)') && null; // no extra button needed
    // Replace banner tap with native prompt
    banner.addEventListener('click', async ev => {
      if (ev.target === dismiss) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') localStorage.setItem(A2HS_KEY, '1');
      banner.hidden = true;
    });
  });

  // iOS Safari: manual instruction
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isSafari = /safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent);
  if (isIOS && isSafari && !deferredPrompt) {
    banner.hidden = false;
  }

  dismiss.addEventListener('click', () => {
    banner.hidden = true;
    localStorage.setItem(A2HS_KEY, '1');
  });
})();

// ═══════════════════════════════════════════════════════════════════════════
// SITE MANAGER
// ═══════════════════════════════════════════════════════════════════════════

document.getElementById('siteBtn').addEventListener('click', openSiteManager);
document.getElementById('siteModalClose').addEventListener('click', () => { document.getElementById('siteModal').hidden = true; });
document.getElementById('siteModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
document.getElementById('siteSearch').addEventListener('input', () => renderSiteList(allSites));

function openSiteManager() {
  document.getElementById('siteModal').hidden = false;
  document.getElementById('siteSearch').value = '';
  renderSiteList(allSites);
}

function renderSiteList(sites) {
  const list = document.getElementById('siteList');
  const q    = (document.getElementById('siteSearch').value || '').toLowerCase();

  const filtered = q
    ? sites.filter(s => [s.client, s.site, s.basin, s.site_address, s.basin_reference]
        .some(v => v && v.toLowerCase().includes(q)))
    : sites;

  if (!filtered.length) {
    list.innerHTML = `<p class="log-empty">${sites.length ? 'No matches.' : 'No sites saved yet.'}</p>`;
    return;
  }

  const grouped = {};
  filtered.forEach(s => { (grouped[s.client] = grouped[s.client] || []).push(s); });

  list.innerHTML = Object.keys(grouped).sort().map(client => `
    <div class="site-group">
      <div class="site-group-header">${esc(client)}</div>
      ${grouped[client].map(e => `
        <div class="site-entry" data-id="${e.id}">
          <div class="site-entry-info">
            <span class="site-entry-name">${esc(e.site)}</span>
            ${e.basin ? `<span class="site-entry-meta">${esc(e.basin)}${e.basin_reference ? ' · ' + esc(e.basin_reference) : ''}</span>` : ''}
            ${e.site_address ? `<span class="site-entry-addr">${esc(e.site_address)}</span>` : ''}
          </div>
          <div class="site-entry-actions">
            <button type="button" class="site-icon-btn site-edit-btn" data-id="${e.id}" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button type="button" class="site-icon-btn site-delete-btn" data-id="${e.id}" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>
        <div class="site-edit-form" id="ef-${e.id}" hidden>
          <div class="site-field"><label class="site-field-label">Client</label><input class="site-field-input ef-client" value="${escAttr(e.client)}"></div>
          <div class="site-field"><label class="site-field-label">Site</label><input class="site-field-input ef-site" value="${escAttr(e.site)}"></div>
          <div class="site-field"><label class="site-field-label">Address</label><input class="site-field-input ef-addr" value="${escAttr(e.site_address)}"></div>
          <div class="site-field"><label class="site-field-label">Basin</label><input class="site-field-input ef-basin" value="${escAttr(e.basin)}"></div>
          <div class="site-field"><label class="site-field-label">Basin Ref</label><input class="site-field-input ef-ref" value="${escAttr(e.basin_reference)}"></div>
          <div class="site-edit-btns">
            <button type="button" class="btn btn-primary btn-sm site-save-btn" data-id="${e.id}">Save</button>
            <button type="button" class="btn btn-secondary btn-sm site-cancel-btn" data-id="${e.id}">Cancel</button>
          </div>
        </div>
      `).join('')}
    </div>
  `).join('');

  list.querySelectorAll('.site-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      list.querySelectorAll('.site-edit-form').forEach(f => { f.hidden = f.id !== 'ef-' + id; });
      document.getElementById('ef-' + id).querySelector('.ef-client').focus();
    });
  });

  list.querySelectorAll('.site-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('ef-' + btn.dataset.id).hidden = true;
    });
  });

  list.querySelectorAll('.site-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.id;
      const form = document.getElementById('ef-' + id);
      const body = {
        client:          form.querySelector('.ef-client').value.trim(),
        site:            form.querySelector('.ef-site').value.trim(),
        site_address:    form.querySelector('.ef-addr').value.trim(),
        basin:           form.querySelector('.ef-basin').value.trim(),
        basin_reference: form.querySelector('.ef-ref').value.trim(),
      };
      if (!body.client || !body.site) { showToast('Client and Site are required.', 'error'); return; }
      btn.disabled = true;
      try {
        await apiFetch('/api/clients/' + id, { method: 'PUT', body: JSON.stringify(body) });
        allSites = await apiFetch('/api/clients').then(r => r.json());
        buildCascade(allSites);
        renderSiteList(allSites);
        showToast('Saved.', 'success');
      } catch {
        showToast('Could not save — check connection.', 'error');
        btn.disabled = false;
      }
    });
  });

  list.querySelectorAll('.site-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id    = btn.dataset.id;
      const entry = allSites.find(s => s.id === id);
      const label = [entry?.site, entry?.basin].filter(Boolean).join(' – ') || 'this entry';
      if (!confirm(`Delete "${label}"?`)) return;
      try {
        await apiFetch('/api/clients/' + id, { method: 'DELETE' });
        allSites = await apiFetch('/api/clients').then(r => r.json());
        buildCascade(allSites);
        renderSiteList(allSites);
        showToast('Deleted.', '');
      } catch {
        showToast('Could not delete — check connection.', 'error');
      }
    });
  });
}

// ── Valid-to date presets ──────────────────────────────────────────────────

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = parseInt(btn.dataset.days, 10);
    const fromVal = document.getElementById('valid_from_date').value;
    const base = fromVal ? new Date(fromVal + 'T00:00:00') : new Date();
    const to = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('valid_to_date').value =
      `${to.getFullYear()}-${pad(to.getMonth() + 1)}-${pad(to.getDate())}`;
    scheduleSave();
  });
});

// ── Save new site entry ────────────────────────────────────────────────────

document.getElementById('saveSiteBtn').addEventListener('click', async () => {
  const client = document.getElementById('client').value.trim();
  const site   = document.getElementById('site').value.trim();
  if (!client || !site) {
    showToast('Enter at least a Client and Site name before saving.', 'error');
    return;
  }
  const body = {};
  SITE_FIELDS.forEach(f => { body[f] = document.getElementById(f)?.value.trim() || ''; });

  try {
    const res = await apiFetch('/api/clients', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.duplicate) {
      showToast('This site is already saved.', '');
    } else {
      showToast(`Saved: ${client} – ${site}`, 'success');
      allSites = await apiFetch('/api/clients').then(r => r.json());
      buildCascade(allSites);
    }
  } catch {
    showToast('Could not save – check connection.', 'error');
  }
});
