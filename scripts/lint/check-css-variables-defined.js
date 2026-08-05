#!/usr/bin/env node
/**
 * Every `var(--x)` must resolve to a `--x:` defined somewhere in the same
 * package's stylesheet set.
 *
 * WHY THIS IS NOT A STYLELINT RULE. Stylelint lints one file at a time, and a
 * `var()` in a component's CSS is *supposed* to be satisfied by a token file
 * it never imports — so per-file analysis cannot tell "defined elsewhere" from
 * "defined nowhere" without whole-project knowledge stylelint does not have.
 * Its nearest built-in, `custom-property-no-missing-var-function`, catches the
 * opposite mistake (`color: --x` with no `var()`). There is no core rule for
 * undefined references, which is why 46 of them accumulated silently.
 *
 * WHY IT MATTERS THAT NOTHING ERRORS. An unresolved `var()` with no fallback
 * makes the declaration invalid at computed-value time: the property silently
 * takes its inherited or initial value. A border becomes `currentColor`, a
 * background becomes transparent. The page looks nearly right and cannot be
 * themed, with no console warning and no failing build.
 *
 * Inline fallbacks — `var(--x, #fff)` — are ALLOWED and not reported: those
 * are deliberate optional theming hooks a host may override.
 */

const fs = require('fs');
const path = require('path');

const ROOTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['packages/react-ui/src', 'apps/frontend/src'];

/** Every .css under a root. */
function cssFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) cssFiles(full, out);
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const DEFINITION = /^\s*(--[a-zA-Z0-9_-]+)\s*:/gm;
// Capture the delimiter so `var(--x, fallback)` can be told from `var(--x)`.
const USAGE = /var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g;

let failed = false;

for (const root of ROOTS) {
  const files = cssFiles(root);
  if (files.length === 0) continue;

  const defined = new Set();
  const missing = new Map(); // name -> Set<"file:line">

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(DEFINITION)) defined.add(m[1]);
  }

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(USAGE)) {
        const [, name, delimiter] = m;
        if (delimiter === ',') continue; // has an inline fallback — allowed
        if (defined.has(name)) continue;
        if (!missing.has(name)) missing.set(name, new Set());
        missing.get(name).add(`${file}:${i + 1}`);
      }
    });
  }

  if (missing.size === 0) {
    console.log(`✅ ${root}: every var() resolves (${defined.size} defined, ${files.length} files)`);
    continue;
  }

  failed = true;
  console.error(`\n❌ ${root}: ${missing.size} CSS variable(s) used but never defined\n`);
  for (const [name, sites] of [...missing].sort()) {
    console.error(`   ${name}`);
    for (const site of [...sites].slice(0, 3)) console.error(`      ${site}`);
    if (sites.size > 3) console.error(`      …and ${sites.size - 3} more`);
  }
  console.error(
    '\n   Fix by defining the token (styles/variables.css, in every theme block)\n' +
    '   or by re-pointing the usage at the token that already exists.\n' +
    '   Do NOT silence this with an inline fallback at each usage site.\n',
  );
}

process.exit(failed ? 1 : 0);
