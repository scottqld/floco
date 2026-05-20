import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { LOGO_BASE64 } from './logo.js';

const A4_W = 595.28;
const A4_H = 841.89;
const M    = 50;
const CW   = A4_W - 2 * M;
const PAD  = 5;

const C_BLACK = rgb(0, 0, 0);
const C_GREY  = rgb(0.851, 0.851, 0.851); // #d9d9d9

function parsePic(dataUrl) {
  if (!dataUrl || !dataUrl.includes('base64,')) return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  return m ? { type: m[1], data: new Uint8Array(Buffer.from(m[2], 'base64')) } : null;
}

function formatDateAU(dateStr, timeStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-');
  let r = `${d}/${mo}/${y}`;
  if (timeStr) {
    const [hh, mm] = timeStr.split(':');
    const h = parseInt(hh, 10);
    r += ` ${h % 12 || 12}:${mm} ${h >= 12 ? 'pm' : 'am'}`;
  }
  return r;
}

// Wrap text into lines that fit within maxWidth using the given font/size
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    const words = paragraph.split(' ');
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

export async function generatePDF(formData) {
  const pdfDoc = await PDFDocument.create();
  const fReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fItal = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const validFrom = formatDateAU(formData.valid_from_date, formData.valid_from_time);
  const validTo   = formatDateAU(formData.valid_to_date,   formData.valid_to_time);

  // ── Page helpers ──────────────────────────────────────────────────────────

  function addPage() {
    return pdfDoc.addPage([A4_W, A4_H]);
  }

  // pdf-lib y=0 is bottom; convert top-down y + element height → pdf-lib y
  function pdfY(topY, h = 0) {
    return A4_H - topY - h;
  }

  function drawRect(page, x, topY, w, h, { fill } = {}) {
    page.drawRectangle({
      x, y: pdfY(topY, h), width: w, height: h,
      color:       fill || undefined,
      borderColor: C_BLACK,
      borderWidth: 0.5,
    });
  }

  function drawText(page, text, x, topY, { font = fReg, size = 9, maxWidth } = {}) {
    page.drawText(String(text ?? ''), {
      x,
      y: pdfY(topY, size) + 1,   // +1 aligns baseline nicely
      font,
      size,
      color: C_BLACK,
      maxWidth,
    });
  }

  function cell(page, x, topY, w, h, text, { bg, bold, size = 9 } = {}) {
    drawRect(page, x, topY, w, h, { fill: bg });
    if (text != null) {
      drawText(page, text, x + PAD, topY + PAD, {
        font: bold ? fBold : fReg,
        size,
        maxWidth: w - PAD * 2,
      });
    }
  }

  async function embedImage(pdfDoc, pic) {
    try {
      if (pic.type === 'png') return await pdfDoc.embedPng(pic.data);
      return await pdfDoc.embedJpg(pic.data);
    } catch { return null; }
  }

  // ── Page 1 ────────────────────────────────────────────────────────────────

  let page = addPage();
  let y = M;

  // Logo
  if (LOGO_BASE64) {
    try {
      const logoData = new Uint8Array(Buffer.from(LOGO_BASE64, 'base64'));
      const logoImg  = await pdfDoc.embedJpg(logoData);
      const dims     = logoImg.scaleToFit(130, 80);
      page.drawImage(logoImg, { x: M, y: pdfY(y, dims.height), width: dims.width, height: dims.height });
      y += dims.height + 10;
    } catch { y += 90; }
  }

  // Title (centred)
  const titleText = 'Permit to Discharge';
  const titleW    = fBold.widthOfTextAtSize(titleText, 20);
  drawText(page, titleText, M + (CW - titleW) / 2, y, { font: fBold, size: 20 });
  y += 26;

  // Note
  const noteText = `(Note: Discharge permit only valid for 5 days, or until rain event prior to ${validFrom}.)`;
  const noteLines = wrapText(noteText, fItal, 9, CW);
  noteLines.forEach(line => {
    drawText(page, line, M, y, { font: fItal, size: 9 });
    y += 12;
  });
  y += 6;

  // Details
  const D_LBL = 130;
  [
    ['Client',          formData.client],
    ['Site',            formData.site],
    ['Site Address',    formData.site_address],
    ['Basin',           formData.basin],
    ['Basin Reference', formData.basin_reference],
  ].forEach(([lbl, val]) => {
    drawText(page, lbl + ':', M, y, { font: fBold, size: 10 });
    drawText(page, val || '', M + D_LBL, y, { size: 10, maxWidth: CW - D_LBL });
    y += 15;
  });
  y += 6;

  // Discharge / Validity
  [
    ['Discharge To', formData.discharge_to],
    ['Valid From',   validFrom],
    ['Valid To',     validTo],
  ].forEach(([lbl, val]) => {
    drawText(page, lbl + ':', M, y, { font: fBold, size: 10 });
    drawText(page, val || '', M + D_LBL, y, { size: 10, maxWidth: CW - D_LBL });
    y += 15;
  });
  y += 8;

  // Water Quality table
  const WQ = [120, 75, 75, CW - 120 - 75 - 75];
  const PHOTO_W  = WQ[3] - PAD * 2;
  const PHOTO_H  = Math.round(PHOTO_W * 3 / 4);
  const DATA_ROW = PHOTO_H + PAD * 2;
  const HDR_ROW  = 20;

  let cx = M;
  ['Reading', 'pH', 'NTU', ''].forEach((h, i) => {
    cell(page, cx, y, WQ[i], HDR_ROW, h, { bg: C_GREY, bold: true });
    cx += WQ[i];
  });
  y += HDR_ROW;

  for (const [lbl, ph, ntu, photo] of [
    ['Initial Test',    formData.initial_test_ph,    formData.initial_test_ntu,    formData.initial_test_photo],
    ['After Treatment', formData.after_treatment_ph, formData.after_treatment_ntu, formData.after_treatment_photo],
  ]) {
    cx = M;
    cell(page, cx, y, WQ[0], DATA_ROW, lbl);  cx += WQ[0];
    cell(page, cx, y, WQ[1], DATA_ROW, ph || '');  cx += WQ[1];
    cell(page, cx, y, WQ[2], DATA_ROW, ntu || ''); cx += WQ[2];
    cell(page, cx, y, WQ[3], DATA_ROW, null);

    const pic = parsePic(photo);
    if (pic) {
      const img = await embedImage(pdfDoc, pic);
      if (img) {
        const dims = img.scaleToFit(PHOTO_W, PHOTO_H);
        page.drawImage(img, { x: cx + PAD, y: pdfY(y + PAD, dims.height), width: dims.width, height: dims.height });
      }
    }
    cx += WQ[3];
    y += DATA_ROW;
  }
  y += 10;

  // Issued By / To
  if (y + 160 > A4_H - M) { page = addPage(); y = M; }

  const ISS_LBL = 120;
  const ISS_VAL = CW - ISS_LBL;
  const ISS_H   = 70;

  cell(page, M, y, ISS_LBL, ISS_H, 'Issued By', { bg: C_GREY, bold: true });
  cell(page, M + ISS_LBL, y, ISS_VAL, ISS_H, formData.issued_by_name || '');
  const sigByPic = parsePic(formData.issued_by_signature);
  if (sigByPic) {
    const img = await embedImage(pdfDoc, sigByPic);
    if (img) {
      const dims = img.scaleToFit(ISS_VAL - PAD * 2, 44);
      page.drawImage(img, { x: M + ISS_LBL + PAD, y: pdfY(y + 18, dims.height), width: dims.width, height: dims.height });
    }
  }
  y += ISS_H;

  cell(page, M, y, ISS_LBL, ISS_H, 'Issued To', { bg: C_GREY, bold: true });
  cell(page, M + ISS_LBL, y, ISS_VAL, ISS_H, formData.issued_to_name || '');
  const sigToPic = parsePic(formData.issued_to_signature);
  if (sigToPic) {
    const img = await embedImage(pdfDoc, sigToPic);
    if (img) {
      const dims = img.scaleToFit(ISS_VAL - PAD * 2, 44);
      page.drawImage(img, { x: M + ISS_LBL + PAD, y: pdfY(y + 18, dims.height), width: dims.width, height: dims.height });
    }
  }
  y += ISS_H + 10;

  // Special Instructions
  const siText = formData.special_instructions || '';
  const siLines = siText ? wrapText(siText, fReg, 9, CW - PAD * 2) : [];
  const LINE_H = 11;
  const siH = Math.max(40, siLines.length * LINE_H + 24);

  if (y + siH > A4_H - M) { page = addPage(); y = M; }

  drawRect(page, M, y, CW, siH);
  drawText(page, 'Special Instructions:', M + PAD, y + PAD, { font: fBold, size: 9 });
  siLines.forEach((line, i) => {
    drawText(page, line, M + PAD, y + PAD + 13 + i * LINE_H, { size: 9 });
  });

  // Extra photos
  const extras = (formData.additional_photos || []).filter(p => p?.includes('base64,'));
  for (const photo of extras) {
    const pic = parsePic(photo);
    if (!pic) continue;
    const img = await embedImage(pdfDoc, pic);
    if (!img) continue;
    const extraPage = addPage();
    const dims = img.scaleToFit(CW, A4_H - M * 2);
    extraPage.drawImage(img, {
      x: M + (CW - dims.width) / 2,
      y: M + (A4_H - M * 2 - dims.height) / 2,
      width: dims.width,
      height: dims.height,
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
