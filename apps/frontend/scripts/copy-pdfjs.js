#!/usr/bin/env node
/**
 * Copy PDF.js library files to public directory
 *
 * Downloads PDF.js from CDN and stages in public/pdfjs directory.
 * This avoids CSP issues and webpack bundling problems.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PDFJS_VERSION = '4.0.379';
const targetDir = path.join(__dirname, '../public/pdfjs');

// Ensure target directory exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Files to download from CDN
const pdfjsFiles = [
  {
    name: 'pdf.min.mjs',
    url: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.mjs`
  },
  {
    name: 'pdf.worker.min.mjs',
    url: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`
  }
];

console.log(`Downloading PDF.js v${PDFJS_VERSION} library files...`);

/**
 * Download a file from URL to destination
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      } else if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      } else {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Failed to download: ${response.statusCode}`));
      }
    }).on('error', (err) => {
      file.close();
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/**
 * Download all PDF.js files
 */
async function downloadAllFiles() {
  for (const fileInfo of pdfjsFiles) {
    const targetPath = path.join(targetDir, fileInfo.name);

    // Skip if file already exists
    if (fs.existsSync(targetPath)) {
      console.log(`  ✓ Already exists: ${fileInfo.name}`);
      continue;
    }

    try {
      await downloadFile(fileInfo.url, targetPath);
      console.log(`  ✓ Downloaded ${fileInfo.name}`);
    } catch (err) {
      console.error(`  ✗ Failed to download ${fileInfo.name}: ${err.message}`);
      process.exit(1);
    }
  }
}

downloadAllFiles()
  .then(() => {
    console.log('PDF.js library files ready!');
  })
  .catch((err) => {
    console.error('Failed to download PDF.js files:', err);
    process.exit(1);
  });
