#!/usr/bin/env node
/**
 * @semiont/core's heavy subpaths must stay out of the root entry.
 *
 * `.` is what every browser consumer imports. Two modules are deliberately
 * reachable only by their own subpath because of what they drag in:
 *
 *   src/openapi.ts        — ~1.3 MB of generated validators
 *   src/testing/issuer.ts — `jose`, for signing a test issuer's tokens
 *
 * A re-export of either from the root index would pull that weight into every
 * bundle, and nothing would fail: the build would succeed, the tests would
 * pass, and the browser would simply get bigger. This is the gate that makes
 * that loud instead of silent.
 */
import { readFileSync } from 'fs';

const ROOT_INDEX = 'packages/typescript/core/src/index.ts';
const FORBIDDEN = [
  { module: './openapi', subpath: '@semiont/core/openapi', why: 'pulls ~1.3 MB of generated validators' },
  { module: './testing/issuer', subpath: '@semiont/core/testing/issuer', why: 'pulls `jose` into every browser bundle' },
];

const source = readFileSync(ROOT_INDEX, 'utf8');
const violations = FORBIDDEN.filter(({ module }) =>
  new RegExp(`from\\s+['"]${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(source),
);

if (violations.length > 0) {
  console.error(`\n✖ ${ROOT_INDEX} re-exports a subpath-only module:\n`);
  for (const { module, subpath, why } of violations) {
    console.error(`  ${module}\n      ${why}\n      Import it as its own subpath instead (${subpath}).`);
  }
  console.error('');
  process.exit(1);
}

console.log(`✅ ${ROOT_INDEX} keeps ${FORBIDDEN.length} subpath-only module(s) out of the root entry`);
