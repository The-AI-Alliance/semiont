#!/usr/bin/env node
/**
 * Two questions about the stylesheet set that no single-file linter can answer:
 * is each class defined in ONE file, and is it rendered by any markup?
 *
 * BOTH ARE ENFORCED AGAINST A BASELINE, not against zero. The first run found
 * debt this plan did not create: 36 classes with a bare rule in two files, and
 * ~400 styled classes with no literal render site (the utility layers, the
 * motion overrides, the panel patterns). Some of that is genuinely dead, some is
 * host-facing — `styles/base/utilities.css` exists for consuming apps — and
 * telling them apart is a sweep of its own, recorded in
 * `.plans/CLEAN-PROGRESS.md`.
 *
 * So the baseline freezes what exists and the gate fails on anything NEW, plus
 * on anything that got fixed without being removed from the baseline (so the
 * debt list can only shrink). Allowlisting 400 classes to claim a green gate
 * would have been theatre; blocking the build on a sweep nobody has scheduled
 * would have been worse.
 *
 * WHY THIS IS NOT A STYLELINT RULE. Stylelint lints one file at a time. "Defined
 * twice" spans files, and "rendered nowhere" spans languages — the answer lives
 * in TSX. Neither question is visible from inside a single stylesheet, which is
 * how `.semiont-panel-progress` came to be styled in two files while no
 * component had rendered it for months, and how `.semiont-progress-bar` ended
 * up defined in three (CLEAN-PROGRESS C4).
 *
 * WHY IT MATTERS. A duplicate definition means every change has to be made N
 * times, and whichever copy you miss silently wins or loses on import order.
 * A rule for a class nobody renders is dead weight that still gets read,
 * maintained, and — as happened here — dutifully given a dark-theme variant.
 *
 * Class names built by concatenation (`semiont-${kind}-badge`) cannot be seen
 * by a grep, so a class is also considered live if its literal prefix appears
 * in a template string. That is deliberately permissive: this gate exists to
 * catch the obvious, not to be clever.
 */

const fs = require('fs');
const path = require('path');

const CSS_ROOTS = ['packages/react-ui/src', 'apps/browser/src'];
const MARKUP_ROOTS = ['packages/react-ui/src', 'apps/browser/src', 'apps/desktop/src'];

/** Classes whose consumer is outside this repo's markup, with the reason. */
const ALLOWLIST = new Map([
  ['semiont-sr-only', 'accessibility utility applied by hosts'],
]);

/**
 * Debt this gate found on its first run, recorded so it can fail on REGRESSIONS
 * today instead of waiting for a sweep that would have to land all at once.
 * Nothing may be added to this file: a new duplicate or a new dead class fails
 * the build. Entries come OUT as the sweep proceeds (.plans/CLEAN-PROGRESS.md).
 */
const BASELINE_PATH = path.join(__dirname, 'css-classes-baseline.json');
const baseline = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  : { duplicated: [], unrendered: [] };

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const DEFINITION = /\.(semiont-[a-zA-Z0-9_-]+)/g;

// Where each class is DEFINED (a selector at the head of a rule), per file.
const definedIn = new Map(); // class -> Set<file> (bare `.semiont-x { }` rules)
const mentioned = new Map(); // class -> Set<file> (any selector naming it)
/**
 * Walk the stylesheet, tracking whether we are inside an at-rule. A rule nested
 * in `@media (prefers-reduced-motion: reduce)` or `@media (prefers-contrast:
 * more)` is a CONDITIONAL variant of a class, not a second definition of it —
 * the accessibility layers are built entirely that way on purpose.
 */
function scan(source, file) {
  // Comments first: a section banner sitting above `@media` ends up in the same
  // selector-head buffer, and `'/* … */ @media'.startsWith('@')` is false — so
  // an unstripped comment silently turns a whole conditional layer into
  // "definitions". That mistake cost this gate 21 false positives.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
  let depth = 0, atDepth = null, i = 0, buf = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const head = buf.trim();
      depth++;
      if (head.startsWith('@')) {
        if (atDepth === null) atDepth = depth;
      } else {
        const conditional = atDepth !== null;
        for (const part of head.split(',')) {
          const selector = part.trim();
          const own = /^\.(semiont-[a-zA-Z0-9_-]+)$/.exec(selector);
          if (own && !conditional) {
            if (!definedIn.has(own[1])) definedIn.set(own[1], new Set());
            definedIn.get(own[1]).add(file);
          }
          for (const cls of selector.matchAll(DEFINITION)) {
            if (!mentioned.has(cls[1])) mentioned.set(cls[1], new Set());
            mentioned.get(cls[1]).add(file);
          }
        }
      }
      buf = '';
    } else if (ch === '}') {
      if (atDepth !== null && depth === atDepth) atDepth = null;
      depth--;
      buf = '';
    } else {
      buf += ch;
    }
    i++;
  }
}

for (const root of CSS_ROOTS) {
  for (const file of walk(root, ['.css'])) {
    if (file.includes('variables.css')) continue;
    scan(fs.readFileSync(file, 'utf8'), file);
  }
}

// Everything the markup could possibly emit, as one haystack.
let markup = '';
for (const root of MARKUP_ROOTS) {
  for (const file of walk(root, ['.tsx', '.ts'])) markup += fs.readFileSync(file, 'utf8');
}

const duplicated = [];
const unrendered = [];
for (const [cls, files] of [...definedIn].sort()) {
  if (files.size > 1) duplicated.push([cls, [...files]]);
}
for (const [cls, files] of [...mentioned].sort()) {
  if (ALLOWLIST.has(cls)) continue;
  // Live if the full name appears, or if some prefix of it does (concatenation).
  const literal = markup.includes(cls);
  const built = !literal && cls.split('-').some((_, i, parts) => {
    const prefix = parts.slice(0, parts.length - i).join('-');
    return prefix.length > 'semiont-'.length + 3 && markup.includes(`${prefix}-\${`);
  });
  if (!literal && !built) unrendered.push([cls, [...files]]);
}

const known = (list, cls) => list.includes(cls);
const newDuplicates = duplicated.filter(([cls]) => !known(baseline.duplicated, cls));
const newUnrendered = unrendered.filter(([cls]) => !known(baseline.unrendered, cls));
const fixedDuplicates = baseline.duplicated.filter((c) => !duplicated.some(([cls]) => cls === c));
const fixedUnrendered = baseline.unrendered.filter((c) => !unrendered.some(([cls]) => cls === c));

let failed = false;
if (newDuplicates.length) {
  failed = true;
  console.error(`\n✖ ${newDuplicates.length} NEW class(es) defined in more than one file:\n`);
  for (const [cls, files] of newDuplicates) console.error(`  .${cls}\n      ${files.join('\n      ')}`);
  console.error('\n  One file owns a class. Delete the copies, or qualify the variant.');
}
if (fixedDuplicates.length || fixedUnrendered.length) {
  failed = true;
  console.error(
    `\n✖ ${fixedDuplicates.length + fixedUnrendered.length} baseline entr(ies) are now clean — ` +
    'delete them from scripts/lint/css-classes-baseline.json so they cannot come back:\n',
  );
  for (const c of [...fixedDuplicates, ...fixedUnrendered]) console.error(`  .${c}`);
}
if (newUnrendered.length) {
  failed = true;
  console.error(`\n✖ ${newUnrendered.length} NEW class(es) styled but rendered by no markup:\n`);
  for (const [cls, files] of newUnrendered) console.error(`  .${cls}\n      ${files.join('\n      ')}`);
  console.error('\n  Delete the rules, or add the class to ALLOWLIST here with the reason.');
}
if (process.argv.includes('--debt')) {
  console.error(`\nBaseline debt: ${duplicated.length} duplicated, ${unrendered.length} unrendered`);
  for (const [cls, files] of [...duplicated, ...unrendered]) console.error(`  .${cls}  (${files.join(', ')})`);
}
if (failed) process.exit(1);

console.log(
  `✅ no new CSS-class debt (${definedIn.size} classes defined, ${mentioned.size} styled)`,
);
if (duplicated.length || unrendered.length) {
  console.log(
    `   carrying ${duplicated.length} duplicated + ${unrendered.length} unrendered from the ` +
    'baseline — run with --debt to list, see .plans/CLEAN-PROGRESS.md',
  );
}
