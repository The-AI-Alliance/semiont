#!/usr/bin/env node
// License-policy gate for the published service images.
//
// Reads a Trivy SPDX-JSON SBOM and a permissive allowlist, then fails if any
// bundled npm dependency carries a license that the allowlist doesn't permit.
// Scope is npm dependencies only (matched by `pkg:npm/` purl) — OS/apk packages
// (e.g. git) are out of scope here and covered by the per-image NOTICE.
//
// Usage: node check-licenses.mjs <sbom.spdx.json> <allowlist.txt> [exceptions.txt]
//
// The policy — the allowlist, the exceptions, and how an SPDX expression is
// judged — is license-policy.mjs's. An undetermined license fails as "unknown"
// so a human reviews, unless exceptions.txt lists the package with a
// human-verified SPDX id (itself still checked against the allowlist).

import { readFileSync } from 'node:fs';
import { loadPolicy } from './license-policy.mjs';

const [sbomPath, allowlistPath, exceptionsPath] = process.argv.slice(2);
if (!sbomPath || !allowlistPath) {
  console.error('Usage: node check-licenses.mjs <sbom.spdx.json> <allowlist.txt> [exceptions.txt]');
  process.exit(2);
}

const policy = loadPolicy(allowlistPath, exceptionsPath);

// --- Walk the SBOM ---------------------------------------------------------

const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
const packages = Array.isArray(sbom.packages) ? sbom.packages : [];

function isNpm(pkg) {
  return (pkg.externalRefs ?? []).some(
    (ref) => ref.referenceType === 'purl' && String(ref.referenceLocator).startsWith('pkg:npm/'),
  );
}

function licenseOf(pkg) {
  const concluded = pkg.licenseConcluded;
  if (concluded && concluded !== 'NOASSERTION' && concluded !== 'NONE') return concluded;
  const declared = pkg.licenseDeclared;
  if (declared && declared !== 'NOASSERTION' && declared !== 'NONE') return declared;
  return null; // undetermined
}

const disallowed = [];
const unknown = [];
const excepted = [];
let scanned = 0;

for (const pkg of packages) {
  if (!isNpm(pkg)) continue;
  scanned++;
  const name = `${pkg.name}@${pkg.versionInfo ?? '?'}`;
  let license = licenseOf(pkg);

  // An exception supplies a verified license ONLY when the scanner found none;
  // a real detected license (even a bad one) is never masked.
  let viaException = false;
  if (license === null) {
    const verified = policy.exceptionFor(pkg.name);
    if (verified !== undefined) {
      license = verified;
      viaException = true;
    }
  }

  if (license === null) {
    unknown.push({ name, license: pkg.licenseDeclared ?? 'NOASSERTION' });
    continue;
  }
  if (!policy.allows(license)) disallowed.push({ name, license: viaException ? `${license} (exception)` : license });
  else if (viaException) excepted.push({ name, license });
}

// --- Report ----------------------------------------------------------------

console.log(`Scanned ${scanned} npm dependencies against ${policy.size} allowlist entries.`);

for (const e of excepted) {
  console.log(`ℹ️  ${e.name}: no license in metadata; using verified exception → ${e.license}`);
}

if (disallowed.length === 0 && unknown.length === 0) {
  console.log('✅ All bundled npm dependency licenses are on the permissive allowlist.');
  process.exit(0);
}

if (disallowed.length) {
  console.error(`\n❌ ${disallowed.length} dependency(ies) with a non-allowlisted license:`);
  for (const d of disallowed) console.error(`   ${d.name}  →  ${d.license}`);
}
if (unknown.length) {
  console.error(`\n❌ ${unknown.length} dependency(ies) with an undetermined/non-standard license:`);
  for (const u of unknown) console.error(`   ${u.name}  →  ${u.license}`);
}
console.error(
  '\nEach either needs its SPDX id added to .github/licenses/allowlist.txt (if genuinely ' +
    'permissive) or the dependency dropped. See the allowlist header for the policy.',
);
process.exit(1);
