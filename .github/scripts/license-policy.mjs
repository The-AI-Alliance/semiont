// The license policy both license gates apply: the permissive allowlist
// (.github/licenses/allowlist.txt) and the human-verified exceptions
// (.github/licenses/exceptions.txt), with SPDX expressions evaluated properly —
// `A OR B` passes if either side is allowed, `A AND B` needs both, `A WITH exc`
// is judged on `A`, and parentheses group as written. NOASSERTION / NONE /
// LicenseRef-* (an undetermined or non-standard license) is never allowed, so a
// human reviews it. A license the allowlist names `for` one package is allowed
// on that package and on no other.
//
// Read by check-licenses.mjs (npm packages in an image's SBOM) and by
// scripts/lint/check-image-crates.mjs (the crates each Rust service binary links).

import { readFileSync } from 'node:fs';

/**
 * Allowlist lines: one SPDX id each; a trailing `*` is a prefix wildcard. A line
 * `<SPDX-id> for <package-name>` allows that license on that one package: the
 * id is then neither exact nor a prefix, so no other package has it.
 */
function readAllowlist(path) {
  const exact = new Set();
  const prefixes = [];
  const scoped = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [id, word, name, ...more] = line.split(/\s+/);
    if (word === undefined) {
      if (id.endsWith('*')) prefixes.push(id.slice(0, -1).toLowerCase());
      else exact.add(id.toLowerCase());
    } else if (word === 'for' && name && more.length === 0 && !id.endsWith('*') && !name.endsWith('*')) {
      scoped.push({ id: id.toLowerCase(), name });
    } else {
      throw new Error(`${path}: "${line}" is neither an SPDX id nor "<SPDX-id> for <package-name>"`);
    }
  }
  return { exact, prefixes, scoped };
}

/**
 * Exceptions: package name → human-verified SPDX id, for a package whose
 * metadata carries no license. A trailing `*` on the name is a prefix wildcard,
 * for generators that name their output with a content hash.
 */
function readExceptions(path) {
  const exact = new Map();
  const prefixes = [];
  if (!path) return { exact, prefixes };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [name, spdx] = line.split(/\s+/);
    if (!name || !spdx) continue;
    if (name.endsWith('*')) prefixes.push([name.slice(0, -1), spdx]);
    else exact.set(name, spdx);
  }
  return { exact, prefixes };
}

const tokenize = (expr) => expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);

export function loadPolicy(allowlistPath, exceptionsPath) {
  const allowlist = readAllowlist(allowlistPath);
  const exceptions = readExceptions(exceptionsPath);

  // True if a single SPDX license id is permitted by the allowlist, on the package it is `of`.
  function idAllowed(id, of) {
    const s = id.trim().toLowerCase().replace(/\+$/, ''); // drop "or-later" '+'
    if (!s || s === 'noassertion' || s === 'none') return false;
    if (s.startsWith('licenseref-')) return false; // non-standard → review
    if (allowlist.exact.has(s)) return true;
    if (allowlist.prefixes.some((p) => s.startsWith(p))) return true;
    return allowlist.scoped.some((entry) => entry.id === s && entry.name === of);
  }

  return {
    /** How many entries the allowlist has. */
    size: allowlist.exact.size + allowlist.prefixes.length + allowlist.scoped.length,

    /** Whether an SPDX expression is permitted on the package named `of`. */
    allows(expr, of) {
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
        return idAllowed(toks[i++] ?? '', of);
      }
      return parseOr();
    },

    /**
     * The verified SPDX id for a package with no license of its own, or
     * undefined. Exact entries win over prefixes; the caller still checks the
     * result against the allowlist, so an exception can only rescue a package
     * TO a permissive license, never past the policy.
     */
    exceptionFor(name) {
      if (exceptions.exact.has(name)) return exceptions.exact.get(name);
      return exceptions.prefixes.find(([p]) => name.startsWith(p))?.[1];
    },
  };
}
