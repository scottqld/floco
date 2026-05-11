require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { generatePDF } = require('./generatePDF');

// ── Client/site storage ────────────────────────────────────────────────────
const CLIENTS_PATH = path.join(__dirname, 'data', 'clients.json');

function readClients() {
  try { return JSON.parse(fs.readFileSync(CLIENTS_PATH, 'utf8')); }
  catch { return []; }
}

function writeClients(list) {
  fs.mkdirSync(path.dirname(CLIENTS_PATH), { recursive: true });
  fs.writeFileSync(CLIENTS_PATH, JSON.stringify(list, null, 2));
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));

// Override config.js so local dev uses this server (not the production Worker)
app.get('/config.js', (_req, res) => {
  res.type('js').send('const CONFIG = { API_URL: "" };');
});

app.use(express.static(path.join(__dirname, 'public')));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── Client API ─────────────────────────────────────────────────────────────
app.get('/api/clients', (_req, res) => res.json(readClients()));

app.post('/api/clients', (req, res) => {
  const { client, site, site_address, basin, basin_reference } = req.body;
  if (!client || !site) return res.status(400).json({ error: 'client and site are required' });

  const list = readClients();
  // Skip exact duplicates (same client + site + basin)
  const exists = list.some(c =>
    c.client === client && c.site === site && c.basin === (basin || '')
  );
  if (exists) return res.json({ success: true, duplicate: true });

  const entry = { id: String(Date.now()), client, site, site_address: site_address || '', basin: basin || '', basin_reference: basin_reference || '' };
  list.push(entry);
  writeClients(list);
  res.json({ success: true, entry });
});

app.put('/api/clients/:id', (req, res) => {
  const list = readClients();
  const idx  = list.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  list[idx] = { ...list[idx], ...req.body, id: req.params.id };
  writeClients(list);
  res.json({ success: true, entry: list[idx] });
});

app.delete('/api/clients/:id', (req, res) => {
  writeClients(readClients().filter(c => c.id !== req.params.id));
  res.json({ success: true });
});

// ── Permit submission ───────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const formData = req.body;

    const docBuffer = await generatePDF(formData);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `Permit-to-Discharge-${timestamp}.pdf`;

    const attachments = [
      {
        filename,
        content: docBuffer,
        contentType: 'application/pdf',
      },
    ];

    // Attach additional photos as separate files
    if (formData.additional_photos && formData.additional_photos.length > 0) {
      formData.additional_photos.forEach((photoDataUrl, i) => {
        const match = photoDataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          attachments.push({
            filename: `site-photo-${i + 1}.${match[1]}`,
            content: Buffer.from(match[2], 'base64'),
            contentType: `image/${match[1]}`,
          });
        }
      });
    }

    const issuedBy = formData.issued_by_name || 'Unknown';
    const validFrom = formData.valid_from_date || '';

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: (process.env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean).join(', '),
      subject: `Permit to Discharge – ${issuedBy} – ${validFrom}`,
      text: buildEmailBody(formData),
      attachments,
    });

    res.json({ success: true, message: 'Permit submitted and emailed successfully.' });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

function buildEmailBody(d) {
  return [
    'PERMIT TO DISCHARGE – FRM013',
    '==============================',
    `Client:           ${d.client || ''}`,
    `Site:             ${d.site || ''}`,
    `Site Address:     ${d.site_address || ''}`,
    `Basin:            ${d.basin || ''}`,
    `Basin Reference:  ${d.basin_reference || ''}`,
    '',
    `Discharge To:     ${d.discharge_to || ''}`,
    `Valid From:       ${d.valid_from_date || ''} ${d.valid_from_time || ''}`,
    `Valid To:         ${d.valid_to_date || ''} ${d.valid_to_time || ''}`,
    '',
    'Water Quality – Initial Test',
    `  pH: ${d.initial_test_ph || ''}  NTU: ${d.initial_test_ntu || ''}`,
    'Water Quality – After Treatment',
    `  pH: ${d.after_treatment_ph || ''}  NTU: ${d.after_treatment_ntu || ''}`,
    '',
    `Issued By:  ${d.issued_by_name || ''}`,
    `Issued To:  ${d.issued_to_name || ''}`,
    '',
    `Special Instructions:\n${d.special_instructions || ''}`,
    '',
    `Additional photos attached: ${(d.additional_photos || []).length}`,
    '',
    'The completed permit document is attached.',
  ].join('\n');
}

app.listen(PORT, () => {
  console.log(`Permit to Discharge PWA running at http://localhost:${PORT}`);
  console.log('For mobile access on your local network, use your machine\'s IP address.');
});
