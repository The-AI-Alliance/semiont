#!/usr/bin/env tsx

/**
 * Generate TypeScript types from JSON Schema
 *
 * Converts config.schema.json into config.types.ts using json-schema-to-typescript
 * This ensures types stay in sync with the schema automatically
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const schemaPath = path.join(__dirname, '..', 'src', 'config', 'config.schema.json');
const outputPath = path.join(__dirname, '..', 'src', 'config', 'config.types.ts');

console.log('🔄 Generating TypeScript types from JSON Schema...');

// Verify schema exists
if (!fs.existsSync(schemaPath)) {
  console.error(`❌ Schema not found: ${schemaPath}`);
  process.exit(1);
}

try {
  // Generate types using json-schema-to-typescript
  // Use --unreachableDefinitions to export all definitions, not just the root schema
  execSync(
    `npx json-schema-to-typescript ${schemaPath} -o ${outputPath} --bannerComment "/* Generated from config.schema.json - DO NOT EDIT MANUALLY */" --style.singleQuote --unreachableDefinitions`,
    {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    }
  );

  console.log(`✅ TypeScript types generated: ${outputPath}`);
} catch (error) {
  console.error('❌ Failed to generate types:', (error as Error).message);
  process.exit(1);
}
