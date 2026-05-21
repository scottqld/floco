# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Floco Permit to Discharge — a mobile-first PWA (FRM013) for issuing construction site water discharge permits. Users fill a form, sign on-screen, attach photos, and submit; a PDF is generated and emailed via Resend. Saved sites/clients are stored in Cloudflare KV.

**Live app:** https://scottqld.github.io/floco/  
**Worker API:** https://floco-permits.scottsurf.workers.dev

## Architecture

There are two separate runtimes with separate dependencies:

### 1. Local dev server (`server.js`)
- Express + nodemailer (SMTP via `.env`)
- Serves `public/` as static files
- Overrides `/config.js` to set `API_URL: ""` so the frontend hits this server instead of the Worker
- Client/site data stored in `data/clients.json`
- PDF generation via `generatePDF.js` (root level, uses **pdfkit**)

### 2. Cloudflare Worker (`worker/`)
- Handles all API routes in production
- PDF generation via `worker/src/generatePDF.js` (uses **pdf-lib** — pdfkit uses `__dirname` which doesn't exist in Workers)
- Client/site data stored in Cloudflare KV under key `"clients"` (JSON array)
- Submission log stored in KV under key `"log"` (capped at 500 entries)
- Email via Resend REST API
- Auth gate: `X-Access-Code` header checked against `ACCESS_CODE` secret on all routes except `/api/auth`

### Frontend (`public/`)
- Vanilla JS, no build step — `app.js` is a single ~1200-line file
- `config.js` controls which API the frontend talks to (empty string = same-origin local dev, full URL = Worker)
- Offline queue in `localStorage` (`permit_queue`) — permits are queued when offline and flushed on reconnect
- Draft auto-save in `localStorage` (`permit_draft`)
- Cascade pickers: Client → Site → Basin (all sourced from `/api/clients`)
- `currentSiteId` tracks whether a loaded site is new (POST) or existing (PUT) when "Save/Update this site" is clicked

## Key Commands

### Local dev
```bash
node server.js          # starts Express on :3000
```
Requires `.env` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `EMAIL_TO`.

### Deploy Worker
```bash
cd worker
node build-logo.js                              # embeds assets/logo.jpg → src/logo.js (must run before deploy)
node node_modules/wrangler/bin/wrangler.js deploy
```
`npx` is blocked by PowerShell execution policy — always invoke wrangler via `node node_modules/wrangler/bin/wrangler.js`.

### Worker secrets (set once, stored in Cloudflare)
```bash
node node_modules/wrangler/bin/wrangler.js secret put RESEND_API_KEY
node node_modules/wrangler/bin/wrangler.js secret put EMAIL_TO
node node_modules/wrangler/bin/wrangler.js secret put EMAIL_FROM
node node_modules/wrangler/bin/wrangler.js secret put ACCESS_CODE
```

### Preview (Claude Code)
The `.claude/launch.json` config (`floco-dev`) runs `node server.js` on port 3000.

## Important Constraints

- **`worker/src/logo.js` is generated**, not committed. Always run `node build-logo.js` before deploying the worker.
- **Two separate `generatePDF.js` files**: root (pdfkit, Node.js only) and `worker/src/` (pdf-lib, Workers-compatible). Changes to PDF layout must be made in `worker/src/generatePDF.js` for production.
- **`worker/src/generateDocument.js`** is a docx alternative — currently unused by the worker (index.js imports generatePDF).
- The frontend's `public/config.js` sets the production Worker URL and is committed — update it if the Worker URL changes.
- GitHub Pages serves the `public/` directory; the Worker handles all `/api/*` routes. CORS is set to `https://scottqld.github.io` via the `ALLOWED_ORIGIN` env var in `worker/wrangler.jsonc`.

---

## Coding Guidelines

**Think Before Coding** — State assumptions explicitly. If multiple interpretations exist, present them. If something is unclear, ask before implementing.

**Simplicity First** — Minimum code that solves the problem. No abstractions for single-use code, no unrequested flexibility.

**Surgical Changes** — Touch only what you must. Don't improve adjacent code. Match existing style. Every changed line should trace directly to the request.
