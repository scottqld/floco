'use strict';

// API base URL — empty for local dev, set via config.js for production
const API = (typeof CONFIG !== 'undefined' && CONFIG.API_URL) ? CONFIG.API_URL : '';

// ── Service Worker ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
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
    saveOperatorName();
    clearDraft();
    showToast('No connection — permit saved and will send when back online.', '');
    setTimeout(() => { if (confirm('Permit queued. Reset for a new permit?')) { resetForm(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 1500);
    return;
  }

  submitBtn.disabled = true;
  loadingOverlay.hidden = false;

  try {
    const res  = await fetch(`${API}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectData()),
    });
    const json = await res.json();

    if (json.success) {
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
      const res  = await fetch(`${API}/api/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
loadDraft();    // restore any saved draft (overwrites defaults if draft exists)
prefillOperatorName();
initClients();  // load saved sites from server

// ═══════════════════════════════════════════════════════════════════════════
// SAVED SITES (CLIENT MANAGEMENT)
// ═══════════════════════════════════════════════════════════════════════════

const SITE_FIELDS = ['client','site','site_address','basin','basin_reference'];

async function initClients() {
  try {
    const sites = await fetch(`${API}/api/clients`).then(r => r.json());
    renderSiteChips(sites);
  } catch { /* offline – skip */ }
}

function renderSiteChips(sites) {
  const container = document.getElementById('siteChips');
  const noMsg     = document.getElementById('noSitesMsg');

  // Remove existing chips (keep the no-sites message node)
  container.querySelectorAll('.site-chip').forEach(el => el.remove());

  if (!sites || sites.length === 0) {
    noMsg.hidden = false;
    return;
  }
  noMsg.hidden = true;

  sites.forEach(site => {
    const chip = document.createElement('div');
    chip.className = 'site-chip';

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'site-chip-label';
    selectBtn.textContent = site.site
      ? `${site.client} – ${site.site}`
      : site.client;
    selectBtn.title = [site.site_address, site.basin].filter(Boolean).join(' | ');
    selectBtn.addEventListener('click', () => applySite(site));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'site-chip-delete';
    delBtn.textContent = '×';
    delBtn.title = 'Remove saved site';
    delBtn.addEventListener('click', () => deleteSite(site.id));

    chip.appendChild(selectBtn);
    chip.appendChild(delBtn);
    container.appendChild(chip);
  });
}

function applySite(site) {
  SITE_FIELDS.forEach(field => {
    const el = document.getElementById(field);
    if (el) el.value = site[field] || '';
  });
  showToast(`Loaded: ${site.client} – ${site.site}`, 'success');
  scheduleSave();
}

async function deleteSite(id) {
  if (!confirm('Remove this saved site?')) return;
  try {
    await fetch(`${API}/api/clients/${id}`, { method: 'DELETE' });
    const sites = await fetch(`${API}/api/clients`).then(r => r.json());
    renderSiteChips(sites);
  } catch {
    showToast('Could not remove site – check connection.', 'error');
  }
}

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
    const res = await fetch(`${API}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.duplicate) {
      showToast('This site is already saved.', '');
    } else {
      showToast(`Saved: ${client} – ${site}`, 'success');
      const sites = await fetch(`${API}/api/clients`).then(r => r.json());
      renderSiteChips(sites);
    }
  } catch {
    showToast('Could not save – check connection.', 'error');
  }
});
