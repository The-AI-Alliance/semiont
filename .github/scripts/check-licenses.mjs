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
// SPDX license expressions are evaluated properly: `A OR B` passes if either
// side is allowed, `A AND B` needs both, `A WITH exc` is judged on `A`, and
// parentheses group as written. NOASSERTION / NONE / LicenseRef-* (an
// undetermined or non-standard license) fails as "unknown" so a human reviews —
// unless the package is listed in exceptions.txt with a human-verified SPDX id
// (which is itself still checked against the allowlist).

import { readFileSync } from 'node:fs';

const [sbomPath, allowlistPath, exceptionsPath] = process.argv.slice(2);
if (!sbomPath || !allowlistPath) {
  console.error('Usage: node check-licenses.mjs <sbom.spdx.json> <allowlist.txt> [exceptions.txt]');
  process.exit(2);
}

// --- Allowlist -------------------------------------------------------------

const exact = new Set();
const prefixes = [];
for (const raw of readFileSync(allowlistPath, 'utf8').split('\n')) {
  const line = raw.replace(/#.*/, '').trim();
  if (!line) continue;
  if (line.endsWith('*')) prefixes.push(line.slice(0, -1).toLowerCase());
  else exact.add(line.toLowerCase());
}

// --- Exceptions (package name → human-verified SPDX id) --------------------

const exceptions = new Map();
if (exceptionsPath) {
  for (const raw of readFileSync(exceptionsPath, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [name, spdx] = line.split(/\s+/);
    if (name && spdx) exceptions.set(name, spdx);
  }
}

// True if a single SPDX license id is permitted by the allowlist.
function idAllowed(id) {
  let s = id.trim().toLowerCase().replace(/\+$/, ''); // drop "or-later" '+'
  if (!s || s === 'noassertion' || s === 'none') return false;
  if (s.startsWith('licenseref-')) return false; // non-standard → review
  if (exact.has(s)) return true;
  return prefixes.some((p) => s.startsWith(p));
}

// --- SPDX expression evaluator (recursive descent) -------------------------

function tokenize(expr) {
  return expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);
}

function evalExpr(expr) {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (t, op) => t && t.toUpperCase() === op;

  function parseOr() {
    let v = parseAnd();
    while (isOp(peek(), 'OR')) { i++; v = parseAnd() || v; }
    return v;
  }
  function parseAnd() {
    let v = parseWith();
    while (isOp(peek(), 'AND')) { i++; v = parseWith() && v; }
    return v;
  }
  function parseWith() {
    const v = parseAtom();
    if (isOp(peek(), 'WITH')) { i++; i++; } // consume WITH and its exception id
    return v;
  }
  function parseAtom() {
    if (peek() === '(') { i++; const v = parseOr(); if (peek() === ')') i++; return v; }
    return idAllowed(toks[i++] ?? '');
  }

  const result = parseOr();
  return { allowed: result, consumedAll: i >= toks.length };
}

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
  if (license === null && exceptions.has(pkg.name)) {
    license = exceptions.get(pkg.name);
    viaException = true;
  }

  if (license === null) {
    unknown.push({ name, license: pkg.licenseDeclared ?? 'NOASSERTION' });
    continue;
  }
  const { allowed } = evalExpr(license);
  if (!allowed) disallowed.push({ name, license: viaException ? `${license} (exception)` : license });
  else if (viaException) excepted.push({ name, license });
}

// --- Report ----------------------------------------------------------------

console.log(`Scanned ${scanned} npm dependencies against ${exact.size + prefixes.length} allowlist entries.`);

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
