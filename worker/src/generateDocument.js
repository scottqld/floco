import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, AlignmentType, BorderStyle, WidthType, ShadingType,
  VerticalAlign, HeightRule, PageBreak,
} from 'docx';
import { LOGO_BASE64 } from './logo.js';

const PAGE_W    = 11906;
const MARGIN    = 1080;
const CONTENT_W = PAGE_W - 2 * MARGIN;

const SOLID = (color = '000000') => ({ style: BorderStyle.SINGLE, size: 4, color });
const NONE  = () => ({ style: BorderStyle.NIL, size: 0, color: 'auto' });
const ALL   = () => ({ top: SOLID(), bottom: SOLID(), left: SOLID(), right: SOLID() });
const NONE_ALL = () => ({ top: NONE(), bottom: NONE(), left: NONE(), right: NONE() });

function run(text, opts = {}) {
  return new TextRun({
    text: String(text ?? ''),
    font: 'Arial',
    size: opts.size ?? 20,
    bold:    opts.bold    ?? false,
    italics: opts.italic  ?? false,
    color:   opts.color,
  });
}

function para(children, opts = {}) {
  const kids = Array.isArray(children) ? children : [children];
  return new Paragraph({
    alignment: opts.align ?? AlignmentType.LEFT,
    spacing:   opts.spacing ?? {},
    children:  kids,
  });
}

function formatDateAU(dateStr, timeStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  let result = `${d}/${m}/${y}`;
  if (timeStr) {
    const [hh, mm] = timeStr.split(':');
    const h = parseInt(hh, 10);
    result += ` ${h % 12 || 12}:${mm}:00 ${h >= 12 ? 'pm' : 'am'}`;
  }
  return result;
}

function photoRun(dataUrl, width, height) {
  if (!dataUrl || !dataUrl.includes('base64,')) return null;
  const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return null;
  const type = m[1] === 'jpeg' ? 'jpg' : m[1];
  return new ImageRun({ type, data: Buffer.from(m[2], 'base64'), transformation: { width, height } });
}

const DET_LABEL = 2000;
const DET_VALUE = CONTENT_W - DET_LABEL;

function detailRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: DET_LABEL, type: WidthType.DXA },
        borders: NONE_ALL(),
        margins: { top: 40, bottom: 40, left: 0, right: 60 },
        children: [para(run(label + ':', { bold: true }))],
      }),
      new TableCell({
        width: { size: DET_VALUE, type: WidthType.DXA },
        borders: NONE_ALL(),
        margins: { top: 40, bottom: 40, left: 0, right: 0 },
        children: [para(run(value))],
      }),
    ],
  });
}

export async function generatePermitDocument(formData) {
  const logoBuffer = LOGO_BASE64 ? Buffer.from(LOGO_BASE64, 'base64') : null;

  const validFrom = formatDateAU(formData.valid_from_date, formData.valid_from_time);
  const validTo   = formatDateAU(formData.valid_to_date,   formData.valid_to_time);

  const WQ_READ  = 2000;
  const WQ_PH    = 1200;
  const WQ_NTU   = 1200;
  const WQ_PHOTO = CONTENT_W - WQ_READ - WQ_PH - WQ_NTU;

  const PHOTO_PX_W = 260;
  const PHOTO_PX_H = 195;
  const ROW_H_DXA  = PHOTO_PX_H * 15;

  const GREY = { fill: 'd9d9d9', type: ShadingType.CLEAR };

  const wqHeaderRow = new TableRow({
    children: [
      new TableCell({ width: { size: WQ_READ,  type: WidthType.DXA }, borders: ALL(), shading: GREY, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run('Reading', { bold: true }))] }),
      new TableCell({ width: { size: WQ_PH,    type: WidthType.DXA }, borders: ALL(), shading: GREY, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run('ph',      { bold: true }))] }),
      new TableCell({ width: { size: WQ_NTU,   type: WidthType.DXA }, borders: ALL(), shading: GREY, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run('NTU',     { bold: true }))] }),
      new TableCell({ width: { size: WQ_PHOTO, type: WidthType.DXA }, borders: ALL(), shading: GREY, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run(''))] }),
    ],
  });

  function wqDataRow(label, ph, ntu, photoDataUrl) {
    const img = photoRun(photoDataUrl, PHOTO_PX_W, PHOTO_PX_H);
    return new TableRow({
      height: { value: ROW_H_DXA, rule: HeightRule.AT_LEAST },
      children: [
        new TableCell({ width: { size: WQ_READ,  type: WidthType.DXA }, borders: ALL(), verticalAlign: VerticalAlign.TOP, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run(label))] }),
        new TableCell({ width: { size: WQ_PH,    type: WidthType.DXA }, borders: ALL(), verticalAlign: VerticalAlign.TOP, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run(ph ?? ''))] }),
        new TableCell({ width: { size: WQ_NTU,   type: WidthType.DXA }, borders: ALL(), verticalAlign: VerticalAlign.TOP, margins: { top: 60, bottom: 60, left: 80, right: 80 }, children: [para(run(ntu ?? ''))] }),
        new TableCell({ width: { size: WQ_PHOTO, type: WidthType.DXA }, borders: ALL(), margins: { top: 40, bottom: 40, left: 40, right: 40 }, children: [new Paragraph({ children: img ? [img] : [run('')] })] }),
      ],
    });
  }

  const wqTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [WQ_READ, WQ_PH, WQ_NTU, WQ_PHOTO],
    rows: [
      wqHeaderRow,
      wqDataRow('Initial Test',     formData.initial_test_ph,    formData.initial_test_ntu,    formData.initial_test_photo),
      wqDataRow('After\nTreatment', formData.after_treatment_ph, formData.after_treatment_ntu, formData.after_treatment_photo),
    ],
  });

  const ISS_LABEL = 2000;
  const ISS_VALUE = CONTENT_W - ISS_LABEL;

  const sigImg = photoRun(formData.issued_by_signature, 160, 60);
  const issuedByChildren = [
    para(run(formData.issued_by_name ?? '')),
    new Paragraph({ children: sigImg ? [sigImg] : [run('')] }),
  ];

  const issuedTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [ISS_LABEL, ISS_VALUE],
    rows: [
      new TableRow({
        height: { value: 1400, rule: HeightRule.AT_LEAST },
        children: [
          new TableCell({ width: { size: ISS_LABEL, type: WidthType.DXA }, borders: ALL(), shading: GREY, margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: [para(run('Issued By', { bold: true }))] }),
          new TableCell({ width: { size: ISS_VALUE, type: WidthType.DXA }, borders: ALL(), margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: issuedByChildren }),
        ],
      }),
      new TableRow({
        children: [
          new TableCell({ width: { size: ISS_LABEL, type: WidthType.DXA }, borders: ALL(), shading: GREY, margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: [para(run('Issued To', { bold: true }))] }),
          new TableCell({ width: { size: ISS_VALUE, type: WidthType.DXA }, borders: ALL(), margins: { top: 80, bottom: 80, left: 80, right: 80 }, children: [para(run(formData.issued_to_name ?? ''))] }),
        ],
      }),
    ],
  });

  const siLines = (formData.special_instructions ?? '').split('\n').filter(l => l.trim());
  const siTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_W, type: WidthType.DXA },
            borders: ALL(),
            margins: { top: 80, bottom: 80, left: 80, right: 80 },
            children: [
              para(run('Special Instructions:', { bold: true })),
              ...(siLines.length ? siLines.map(l => para(run(l))) : [para(run(''))]),
            ],
          }),
        ],
      }),
    ],
  });

  const detailsTable = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [DET_LABEL, DET_VALUE],
    borders: { top: NONE(), bottom: NONE(), left: NONE(), right: NONE(), insideH: NONE(), insideV: NONE() },
    rows: [
      detailRow('Client',          formData.client),
      detailRow('Site',            formData.site),
      detailRow('Site Address',    formData.site_address),
      detailRow('Basin',           formData.basin),
      detailRow('Basin Reference', formData.basin_reference),
    ],
  });

  const extraPhotos = (formData.additional_photos ?? []).filter(p => p?.includes('base64,'));
  const extraPhotoParas = extraPhotos.flatMap(photo => {
    const img = photoRun(photo, 420, 315);
    return img
      ? [new Paragraph({ children: [new PageBreak()] }), new Paragraph({ alignment: AlignmentType.CENTER, children: [img] })]
      : [];
  });

  const sp = (after) => ({ spacing: { after } });

  const body = [
    ...(logoBuffer
      ? [new Paragraph({ children: [new ImageRun({ type: 'jpg', data: logoBuffer, transformation: { width: 190, height: 124 } })], spacing: { after: 300 } })]
      : []),

    para(run('Permit to Discharge', { bold: true, size: 40 }), sp(160)),

    para(
      run(`(Note: Discharge permit only valid for 5 days, or until rain event prior to ${validFrom}.)`, { italic: true, size: 16 }),
      sp(280)
    ),

    detailsTable,

    para(run(''), sp(200)),

    para([run('Discharge To:', { bold: true }), run('  ' + (formData.discharge_to ?? ''))]),
    para([run('Valid From:',   { bold: true }), run('  ' + validFrom)]),
    para([run('Valid To:',     { bold: true }), run('  ' + validTo)], sp(200)),

    wqTable,

    para(run(''), sp(160)),

    issuedTable,

    para(run(''), sp(100)),

    siTable,

    ...extraPhotoParas,
  ];

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_W, height: 16838 },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      children: body,
    }],
  });

  return Packer.toBuffer(doc);
}
