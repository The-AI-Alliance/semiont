#!/usr/bin/env node
/**
 * Copy favicon assets from @semiont/react-ui to public directory
 * This ensures we don't duplicate assets in version control
 */

const fs = require('fs');
const path = require('path');

const sourceDir = path.join(__dirname, '../../../packages/react-ui/public/favicons');
const targetDir = path.join(__dirname, '../public/favicons');

// Ensure target directory exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// List of favicon files to copy
const faviconFiles = [
  'favicon.ico',
  'favicon.svg',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-48x48.png',
  'favicon-64x64.png',
  'favicon-96x96.png',
  'favicon-128x128.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'site.webmanifest'
];

let copiedCount = 0;
let missingCount = 0;

faviconFiles.forEach(file => {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);

  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    copiedCount++;
  } else {
    console.warn(`  ⚠ Source file not found: ${file}`);
    missingCount++;
  }
});

if (missingCount === 0) {
  console.log(`✅ Copied ${copiedCount} favicon assets`);
} else {
  console.log(`✅ Copied ${copiedCount} favicon assets (${missingCount} missing)`);
}