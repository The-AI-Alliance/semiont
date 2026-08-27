#!/usr/bin/env node

/**
 * Merge react-ui translations into Browser messages
 *
 * This script reads translations from:
 * - packages/react-ui/translations/*.json (react-ui component translations)
 * - apps/browser/messages-source/*.json (Browser-specific translations)
 *
 * And merges them into:
 * - apps/browser/messages/*.json (generated merged output)
 *
 * The messages/ directory is gitignored since it contains generated content.
 */

const fs = require('fs');
const path = require('path');

const REACT_UI_TRANSLATIONS_DIR = path.resolve(__dirname, '../../../packages/react-ui/translations');
const BROWSER_MESSAGES_SOURCE_DIR = path.resolve(__dirname, '../messages-source');
const BROWSER_MESSAGES_OUTPUT_DIR = path.resolve(__dirname, '../messages');
// Public copy served by Vite at /messages/{locale}.json for i18next-http-backend
const BROWSER_MESSAGES_PUBLIC_DIR = path.resolve(__dirname, '../public/messages');

/**
 * Deep merge two objects, with source taking precedence
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (typeof source[key] === 'object' && !Array.isArray(source[key]) && source[key] !== null) {
        result[key] = deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

/**
 * Get all translation files from a directory
 */
function getTranslationFiles(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`Warning: Directory does not exist: ${dir}`);
    return [];
  }

  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => ({
      locale: path.basename(file, '.json'),
      path: path.join(dir, file)
    }));
}

/**
 * Main merge function
 */
function mergeTranslations() {
  // Ensure output directories exist
  if (!fs.existsSync(BROWSER_MESSAGES_OUTPUT_DIR)) {
    fs.mkdirSync(BROWSER_MESSAGES_OUTPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(BROWSER_MESSAGES_PUBLIC_DIR)) {
    fs.mkdirSync(BROWSER_MESSAGES_PUBLIC_DIR, { recursive: true });
  }

  // Get all react-ui translation files
  const reactUIFiles = getTranslationFiles(REACT_UI_TRANSLATIONS_DIR);

  // Get all Browser source message files
  const browserFiles = getTranslationFiles(BROWSER_MESSAGES_SOURCE_DIR);

  // Create a map of existing Browser source messages
  const browserMessages = new Map();
  for (const file of browserFiles) {
    const content = JSON.parse(fs.readFileSync(file.path, 'utf-8'));
    browserMessages.set(file.locale, content);
  }

  let mergedCount = 0;
  let createdCount = 0;

  // Merge react-ui translations with Browser messages and write to output
  for (const reactUIFile of reactUIFiles) {
    const reactUIContent = JSON.parse(fs.readFileSync(reactUIFile.path, 'utf-8'));
    const outputPath = path.join(BROWSER_MESSAGES_OUTPUT_DIR, `${reactUIFile.locale}.json`);

    if (browserMessages.has(reactUIFile.locale)) {
      // Merge with existing Browser source messages (Browser takes precedence)
      const browserContent = browserMessages.get(reactUIFile.locale);
      const merged = deepMerge(reactUIContent, browserContent);

      const content = JSON.stringify(merged, null, 2) + '\n';
      // Write merged content to output directory
      fs.writeFileSync(outputPath, content, 'utf-8');
      // Also write to public/messages/ for Vite / i18next-http-backend
      fs.writeFileSync(path.join(BROWSER_MESSAGES_PUBLIC_DIR, `${reactUIFile.locale}.json`), content, 'utf-8');
      mergedCount++;
    } else {
      const content = JSON.stringify(reactUIContent, null, 2) + '\n';
      // Create output file from react-ui translations only
      fs.writeFileSync(outputPath, content, 'utf-8');
      // Also write to public/messages/ for Vite / i18next-http-backend
      fs.writeFileSync(path.join(BROWSER_MESSAGES_PUBLIC_DIR, `${reactUIFile.locale}.json`), content, 'utf-8');
      createdCount++;
    }
  }

  console.log(`✅ Merged ${mergedCount + createdCount} translation locales`);
}

// Run the merge
try {
  mergeTranslations();
  process.exit(0);
} catch (error) {
  console.error('❌ Error merging translations:', error);
  process.exit(1);
}
