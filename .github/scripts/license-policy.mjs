// The license policy both license gates apply: the permissive allowlist
// (.github/licenses/allowlist.txt) and the human-verified exceptions
// (.github/licenses/exceptions.txt), with SPDX expressions evaluated properly —
// `A OR B` passes if either side is allowed, `A AND B` needs both, `A WITH exc`
// is judged on `A`, and parentheses group as written. An expression is judged
// only when it is read to its end: one with words left over, a parenthesis that
// does not pair, or an operator with nothing after it is refused, whatever
// licenses it begins with. NOASSERTION / NONE /
// LicenseRef-* (an undetermined or non-standard license) is never allowed, so a
// human reviews it. A license the allowlist names `for` one package is allowed
// on that package and on no other.
//
// What the review found is an exception: for a package that states no license,
// and for a license a package states under a name SPDX does not have. An
// exception answers only where the scanner could not, and what it answers is
// judged against the allowlist like any other license.
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
 * Exceptions: what a human verified where the scanner could not say.
 *
 * `<package-name> <SPDX expression>` is for a package whose metadata carries no
 * license. A trailing `*` on the name is a prefix wildcard, for generators that
 * name their output with a content hash.
 *
 * `<package-name> "<name>" <SPDX expression>` is for a package whose metadata
 * states a license under a name SPDX does not have: `<name>` is that name as
 * the scanner reports it. The line answers for that name on that package, and
 * for no other name and no other package.
 */
function readExceptions(path) {
  const exact = new Map();
  const prefixes = [];
  const named = [];
  if (!path) return { exact, prefixes, named };
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [, name, reported, spdx] = /^(\S+)\s+(?:"([^"]+)"\s+)?(\S.*)$/.exec(line) ?? [];
    if (!name || !spdx || spdx.includes('"')) {
      throw new Error(`${path}: "${line}" is neither "<package-name> <SPDX expression>" nor "<package-name> \"<name>\" <SPDX expression>"`);
    }
    if (reported !== undefined) {
      if (name.endsWith('*')) throw new Error(`${path}: "${line}" answers for a name on every package of a prefix; a name is answered for one package`);
      named.push({ name, reported, spdx });
    } else if (name.endsWith('*')) prefixes.push([name.slice(0, -1), spdx]);
    else exact.set(name, spdx);
  }
  return { exact, prefixes, named };
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

    /**
     * Whether an SPDX expression is permitted on the package named `of`.
     *
     * Only an expression read to its end is permitted. Words left over after
     * it, a parenthesis that is not closed or was never opened, an operator
     * with no license after it and a `WITH` that names no exception are each
     * refused: what was not read was not judged.
     */
    allows(expr, of) {
      const toks = tokenize(expr);
      let i = 0;
      let readAsWritten = true;
      const peek = () => toks[i];
      const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;
      /** Whether a token is a license's id or an exception's: a word, and not an operator or a parenthesis. */
      const isId = (t) => t !== undefined && t !== '(' && t !== ')' && !['OR', 'AND', 'WITH'].includes(t.toUpperCase());
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
        if (isOp(peek(), 'WITH')) {
          i++;
          if (isId(peek())) i++; // the exception's id
          else readAsWritten = false;
        }
        return v;
      }
      function parseAtom() {
        if (peek() === '(') {
          i++;
          const v = parseOr();
          if (peek() === ')') i++;
          else readAsWritten = false;
          return v;
        }
        if (!isId(peek())) {
          readAsWritten = false;
          return false;
        }
        return idAllowed(toks[i++], of);
      }
      const allowed = parseOr();
      return allowed && readAsWritten && i === toks.length;
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

    /**
     * An expression with each license the scanner could not name answered,
     * where a human has answered for it on the package named `of`. `names`
     * gives, for each `LicenseRef-*` of the expression, the name the scanner
     * reports it under.
     *
     * Only such a reference is replaced, and by the verified expression in
     * parentheses. Every SPDX id the scanner found stays, and so does a
     * reference nobody answered for, which `allows` then refuses. So the
     * caller judges the result as it would any expression, and an exception
     * carries nothing past the allowlist.
     */
    answered(expr, of, names) {
      const answers = [];
      const tokens = tokenize(expr).flatMap((token) => {
        if (!/^LicenseRef-/i.test(token)) return [token];
        const reported = names.get(token);
        const verified = exceptions.named.find((entry) => entry.name === of && entry.reported === reported)?.spdx;
        if (verified === undefined) return [token];
        answers.push({ reported, verified });
        return ['(', ...tokenize(verified), ')'];
      });
      return { expression: tokens.join(' '), answers };
    },
  };
}
