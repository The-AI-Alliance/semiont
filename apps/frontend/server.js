#!/usr/bin/env node
/**
 * Minimal static file server for the Semiont frontend SPA.
 * Serves the Vite-built dist/ directory with SPA fallback (all routes → index.html).
 *
 * Environment variables:
 *   PORT  - port to listen on (default: 3000)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);

// dist/ is a sibling of this file in the published package
const DIST_DIR = path.join(__dirname, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml',
};

function serveFile(res, filePath, ext) {
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  // Strip query string
  const urlPath = req.url.split('?')[0];

  // Security: prevent directory traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(DIST_DIR, safePath);

  const ext = path.extname(filePath).toLowerCase();

  // Try to serve the exact file
  if (ext && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveFile(res, filePath, ext);
    return;
  }

  // SPA fallback: all non-file routes serve index.html
  const indexPath = path.join(DIST_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Frontend not built: index.html not found');
    return;
  }
  serveFile(res, indexPath, '.html');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Semiont frontend listening on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('Frontend server error:', err);
  process.exit(1);
});
