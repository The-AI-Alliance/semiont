#!/usr/bin/env node
/**
 * Stage pdf.js's wasm side-files into public/pdfjs/wasm/ under their ORIGINAL
 * names. pdf.js v6 decodes JPEG 2000 / JBIG2 / ICC through these, fetching
 * `wasmUrl + filename` at decode time — so they cannot go through the bundler
 * (which would hash the names) and are not tracked (generated content, same
 * posture as public/messages). main.tsx hands the directory to react-ui via
 * `setPdfWasmUrl`.
 */

const fs = require('fs');
const path = require('path');

// Resolve through node, not a hardcoded path — the monorepo hoists
// pdfjs-dist to the root node_modules.
const sourceDir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm');
const targetDir = path.join(__dirname, '../public/pdfjs/wasm');

fs.mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const file of fs.readdirSync(sourceDir)) {
  fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
  copied++;
}
if (copied === 0) {
  console.error('copy-pdf-wasm: nothing copied from', sourceDir);
  process.exit(1);
}
console.log(`✅ pdf.js wasm staged (${copied} files)`);
