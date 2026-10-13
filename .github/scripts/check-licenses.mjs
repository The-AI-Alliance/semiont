#!/usr/bin/env node
// License-policy gate for the published service images.
//
// Reads a Trivy SPDX-JSON SBOM and a permissive allowlist, then fails if any
// bundled language package carries a license that the allowlist doesn't permit.
// Scope is the packages an image installs from npm (a `pkg:npm/` purl) and from
// PyPI (`pkg:pypi/`) — OS/apk packages (e.g. git) are out of scope here and
// covered by the per-image NOTICE, and the crates a Rust binary links are held
// by scripts/lint/check-image-crates.mjs, since a binary states no license.
//
// Usage: node check-licenses.mjs <sbom.spdx.json> <allowlist.txt> [exceptions.txt]
//
// The policy — the allowlist, the exceptions, and how an SPDX expression is
// judged — is license-policy.mjs's. An undetermined license fails as "unknown"
// so a human reviews, unless exceptions.txt lists the package with a
// human-verified SPDX id (itself still checked against the allowlist). A
// license the scanner reports under a name SPDX does not have fails the same
// way, unless exceptions.txt answers for that name on that package.

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

/** The name the scanner reports each license under that SPDX does not have, by the `LicenseRef-*` it stands behind. */
const namesOfReferences = new Map((sbom.hasExtractedLicensingInfos ?? []).map((info) => [info.licenseId, info.name]));

/** The package indexes whose packages are judged, by the purl each one's package carries. */
const ECOSYSTEMS = { 'pkg:npm/': 'npm', 'pkg:pypi/': 'PyPI' };

/** The index a package was installed from, when it is one of ECOSYSTEMS. */
function ecosystemOf(pkg) {
  for (const ref of pkg.externalRefs ?? []) {
    if (ref.referenceType !== 'purl') continue;
    for (const [prefix, ecosystem] of Object.entries(ECOSYSTEMS)) {
      if (String(ref.referenceLocator).startsWith(prefix)) return ecosystem;
    }
  }
  return undefined;
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
const named = [];
const scanned = Object.fromEntries(Object.values(ECOSYSTEMS).map((ecosystem) => [ecosystem, 0]));

for (const pkg of packages) {
  const ecosystem = ecosystemOf(pkg);
  if (ecosystem === undefined) continue;
  scanned[ecosystem]++;
  const name = `${pkg.name}@${pkg.versionInfo ?? '?'} (${ecosystem})`;
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

  // A license the scanner could not name is answered the same way: only that
  // name, on that package. What it did name stays in the expression.
  const { expression, answers } = policy.answered(license, pkg.name, namesOfReferences);
  if (!policy.allows(expression, pkg.name)) {
    const how = viaException ? ' (exception)' : answers.length > 0 ? ` (with ${answers.map((a) => `"${a.reported}" answered as ${a.verified}`).join(', ')})` : '';
    disallowed.push({ name, license: `${license}${how}` });
  } else if (viaException) excepted.push({ name, license });
  else for (const answer of answers) named.push({ name, ...answer });
}

// --- Report ----------------------------------------------------------------

const counted = Object.entries(scanned).map(([ecosystem, count]) => `${count} ${ecosystem}`).join(' and ');
console.log(`Scanned ${counted} packages against ${policy.size} allowlist entries.`);

for (const e of excepted) {
  console.log(`ℹ️  ${e.name}: no license in metadata; using verified exception → ${e.license}`);
}
for (const n of named) {
  console.log(`ℹ️  ${n.name}: "${n.reported}" is no SPDX license; using verified exception → ${n.verified}`);
}

if (disallowed.length === 0 && unknown.length === 0) {
  console.log('✅ All bundled package licenses are on the permissive allowlist.');
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
