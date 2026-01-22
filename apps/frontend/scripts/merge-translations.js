#!/usr/bin/env node

/**
 * Merge react-ui translations into frontend messages
 *
 * This script reads translations from:
 * - packages/react-ui/translations/*.json (react-ui component translations)
 * - apps/frontend/messages-source/*.json (frontend-specific translations)
 *
 * And merges them into:
 * - apps/frontend/messages/*.json (generated output for next-intl)
 *
 * The messages/ directory is gitignored since it contains generated content.
 */

const fs = require('fs');
const path = require('path');

const REACT_UI_TRANSLATIONS_DIR = path.resolve(__dirname, '../../../packages/react-ui/translations');
const FRONTEND_MESSAGES_SOURCE_DIR = path.resolve(__dirname, '../messages-source');
const FRONTEND_MESSAGES_OUTPUT_DIR = path.resolve(__dirname, '../messages');

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
  console.log('🔄 Merging react-ui translations into frontend messages...');

  // Ensure output directory exists
  if (!fs.existsSync(FRONTEND_MESSAGES_OUTPUT_DIR)) {
    fs.mkdirSync(FRONTEND_MESSAGES_OUTPUT_DIR, { recursive: true });
    console.log(`   Created output directory: ${FRONTEND_MESSAGES_OUTPUT_DIR}`);
  }

  // Get all react-ui translation files
  const reactUIFiles = getTranslationFiles(REACT_UI_TRANSLATIONS_DIR);
  console.log(`   Found ${reactUIFiles.length} react-ui translation files`);

  // Get all frontend source message files
  const frontendFiles = getTranslationFiles(FRONTEND_MESSAGES_SOURCE_DIR);
  console.log(`   Found ${frontendFiles.length} frontend source message files`);

  // Create a map of existing frontend source messages
  const frontendMessages = new Map();
  for (const file of frontendFiles) {
    const content = JSON.parse(fs.readFileSync(file.path, 'utf-8'));
    frontendMessages.set(file.locale, content);
  }

  let mergedCount = 0;
  let createdCount = 0;

  // Merge react-ui translations with frontend messages and write to output
  for (const reactUIFile of reactUIFiles) {
    const reactUIContent = JSON.parse(fs.readFileSync(reactUIFile.path, 'utf-8'));
    const outputPath = path.join(FRONTEND_MESSAGES_OUTPUT_DIR, `${reactUIFile.locale}.json`);

    if (frontendMessages.has(reactUIFile.locale)) {
      // Merge with existing frontend source messages (frontend takes precedence)
      const frontendContent = frontendMessages.get(reactUIFile.locale);
      const merged = deepMerge(reactUIContent, frontendContent);

      // Write merged content to output directory
      fs.writeFileSync(
        outputPath,
        JSON.stringify(merged, null, 2) + '\n',
        'utf-8'
      );
      mergedCount++;
      console.log(`   ✓ Merged ${reactUIFile.locale}.json`);
    } else {
      // Create output file from react-ui translations only
      fs.writeFileSync(
        outputPath,
        JSON.stringify(reactUIContent, null, 2) + '\n',
        'utf-8'
      );
      createdCount++;
      console.log(`   ✓ Created ${reactUIFile.locale}.json`);
    }
  }

  console.log(`✅ Translation merge complete!`);
  console.log(`   Merged: ${mergedCount} locales`);
  console.log(`   Created: ${createdCount} locales`);
  console.log(`   Output: ${FRONTEND_MESSAGES_OUTPUT_DIR}`);
}

// Run the merge
try {
  mergeTranslations();
  process.exit(0);
} catch (error) {
  console.error('❌ Error merging translations:', error);
  process.exit(1);
}
