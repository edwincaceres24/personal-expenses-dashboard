#!/usr/bin/env node
/**
 * Local preview server: http://localhost:8080
 * Rebuilds the page from src/ on every request, so edit a file and refresh.
 * Uses fake data from dev/fixtures.js — never touches the real spreadsheet.
 *
 * Try:  /?today=2026-10-01   /?scenario=empty   /?scenario=error:SHEET_ID_MISSING   /?delay=1500
 */
const http = require('http');
const { buildPreviewHtml } = require('./build-preview');

const PORT = Number(process.env.PORT) || 8080;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/') {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const html = buildPreviewHtml({ today: url.searchParams.get('today') || undefined });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(e.stack || e));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Preview with fake data: http://localhost:${PORT}`);
  console.log('Edit files in src/ and refresh. Ctrl+C to stop.');
});
