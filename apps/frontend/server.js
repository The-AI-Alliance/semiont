#!/usr/bin/env node
/**
 * Minimal static file server for the Semiont frontend SPA.
 * Serves the Vite-built dist/ directory with SPA fallback (all routes → index.html),
 * plus the launcher's KB discovery document under /discovery/* — served or 404,
 * NEVER the SPA fallback (a 200 index.html would be indistinguishable from data;
 * see .plans/BROWSER-KB-DISCOVERY.md L2a).
 *
 * Environment variables:
 *   PORT - port to listen on (default: 3000)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/**
 * The /discovery/* prefix: files from the launcher's read-only mount, served
 * or 404 — no SPA fallback. Content-hash ETag + no-cache makes consumer
 * polling a revalidation round-trip (304 when unchanged).
 */
function serveDiscovery(req, res, urlPath, discoveryDir) {
  const rel = urlPath.slice('/discovery'.length).replace(/^\/+/, '');
  if (!rel) {
    notFound(res);
    return;
  }

  // Containment guard: the resolved path must stay inside the mount.
  const resolved = path.resolve(discoveryDir, rel);
  if (!resolved.startsWith(path.resolve(discoveryDir) + path.sep)) {
    notFound(res);
    return;
  }

  let content;
  try {
    content = fs.readFileSync(resolved); // EISDIR / ENOENT → 404
  } catch {
    notFound(res);
    return;
  }

  const etag = '"' + crypto.createHash('sha1').update(content).digest('hex') + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    res.end();
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'ETag': etag,
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}

function createHandler({ distDir, discoveryDir }) {
  return (req, res) => {
    // Strip query string
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/discovery' || urlPath === '/discovery/' || urlPath.startsWith('/discovery/')) {
      serveDiscovery(req, res, urlPath, discoveryDir);
      return;
    }

    // Security: prevent directory traversal
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(distDir, safePath);

    const ext = path.extname(filePath).toLowerCase();

    // Try to serve the exact file
    if (ext && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveFile(res, filePath, ext);
      return;
    }

    // SPA fallback: all non-file routes serve index.html
    const indexPath = path.join(distDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Frontend not built: index.html not found');
      return;
    }
    serveFile(res, indexPath, '.html');
  };
}

module.exports = { createHandler };

if (require.main === module) {
  const PORT = parseInt(process.env.PORT || '3000', 10);

  const server = http.createServer(createHandler({
    // dist/ is a sibling of this file in the published package
    distDir: path.join(__dirname, 'dist'),
    // The launcher's read-only mount (see BROWSER-KB-DISCOVERY L1); absent
    // outside the container, so the prefix just 404s ("absent").
    discoveryDir: '/discovery',
  }));

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Semiont frontend listening on port ${PORT}`);
  });

  server.on('error', (err) => {
    console.error('Frontend server error:', err);
    process.exit(1);
  });
}
