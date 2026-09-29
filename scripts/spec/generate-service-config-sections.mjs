// Generate which config sections each Node service reads, from
// specs/src/service-config/sections.json. The loader enforces it (a read of
// an unlisted section refuses) and the launcher forwards by it, so neither
// restates the lists. Output is gitignored and rebuilt by core's `prebuild`,
// like the limits beside it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SPEC = resolve(ROOT, 'specs/src/service-config/sections.json');
const OUT_DIR = resolve(ROOT, 'packages/core/src/generated');
const OUT = resolve(OUT_DIR, 'service-config-sections.ts');

const { services } = JSON.parse(readFileSync(SPEC, 'utf8'));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  `// ⚠ GENERATED FILE — do not edit.
// Source: specs/src/service-config/sections.json → scripts/spec/generate-service-config-sections.mjs
// Rebuilt by \`npm run prebuild\` in @semiont/core; gitignored on purpose.

/** The [environments.<env>] sections each Node service reads. */
export const serviceConfigSections = ${JSON.stringify(services, null, 2)} as const;

/** A Node service that loads the knowledge base's config. */
export type ConfigService = keyof typeof serviceConfigSections;
`,
);

console.log(`generated ${Object.keys(services).length} services' config sections → packages/core/src/generated/service-config-sections.ts`);
