'use strict';

const APP_VERSION = 'v1.3.2';

// API base URL — empty for local dev, set via config.js for production
const API = (typeof CONFIG !== 'undefined' && CONFIG.API_URL) ? CONFIG.API_URL : '';

document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('appVersion');
  if (el) el.textContent = APP_VERSION;
});

// ── Form selector ──────────────────────────────────────────────────────────

let activeForm = 'ptd';

const FORM_VIEWS = { ptd: 'formPtd', install: 'formInstall', maint: 'formMaint' };

function switchForm(type) {
  if (type === activeForm) return;

  resetFormBody();

  activeForm = type;

  document.querySelectorAll('.form-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.form === type);
  });

  Object.entries(FORM_VIEWS).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.hidden = (key !== type);
  });
}

document.querySelectorAll('.form-tab').forEach(btn => {
  btn.addEventListener('click', () => switchForm(btn.dataset.form));
});

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

// ── New site button ────────────────────────────────────────────────────────

document.getElementById('newSiteBtn').addEventListener('click', () => {
  SITE_FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
  currentSiteId = null;
  unlockSiteFields();
  lockPermitBody();
  const block = document.getElementById('savedSitesBlock');
  if (block) block.hidden = true;
  setTimeout(() => {
    const input = document.getElementById('client');
    if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }, 100);
});

// ── Authenticated fetch wrapper ────────────────────────────────────────────
function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers, 'X-Access-Code': getStoredCode() };
  return fetch(`${API}${path}`, { ...options, headers }).then(res => {
    if (res.status === 401) { localStorage.removeItem(CODE_KEY); showGate('Session expired — please re-enter your access code.'); }
    return res;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. IMAGE COMPRESSION
// ═══════════════════════════════════════════════════════════════════════════

async function compressImage(file, maxPx, quality) {
  // createImageBitmap respects EXIF orientation natively — no manual rotation needed
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(
    () => createImageBitmap(file)
  );
  let w = bitmap.width, h = bitmap.height;
  if (w > maxPx || h > maxPx) {
    if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
    else       { w = Math.round(w * maxPx / h); h = maxPx; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', quality);
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

  draft._sig_issuer = sigIssuer ? sigIssuer.toDataURL() : null;

  // Try saving photos (may exceed quota — handle gracefully)
  try {
    draft._initial_ph_photo  = singlePhotos.initial_ph_photo  ?? null;
    draft._initial_ntu_photo = singlePhotos.initial_ntu_photo ?? null;
    draft._after_ph_photo    = singlePhotos.after_ph_photo    ?? null;
    draft._after_ntu_photo   = singlePhotos.after_ntu_photo   ?? null;
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
    'client','site','site_address','basin',
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

  if (draft._sig_issuer) sigIssuer.loadFromDataURL(draft._sig_issuer);

  // Restore photos
  if (draft._initial_ph_photo)  { singlePhotos.initial_ph_photo  = draft._initial_ph_photo;  renderSinglePreview('initial_ph_photo',  draft._initial_ph_photo);  }
  if (draft._initial_ntu_photo) { singlePhotos.initial_ntu_photo = draft._initial_ntu_photo; renderSinglePreview('initial_ntu_photo', draft._initial_ntu_photo); }
  if (draft._after_ph_photo)    { singlePhotos.after_ph_photo    = draft._after_ph_photo;    renderSinglePreview('after_ph_photo',    draft._after_ph_photo);    }
  if (draft._after_ntu_photo)   { singlePhotos.after_ntu_photo   = draft._after_ntu_photo;   renderSinglePreview('after_ntu_photo',   draft._after_ntu_photo);   }
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

function initialTestsPass() {
  const ph  = parseFloat(document.getElementById('initial_test_ph')?.value);
  const ntu = parseFloat(document.getElementById('initial_test_ntu')?.value);
  const phOk  = !isNaN(ph)  && ph  >= LIMITS.ph.lo && ph  <= LIMITS.ph.hi;
  const ntuOk = !isNaN(ntu) && ntu <= LIMITS.ntu.pass;
  return phOk && ntuOk;
}

function updateAfterTreatmentVisibility() {
  const section = document.getElementById('afterTreatmentSection');
  if (!section) return;
  const pass = initialTestsPass();
  section.hidden = pass;
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
    if (inputId.startsWith('initial_')) updateAfterTreatmentVisibility();
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
const sigIssuer = new SignaturePad(document.getElementById('sigIssuer'));

document.querySelectorAll('.sig-clear-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.target === 'sigIssuer')   sigIssuer.clear();
    if (btn.dataset.target === 'sigIssuedTo') sigIssuedTo.clear();
  });
});

window.addEventListener('load', () => { sigIssuer._resize(); });

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
// PDF GENERATION (browser-side, pdf-lib from CDN)
// ═══════════════════════════════════════════════════════════════════════════

async function generatePermitPDF(formData) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const A4_W = 595.28, A4_H = 841.89, M = 50;
  const CW = A4_W - 2 * M, PAD = 5;
  const C_BLACK = rgb(0, 0, 0);
  const C_GREY  = rgb(0.851, 0.851, 0.851);

  function b64ToBytes(b64) {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function parsePic(dataUrl) {
    if (!dataUrl || !dataUrl.includes('base64,')) return null;
    const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    return m ? { type: m[1], data: b64ToBytes(m[2]) } : null;
  }
  function fmtDate(dateStr, timeStr) {
    if (!dateStr) return '';
    const [y, mo, d] = dateStr.split('-');
    let r = `${d}/${mo}/${y}`;
    if (timeStr) { const [hh, mm] = timeStr.split(':'); const h = parseInt(hh, 10); r += ` ${h % 12 || 12}:${mm} ${h >= 12 ? 'pm' : 'am'}`; }
    return r;
  }
  function addDays(dateStr, days) {
    if (!dateStr) return '';
    const d = new Date(dateStr); d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function wrapText(text, font, size, maxWidth) {
    const lines = [];
    for (const para of String(text ?? '').split('\n')) {
      if (!para) { lines.push(''); continue; }
      const words = para.split(' '); let cur = '';
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(test, size) > maxWidth && cur) { lines.push(cur); cur = w; }
        else cur = test;
      }
      if (cur) lines.push(cur);
    }
    return lines;
  }

  const pdfDoc = await PDFDocument.create();
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fItal = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const validFrom = fmtDate(formData.valid_from_date, formData.valid_from_time);
  const validTo   = fmtDate(formData.valid_to_date,   formData.valid_to_time);

  function addPage() { return pdfDoc.addPage([A4_W, A4_H]); }
  function pdfY(topY, h = 0) { return A4_H - topY - h; }
  function drawRect(page, x, topY, w, h, { fill } = {}) {
    page.drawRectangle({ x, y: pdfY(topY, h), width: w, height: h,
      color: fill || undefined, borderColor: C_BLACK, borderWidth: 0.5 });
  }
  function drawText(page, text, x, topY, { font = fReg, size = 9, maxWidth } = {}) {
    page.drawText(String(text ?? ''), { x, y: pdfY(topY, size) + 1, font, size, color: C_BLACK, maxWidth });
  }
  function cell(page, x, topY, w, h, text, { bg, bold, size = 9 } = {}) {
    drawRect(page, x, topY, w, h, { fill: bg });
    if (text != null) drawText(page, text, x + PAD, topY + PAD, { font: bold ? fBold : fReg, size, maxWidth: w - PAD * 2 });
  }
  async function embedImg(pic) {
    try { return pic.type === 'png' ? await pdfDoc.embedPng(pic.data) : await pdfDoc.embedJpg(pic.data); }
    catch { return null; }
  }

  let page = addPage(), y = M;

  // Logo
  try {
    const res = await fetch('/floco_logo.png');
    const buf = new Uint8Array(await res.arrayBuffer());
    const img = await pdfDoc.embedPng(buf);
    const dims = img.scaleToFit(130, 80);
    page.drawImage(img, { x: M + (CW - dims.width) / 2, y: pdfY(y, dims.height), width: dims.width, height: dims.height });
    y += dims.height + 10;
  } catch { y += 90; }

  // Title
  const titleText = 'Permit to Discharge';
  drawText(page, titleText, M + (CW - fBold.widthOfTextAtSize(titleText, 20)) / 2, y, { font: fBold, size: 20 });
  y += 30;

  // Site details
  const D_LBL = 130;
  [['Client', formData.client], ['Site', formData.site], ['Site Address', formData.site_address], ['Basin', formData.basin]]
    .forEach(([lbl, val]) => { drawText(page, lbl + ':', M, y, { font: fBold, size: 10 }); drawText(page, val || '', M + D_LBL, y, { size: 10, maxWidth: CW - D_LBL }); y += 15; });
  y += 6;

  [['Discharge To', formData.discharge_to], ['Valid From', validFrom], ['Valid To', validTo]]
    .forEach(([lbl, val]) => { drawText(page, lbl + ':', M, y, { font: fBold, size: 10 }); drawText(page, val || '', M + D_LBL, y, { size: 10, maxWidth: CW - D_LBL }); y += 15; });
  y += 4;

  const noteText = `(Note: Discharge permit only valid for 5 days, or until rain event prior to ${fmtDate(addDays(formData.valid_from_date, 5))}.)`;
  wrapText(noteText, fItal, 9, CW).forEach(line => { drawText(page, line, M, y, { font: fItal, size: 9 }); y += 12; });
  y += 6;

  // Water quality table
  const WQ = [120, 75, 75, CW - 120 - 75 - 75];
  const PHOTO_W = WQ[3] - PAD * 2, PHOTO_H = Math.round(PHOTO_W * 3 / 4);
  const DATA_ROW = PHOTO_H + PAD * 2, HDR_ROW = 20;

  let cx = M;
  ['Reading', 'pH', 'NTU', ''].forEach((h, i) => { cell(page, cx, y, WQ[i], HDR_ROW, h, { bg: C_GREY, bold: true }); cx += WQ[i]; });
  y += HDR_ROW;

  for (const [lbl, ph, ntu, photo] of [
    ['Initial Test',    formData.initial_test_ph,    formData.initial_test_ntu,    formData.initial_ph_photo],
    ['After Treatment', formData.after_treatment_ph, formData.after_treatment_ntu, formData.after_ph_photo],
  ]) {
    cx = M;
    cell(page, cx, y, WQ[0], DATA_ROW, lbl); cx += WQ[0];
    cell(page, cx, y, WQ[1], DATA_ROW, ph  || ''); cx += WQ[1];
    cell(page, cx, y, WQ[2], DATA_ROW, ntu || ''); cx += WQ[2];
    cell(page, cx, y, WQ[3], DATA_ROW, null);
    const pic = parsePic(photo);
    if (pic) { const img = await embedImg(pic); if (img) { const d = img.scaleToFit(PHOTO_W, PHOTO_H); page.drawImage(img, { x: cx + PAD, y: pdfY(y + PAD, d.height), width: d.width, height: d.height }); } }
    cx += WQ[3];
    y += DATA_ROW;
  }
  y += 10;

  // Issued By / To
  if (y + 160 > A4_H - M) { page = addPage(); y = M; }
  const ISS_LBL = 120, ISS_VAL = CW - ISS_LBL, ISS_H = 70;

  cell(page, M, y, ISS_LBL, ISS_H, 'Issued By', { bg: C_GREY, bold: true });
  cell(page, M + ISS_LBL, y, ISS_VAL, ISS_H, formData.issued_by_name || '');
  const sigByPic = parsePic(formData.issued_by_signature);
  if (sigByPic) { const img = await embedImg(sigByPic); if (img) { const d = img.scaleToFit(ISS_VAL - PAD*2, 44); page.drawImage(img, { x: M+ISS_LBL+PAD, y: pdfY(y+18, d.height), width: d.width, height: d.height }); } }
  y += ISS_H;

  cell(page, M, y, ISS_LBL, ISS_H, 'Issued To', { bg: C_GREY, bold: true });
  cell(page, M + ISS_LBL, y, ISS_VAL, ISS_H, formData.issued_to_name || '');
  y += ISS_H + 10;

  // Special instructions
  const siText = formData.special_instructions || '';
  const siLines = siText ? wrapText(siText, fReg, 9, CW - PAD*2) : [];
  const LINE_H = 11, siH = Math.max(40, siLines.length * LINE_H + 24);
  if (y + siH > A4_H - M) { page = addPage(); y = M; }
  drawRect(page, M, y, CW, siH);
  drawText(page, 'Special Instructions:', M + PAD, y + PAD, { font: fBold, size: 9 });
  siLines.forEach((line, i) => drawText(page, line, M + PAD, y + PAD + 13 + i * LINE_H, { size: 9 }));

  // Extra photos (one per page)
  for (const photo of (formData.additional_photos || []).filter(p => p?.includes('base64,'))) {
    const pic = parsePic(photo); if (!pic) continue;
    const img = await embedImg(pic); if (!img) continue;
    const ep = addPage(), d = img.scaleToFit(CW, A4_H - M*2);
    ep.drawImage(img, { x: M + (CW - d.width)/2, y: M + (A4_H - M*2 - d.height)/2, width: d.width, height: d.height });
  }

  return pdfDoc.save();
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

  submitBtn.disabled = true;
  loadingOverlay.hidden = false;

  try {
    const data = collectData();
    const pdfBytes = await generatePermitPDF(data);
    const ref = data.permit_reference || '';
    const filename = `Permit-to-Discharge-${ref || new Date().toISOString().slice(0,10)}.pdf`;
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const pdfFile = new File([pdfBlob], filename, { type: 'application/pdf' });

    if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      await navigator.share({ files: [pdfFile], title: `Permit to Discharge${ref ? ' – ' + ref : ''}` });
    } else {
      // Fallback: trigger download
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    advancePermitRef();
    saveOperatorName();
    clearDraft();

    // Log to worker (best-effort)
    if (navigator.onLine && API) {
      apiFetch('/api/submit', { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
    }

    showToast('Permit PDF generated!', 'success');
    setTimeout(() => {
      if (confirm('Permit saved. Reset for a new permit?')) { resetForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    }, 1500);

  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('Error generating PDF: ' + err.message, 'error');
    }
  } finally {
    submitBtn.disabled = false;
    loadingOverlay.hidden = true;
  }
});

function collectData() {
  const fd = new FormData(form);
  const data = {};
  for (const [k, v] of fd.entries()) data[k] = v;
  data.issued_by_signature = sigIssuer.toDataURL();
  data.initial_ph_photo  = singlePhotos.initial_ph_photo  ?? null;
  data.initial_ntu_photo = singlePhotos.initial_ntu_photo ?? null;
  data.after_ph_photo    = singlePhotos.after_ph_photo    ?? null;
  data.after_ntu_photo   = singlePhotos.after_ntu_photo   ?? null;
  data.additional_photos = [...extraPhotos];
  data.permit_reference  = document.getElementById('permitRef').textContent;
  return data;
}

// Clears permit body fields only — site section and cascade pickers are untouched.
function resetFormBody() {
  const siteSection = document.querySelector('.form-section');  // first section = Site Details
  form.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.closest('.form-section') === siteSection) return; // skip site fields + pickers
    if (el.type === 'radio' || el.type === 'checkbox') { el.checked = false; return; }
    el.value = '';
  });
  issuedToUserEdited = false;
  sigIssuer.clear();
  Object.keys(singlePhotos).forEach(k => delete singlePhotos[k]);
  ['initial_ph_photo','initial_ntu_photo','after_ph_photo','after_ntu_photo'].forEach(f => {
    const el = document.getElementById(f + '_preview');
    if (el) el.innerHTML = '';
  });
  extraPhotos.length = 0;
  extraPhotoGrid.innerHTML = '';
  ['badge_initial_ph','badge_initial_ntu','badge_after_ph','badge_after_ntu']
    .forEach(id => { const b = document.getElementById(id); if (b) { b.textContent = ''; b.className = 'reading-badge'; } });
  document.getElementById('draftBanner').hidden = true;
  clearDraft();
  setDefaults();
  showPermitRef();
  prefillOperatorName();
  updateAfterTreatmentVisibility();
}

function resetForm() {
  form.reset();
  currentSiteId = null;
  issuedToUserEdited = false;
  updateSaveBtn();
  lockPermitBody();
  sigIssuer.clear();
  Object.keys(singlePhotos).forEach(k => delete singlePhotos[k]);
  ['initial_ph_photo','initial_ntu_photo','after_ph_photo','after_ntu_photo'].forEach(f => {
    const el = document.getElementById(f + '_preview');
    if (el) el.innerHTML = '';
  });
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

// Prevent browser autofill from copying Issued By into Issued To
let issuedToUserEdited = false;
document.getElementById('issued_to_name').addEventListener('input', () => { issuedToUserEdited = true; });
document.getElementById('issued_by_name').addEventListener('change', () => {
  if (!issuedToUserEdited) document.getElementById('issued_to_name').value = '';
});

// ── Offline queue (legacy — no-op, kept to avoid errors from old localStorage keys) ──
function getQueue() { return []; }
function saveQueue() {}
async function processQueue() {}

// ── Offline indicator ──────────────────────────────────────────────────────

function updateOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  const text   = document.getElementById('offlineBannerText');
  if (!navigator.onLine) {
    const q = getQueue();
    text.textContent = q.length
      ? `Offline – ${q.length} permit${q.length !== 1 ? 's' : ''} queued`
      : 'Offline – permits will be queued when back online';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

window.addEventListener('online',  () => { updateOfflineBanner(); processQueue(); });
window.addEventListener('offline', updateOfflineBanner);

setDefaults();
showPermitRef();
clearDraft();   // always start fresh on reload
prefillOperatorName();
lockPermitBody();
initClients();  // load saved sites from server
updateOfflineBanner(); // show banner immediately if starting offline

// ═══════════════════════════════════════════════════════════════════════════
// SAVED SITES – CASCADING PICKERS (Client → Site → Basin)
// ═══════════════════════════════════════════════════════════════════════════

const SITE_FIELDS = ['client','site','site_address','basin'];

let allSites = [];
let _confirmClient    = null; // exposed by buildCascade
let _restorePickerState = null; // exposed by buildCascade
let currentSiteId     = null;

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
    return b.basin || '(unnamed)';
  }

  function populateSites(client) {
    siteSel.innerHTML  = '<option value="">— Select site —</option>';
    basinSel.innerHTML = '<option value="">— Select basin —</option>';
    basinSel.disabled  = true;
    if (!client) { siteSel.disabled = true; return; }
    const siteNames = [...new Set(sites.filter(s => s.client === client).map(s => s.site))].sort();
    siteNames.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      siteSel.appendChild(opt);
    });
    // Allow adding a new site under this client
    const newOpt = document.createElement('option');
    newOpt.value = '__new__'; newOpt.textContent = '+ New site';
    siteSel.appendChild(newOpt);
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
    // Clear site detail fields so stale data can't carry over to a new client
    ['site','site_address','basin'].forEach(f => {
      const el = document.getElementById(f); if (el) el.value = '';
    });
    document.getElementById('client').value = client;
    currentSiteId = null;
    updateSaveBtn();
    populateSites(client);
  }

  _confirmClient = confirmClient; // expose for re-issue

  // Restore picker display without triggering side-effects (used on tab switch)
  _restorePickerState = function(clientVal, siteVal, basinId) {
    if (!clientVal) return;
    selectedClient = clientVal;
    clientInput.value = clientVal;
    clearBtn.hidden = false;
    populateSites(clientVal);
    if (siteVal) {
      siteSel.value = siteVal;
      // Populate basin dropdown for the saved site
      const matches = sites.filter(s => s.client === clientVal && s.site === siteVal);
      basinSel.innerHTML = '<option value="">— Select basin —</option>';
      matches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id; opt.textContent = basinLabel(b);
        basinSel.appendChild(opt);
      });
      if (matches.length) {
        const newOpt = document.createElement('option');
        newOpt.value = '__new__'; newOpt.textContent = '+ New basin';
        basinSel.appendChild(newOpt);
        basinSel.disabled = false;
        if (basinId) basinSel.value = basinId;
      }
    }
  };

  const clearBtn = document.getElementById('clearPickerBtn');
  clearBtn.onclick = () => {
    clientInput.value = '';
    clientInput.dispatchEvent(new Event('input'));
    SITE_FIELDS.forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
    currentSiteId = null;
    updateSaveBtn();
    unlockSiteFields();
    lockPermitBody();
    scheduleSave();
  };

  clientInput.oninput = () => {
    selectedClient = null;
    currentSiteId  = null;
    updateSaveBtn();
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
    ['site','site_address','basin'].forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });

    if (!site) { basinSel.disabled = true; return; }

    // "+ New site" chosen — lock client, unlock site/address/basin for entry
    if (site === '__new__') {
      basinSel.disabled = true;
      currentSiteId = null;
      // Lock client field only
      const clientEl = document.getElementById('client');
      if (clientEl) { clientEl.readOnly = true; clientEl.classList.add('field-locked'); }
      ['site','site_address','basin'].forEach(f => {
        const el = document.getElementById(f);
        if (el) { el.readOnly = false; el.classList.remove('field-locked'); el.value = ''; }
      });
      updateSaveBtn();
      const btn = document.getElementById('saveSiteBtn');
      if (btn) btn.hidden = false;
      setTimeout(() => document.getElementById('site')?.focus(), 50);
      return;
    }

    const matches = sites.filter(s => s.client === selectedClient && s.site === site);
    if (matches.length === 1) {
      const opt = document.createElement('option');
      opt.value = matches[0].id; opt.textContent = basinLabel(matches[0]);
      basinSel.appendChild(opt);
      const newOpt = document.createElement('option');
      newOpt.value = '__new__'; newOpt.textContent = '+ New basin';
      basinSel.appendChild(newOpt);
      basinSel.value = matches[0].id;
      basinSel.disabled = false;
      applySite(matches[0]);
      return;
    }

    // Multiple basins — add existing ones plus a "+ New basin" option
    matches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id; opt.textContent = basinLabel(b);
      basinSel.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = '__new__'; newOpt.textContent = '+ New basin';
    basinSel.appendChild(newOpt);
    basinSel.disabled = false;
    // Lock client + site, unlock site_address + basin for potential new entry
    document.getElementById('client').value = selectedClient;
    document.getElementById('site').value   = site;
    ['client','site'].forEach(f => {
      const el = document.getElementById(f);
      if (el) { el.readOnly = true; el.classList.add('field-locked'); }
    });
  };

  basinSel.onchange = () => {
    const val = basinSel.value;

    // "+ New basin" chosen — lock client + site, unlock basin for entry
    if (val === '__new__') {
      const siteName = siteSel.value;
      document.getElementById('client').value       = selectedClient;
      document.getElementById('site').value         = siteName;
      ['client','site','site_address'].forEach(f => {
        const el = document.getElementById(f);
        if (el) { el.readOnly = true; el.classList.add('field-locked'); }
      });
      const basinEl = document.getElementById('basin');
      if (basinEl) { basinEl.readOnly = false; basinEl.classList.remove('field-locked'); basinEl.value = ''; basinEl.focus(); }
      currentSiteId = null;
      updateSaveBtn();
      const btn = document.getElementById('saveSiteBtn');
      if (btn) btn.hidden = false;
      return;
    }

    const record = sites.find(s => s.id === val);
    if (record) applySite(record);
  };

}

const LAST_SITE_KEY = 'permit_last_site';

let siteFieldsLocked = false;

function lockPermitBody() {
  const body = document.getElementById('permitBody');
  if (!body) return;
  body.classList.add('permit-body-locked');
  body.setAttribute('inert', '');
}

function unlockPermitBody() {
  const body = document.getElementById('permitBody');
  if (!body) return;
  body.classList.remove('permit-body-locked');
  body.removeAttribute('inert');
}

function lockSiteFields() {
  siteFieldsLocked = true;
  SITE_FIELDS.forEach(f => {
    const el = document.getElementById(f);
    if (el) { el.readOnly = true; el.classList.add('field-locked'); }
  });
  const span = document.getElementById('saveSiteBtnText');
  if (span) span.textContent = 'Update this site';
  const btn = document.getElementById('saveSiteBtn');
  // Only show Update button if a site is actually loaded
  if (btn) btn.hidden = !currentSiteId;
}

function unlockSiteFields() {
  siteFieldsLocked = false;
  SITE_FIELDS.forEach(f => {
    const el = document.getElementById(f);
    if (el) { el.readOnly = false; el.classList.remove('field-locked'); }
  });
  const span = document.getElementById('saveSiteBtnText');
  if (span) span.textContent = currentSiteId ? 'Save changes' : 'Save this site';
  const btn = document.getElementById('saveSiteBtn');
  if (btn) btn.hidden = false;
}

function applySite(site, silent) {
  SITE_FIELDS.forEach(field => {
    const el = document.getElementById(field);
    if (el) el.value = site[field] || '';
  });
  currentSiteId = site.id;
  updateSaveBtn();
  lockSiteFields();
  unlockPermitBody();
  try { localStorage.setItem(LAST_SITE_KEY, site.id); } catch {}
  if (!silent) {
    showToast(`Loaded: ${site.client} – ${site.site}`, 'success');
    scheduleSave();
  }
}

function updateSaveBtn() {
  const span = document.getElementById('saveSiteBtnText');
  if (span) span.textContent = currentSiteId ? 'Update this site' : 'Save this site';
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
    list.innerHTML = filtered.map((e, i) => {
      const date = e.timestamp ? new Date(e.timestamp).toLocaleString() : e.validFrom || '';
      return `<div class="log-entry" data-idx="${i}">
        <div class="log-entry-top">
          <span class="log-entry-client">${esc(e.client)} – ${esc(e.site)}</span>
          <span class="log-entry-date">${date}</span>
        </div>
        <div class="log-entry-detail">Issued by ${esc(e.issuedBy)} → ${esc(e.issuedTo)} · ${esc(e.dischargeTo)}</div>
        <button type="button" class="reissue-btn" data-idx="${i}">↩ Re-issue</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.reissue-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        reissueFromLog(filtered[idx]);
      });
    });
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
    ? sites.filter(s => [s.client, s.site, s.basin, s.site_address]
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
            ${e.basin ? `<span class="site-entry-meta">${esc(e.basin)}</span>` : ''}
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

// ── "Now" button – set Valid From to current date/time ────────────────────

document.getElementById('nowBtn').addEventListener('click', () => {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('valid_from_date').value =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  document.getElementById('valid_from_time').value =
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  scheduleSave();
});

// ── Re-issue from log ──────────────────────────────────────────────────────

async function reissueFromLog(entry) {
  document.getElementById('logModal').hidden = true;

  resetForm();

  // Try to select via cascade picker
  if (_confirmClient && entry.client) {
    _confirmClient(entry.client);
    // Let DOM settle so pickSite gets populated
    await new Promise(r => setTimeout(r, 0));
    const siteSel = document.getElementById('pickSite');
    if (entry.site && siteSel) {
      siteSel.value = entry.site;
      siteSel.dispatchEvent(new Event('change'));
    }
  } else {
    // Fallback: fill text fields directly
    const el = id => document.getElementById(id);
    if (entry.client) el('client').value = entry.client;
    if (entry.site)   el('site').value   = entry.site;
  }

  // Pre-fill discharge to radio
  if (entry.dischargeTo) {
    const radio = document.querySelector(
      `input[name="discharge_to"][value="${CSS.escape(entry.dischargeTo)}"]`
    );
    if (radio) radio.checked = true;
  }

  // Pre-fill issued by name
  if (entry.issuedBy) {
    document.getElementById('issued_by_name').value = entry.issuedBy;
  }

  // Set Valid From to right now
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  document.getElementById('valid_from_date').value =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  document.getElementById('valid_from_time').value =
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  scheduleSave();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  showToast(`Re-issuing for ${entry.client} – ${entry.site}`, '');
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
  // If fields are locked, clicking "Update this site" unlocks them for editing
  if (siteFieldsLocked) {
    unlockSiteFields();
    document.getElementById('client').focus();
    return;
  }

  const client = document.getElementById('client').value.trim();
  const site   = document.getElementById('site').value.trim();
  if (!client || !site) {
    showToast('Enter at least a Client and Site name before saving.', 'error');
    return;
  }
  const body = {};
  SITE_FIELDS.forEach(f => { body[f] = document.getElementById(f)?.value.trim() || ''; });

  const btn = document.getElementById('saveSiteBtn');
  btn.disabled = true;

  try {
    if (currentSiteId) {
      // Update existing site
      await apiFetch('/api/clients/' + currentSiteId, { method: 'PUT', body: JSON.stringify(body) });
      lockSiteFields();
      unlockPermitBody();
      showToast(`Updated: ${client} – ${site}`, 'success');
    } else {
      // Create new site
      const res  = await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(body) });
      const json = await res.json();
      if (json.duplicate) {
        showToast('This site is already saved.', '');
        btn.disabled = false;
        return;
      }
      currentSiteId = json.entry?.id || null;
      unlockPermitBody();
      showToast(`Saved: ${client} – ${site}`, 'success');
    }
    allSites = await apiFetch('/api/clients').then(r => r.json());
    buildCascade(allSites);
    updateSaveBtn();
  } catch {
    showToast('Could not save – check connection.', 'error');
  }
  btn.disabled = false;
});
