import { generatePDF } from './generatePDF.js';

// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status = 200, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

// ── KV helpers (all clients stored as a JSON array under key "clients") ────────

async function readClients(env) {
  const raw = await env.CLIENTS_KV.get('clients');
  return raw ? JSON.parse(raw) : [];
}

async function writeClients(env, list) {
  await env.CLIENTS_KV.put('clients', JSON.stringify(list));
}

// ── Email body ─────────────────────────────────────────────────────────────────

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

// ── Submission log ─────────────────────────────────────────────────────────────

async function logSubmission(env, d, timestamp) {
  try {
    const raw  = await env.CLIENTS_KV.get('log');
    const log  = raw ? JSON.parse(raw) : [];
    log.unshift({
      id:          timestamp,
      timestamp:   new Date().toISOString(),
      client:      d.client      || '',
      site:        d.site        || '',
      issuedBy:    d.issued_by_name  || '',
      issuedTo:    d.issued_to_name  || '',
      validFrom:   d.valid_from_date || '',
      dischargeTo: d.discharge_to   || '',
    });
    if (log.length > 500) log.splice(500);
    await env.CLIENTS_KV.put('log', JSON.stringify(log));
  } catch { /* non-fatal */ }
}

// ── Main handler ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // ── GET /api/log ──────────────────────────────────────────────────────────
    if (method === 'GET' && url.pathname === '/api/log') {
      const raw = await env.CLIENTS_KV.get('log');
      return json(raw ? JSON.parse(raw) : [], 200, env);
    }

    // ── GET /api/clients ──────────────────────────────────────────────────────
    if (method === 'GET' && url.pathname === '/api/clients') {
      const list = await readClients(env);
      return json(list, 200, env);
    }

    // ── POST /api/clients ─────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/api/clients') {
      const { client, site, site_address, basin, basin_reference } = await request.json();
      if (!client || !site) return json({ error: 'client and site are required' }, 400, env);

      const list = await readClients(env);
      const exists = list.some(c =>
        c.client === client && c.site === site && c.basin === (basin || '')
      );
      if (exists) return json({ success: true, duplicate: true }, 200, env);

      const entry = {
        id: String(Date.now()),
        client,
        site,
        site_address: site_address || '',
        basin: basin || '',
        basin_reference: basin_reference || '',
      };
      list.push(entry);
      await writeClients(env, list);
      return json({ success: true, entry }, 200, env);
    }

    // ── DELETE /api/clients/:id ───────────────────────────────────────────────
    const deleteMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      const id   = deleteMatch[1];
      const list = await readClients(env);
      await writeClients(env, list.filter(c => c.id !== id));
      return json({ success: true }, 200, env);
    }

    // ── POST /api/submit ──────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/api/submit') {
      try {
        const formData = await request.json();

        const docBuffer = await generatePDF(formData);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename  = `Permit-to-Discharge-${timestamp}.pdf`;

        const attachments = [
          {
            filename,
            content: docBuffer.toString('base64'),
          },
        ];

        if (Array.isArray(formData.additional_photos)) {
          formData.additional_photos.forEach((photoDataUrl, i) => {
            const m = photoDataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (m) {
              attachments.push({
                filename: `site-photo-${i + 1}.${m[1]}`,
                content:  m[2],
              });
            }
          });
        }

        const issuedBy  = formData.issued_by_name  || 'Unknown';
        const validFrom = formData.valid_from_date  || '';
        const toList    = (env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);

        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:        env.EMAIL_FROM,
            to:          toList,
            subject:     `Permit to Discharge – ${issuedBy} – ${validFrom}`,
            text:        buildEmailBody(formData),
            attachments,
          }),
        });

        if (!resendRes.ok) {
          const errText = await resendRes.text();
          throw new Error(`Resend error ${resendRes.status}: ${errText}`);
        }

        await logSubmission(env, formData, timestamp);

        return json({ success: true, message: 'Permit submitted and emailed successfully.' }, 200, env);
      } catch (err) {
        console.error('Submit error:', err);
        return json({ success: false, message: err.message }, 500, env);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders(env) });
  },
};
