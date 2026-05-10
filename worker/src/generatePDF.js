import PDFDocument from 'pdfkit';
import { LOGO_BASE64 } from './logo.js';

const A4_W = 595.28;
const A4_H = 841.89;
const M    = 50;
const CW   = A4_W - 2 * M;

const BLACK   = '#000000';
const GREY_BG = '#d9d9d9';
const PAD     = 5;

function parsePic(dataUrl) {
  if (!dataUrl || !dataUrl.includes('base64,')) return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  return m ? Buffer.from(m[2], 'base64') : null;
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

function cell(doc, x, y, w, h, text, opts = {}) {
  if (opts.bg) {
    doc.rect(x, y, w, h).fillAndStroke(opts.bg, BLACK);
  } else {
    doc.rect(x, y, w, h).stroke(BLACK);
  }
  if (text != null) {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(opts.size || 9)
       .fillColor(BLACK)
       .text(String(text), x + PAD, y + PAD, { width: w - PAD * 2, lineBreak: !!opts.wrap });
  }
}

function ensurePage(doc, y, needed) {
  if (y + needed > A4_H - M) { doc.addPage(); return M; }
  return y;
}

export async function generatePDF(formData) {
  const logoBuffer = LOGO_BASE64 ? Buffer.from(LOGO_BASE64, 'base64') : null;

  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M, left: M, right: M }, autoFirstPage: true });
    const chunks = [];
    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const validFrom = formatDateAU(formData.valid_from_date, formData.valid_from_time);
    const validTo   = formatDateAU(formData.valid_to_date,   formData.valid_to_time);

    let y = M;

    // ── Logo ──────────────────────────────────────────────────────────────────
    if (logoBuffer) {
      doc.image(logoBuffer, M, y, { width: 130, fit: [130, 80] });
      y += 90;
    }

    // ── Title ─────────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(20).fillColor(BLACK).text('Permit to Discharge', M, y, { width: CW });
    y += 26;

    // ── Note ──────────────────────────────────────────────────────────────────
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(BLACK)
       .text(`(Note: Discharge permit only valid for 5 days, or until rain event prior to ${validFrom}.)`, M, y, { width: CW });
    y += 18;

    // ── Details ───────────────────────────────────────────────────────────────
    const D_LBL = 130;
    [
      ['Client',          formData.client],
      ['Site',            formData.site],
      ['Site Address',    formData.site_address],
      ['Basin',           formData.basin],
      ['Basin Reference', formData.basin_reference],
    ].forEach(([lbl, val]) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK).text(lbl + ':', M, y, { width: D_LBL, lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor(BLACK).text(val || '', M + D_LBL, y, { width: CW - D_LBL, lineBreak: false });
      y += 15;
    });
    y += 6;

    // ── Discharge / Validity ──────────────────────────────────────────────────
    [
      ['Discharge To', formData.discharge_to],
      ['Valid From',   validFrom],
      ['Valid To',     validTo],
    ].forEach(([lbl, val]) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK).text(lbl + ':', M, y, { width: D_LBL, lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor(BLACK).text(val || '', M + D_LBL, y, { width: CW - D_LBL, lineBreak: false });
      y += 15;
    });
    y += 8;

    // ── Water Quality Table ───────────────────────────────────────────────────
    const WQ = [120, 75, 75, CW - 120 - 75 - 75];
    const PHOTO_W  = WQ[3] - PAD * 2;
    const PHOTO_H  = Math.round(PHOTO_W * 3 / 4);
    const DATA_ROW = PHOTO_H + PAD * 2;
    const HDR_ROW  = 20;

    let cx = M;
    ['Reading', 'pH', 'NTU', ''].forEach((h, i) => {
      cell(doc, cx, y, WQ[i], HDR_ROW, h, { bg: GREY_BG, bold: true });
      cx += WQ[i];
    });
    y += HDR_ROW;

    [
      ['Initial Test',    formData.initial_test_ph,    formData.initial_test_ntu,    formData.initial_test_photo],
      ['After Treatment', formData.after_treatment_ph, formData.after_treatment_ntu, formData.after_treatment_photo],
    ].forEach(([lbl, ph, ntu, photo]) => {
      cx = M;
      cell(doc, cx, y, WQ[0], DATA_ROW, lbl);  cx += WQ[0];
      cell(doc, cx, y, WQ[1], DATA_ROW, ph || '');  cx += WQ[1];
      cell(doc, cx, y, WQ[2], DATA_ROW, ntu || ''); cx += WQ[2];
      cell(doc, cx, y, WQ[3], DATA_ROW, null);
      const pic = parsePic(photo);
      if (pic) {
        try { doc.image(pic, cx + PAD, y + PAD, { width: PHOTO_W, height: PHOTO_H, fit: [PHOTO_W, PHOTO_H] }); }
        catch { /* skip bad image */ }
      }
      y += DATA_ROW;
    });
    y += 10;

    // ── Issued By / To ────────────────────────────────────────────────────────
    y = ensurePage(doc, y, 160);
    const ISS_LBL = 120;
    const ISS_VAL = CW - ISS_LBL;
    const ISS_H   = 70;

    cell(doc, M,            y, ISS_LBL, ISS_H, 'Issued By', { bg: GREY_BG, bold: true });
    cell(doc, M + ISS_LBL, y, ISS_VAL, ISS_H, formData.issued_by_name || '');
    const sigByPic = parsePic(formData.issued_by_signature);
    if (sigByPic) {
      try { doc.image(sigByPic, M + ISS_LBL + PAD, y + 18, { width: 120, height: 44, fit: [ISS_VAL - PAD * 2, 44] }); }
      catch { /* skip */ }
    }
    y += ISS_H;

    cell(doc, M,            y, ISS_LBL, ISS_H, 'Issued To', { bg: GREY_BG, bold: true });
    cell(doc, M + ISS_LBL, y, ISS_VAL, ISS_H, formData.issued_to_name || '');
    const sigToPic = parsePic(formData.issued_to_signature);
    if (sigToPic) {
      try { doc.image(sigToPic, M + ISS_LBL + PAD, y + 18, { width: 120, height: 44, fit: [ISS_VAL - PAD * 2, 44] }); }
      catch { /* skip */ }
    }
    y += ISS_H + 10;

    // ── Special Instructions ──────────────────────────────────────────────────
    const siText = formData.special_instructions || '';
    const siInnerH = siText
      ? doc.font('Helvetica').fontSize(9).heightOfString(siText, { width: CW - PAD * 2 })
      : 0;
    const siH = Math.max(40, siInnerH + 24);
    y = ensurePage(doc, y, siH);
    cell(doc, M, y, CW, siH, null);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BLACK).text('Special Instructions:', M + PAD, y + PAD, { width: CW - PAD * 2, lineBreak: false });
    if (siText) {
      doc.font('Helvetica').fontSize(9).fillColor(BLACK).text(siText, M + PAD, y + PAD + 13, { width: CW - PAD * 2 });
    }

    // ── Extra Photos ──────────────────────────────────────────────────────────
    const extras = (formData.additional_photos || []).filter(p => p?.includes('base64,'));
    extras.forEach(photo => {
      doc.addPage();
      const pic = parsePic(photo);
      if (pic) {
        try { doc.image(pic, M, M, { fit: [CW, A4_H - M * 2], align: 'center', valign: 'center' }); }
        catch { /* skip */ }
      }
    });

    doc.end();
  });
}
