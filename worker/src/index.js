// ── CORS ──────────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
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

    // ── POST /api/auth ────────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/api/auth') {
      const code = request.headers.get('X-Access-Code') || '';
      if (env.ACCESS_CODE && code !== env.ACCESS_CODE) {
        return json({ error: 'Unauthorized' }, 401, env);
      }
      return json({ ok: true }, 200, env);
    }

    // ── Auth gate (all other routes) ──────────────────────────────────────────
    if (env.ACCESS_CODE) {
      const code = request.headers.get('X-Access-Code') || '';
      if (code !== env.ACCESS_CODE) {
        return json({ error: 'Unauthorized' }, 401, env);
      }
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

    // ── DELETE & PUT /api/clients/:id ────────────────────────────────────────
    const clientIdMatch = url.pathname.match(/^\/api\/clients\/([^/]+)$/);

    if (method === 'DELETE' && clientIdMatch) {
      const id   = clientIdMatch[1];
      const list = await readClients(env);
      await writeClients(env, list.filter(c => c.id !== id));
      return json({ success: true }, 200, env);
    }

    if (method === 'PUT' && clientIdMatch) {
      const id   = clientIdMatch[1];
      const body = await request.json();
      const list = await readClients(env);
      const idx  = list.findIndex(c => c.id === id);
      if (idx === -1) return json({ error: 'Not found' }, 404, env);
      list[idx] = { ...list[idx], ...body, id };
      await writeClients(env, list);
      return json({ success: true, entry: list[idx] }, 200, env);
    }

    // ── POST /api/submit ──────────────────────────────────────────────────────
    if (method === 'POST' && url.pathname === '/api/submit') {
      try {
        const formData = await request.json();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await logSubmission(env, formData, timestamp);
        return json({ success: true }, 200, env);
      } catch (err) {
        return json({ success: false, message: err.message }, 500, env);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders(env) });
  },
};
