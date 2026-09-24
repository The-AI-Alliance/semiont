#!/usr/bin/env node
/**
 * Three questions about the stylesheet set that no single-file linter can
 * answer: is each class defined in ONE file, is it rendered by any markup, and
 * — the reverse — does each class the markup renders actually HAVE any CSS?
 *
 * The third was added 2026-09-24 after `/auth/error` was found rendering as
 * unstyled text on the page background, very nearly invisible in dark mode.
 * `AuthErrorDisplay` had referred to seven classes that existed in no
 * stylesheet since #401 moved this package off Tailwind — eight months, with a
 * green build the whole time, because a gate that only looks for CSS nobody
 * renders is blind to markup nobody styles. 87 more such classes were found
 * alongside it.
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
  ? { unstyled: [], ...JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) }
  : { duplicated: [], unrendered: [], unstyled: [] };

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

// Everything the markup could possibly emit, as one haystack — plus a record
// of which file each name came from, so the reverse check can name the site.
const RENDERED = /semiont-[a-zA-Z0-9_-]+/g;

/**
 * The `semiont-` names in a source file that are actually CLASSES.
 *
 * A bare scan cannot be used here. The prefix is also worn by CSS custom
 * properties (`--semiont-color-primary-500`), localStorage keys
 * (`semiont-toolbar-click`, `semiont-panel-width`) and assorted identifiers —
 * none of which any stylesheet should define. Reporting those as "unstyled"
 * would bury the real finding under ~25 entries that can never be fixed, which
 * is how a gate teaches people to ignore it.
 *
 * Note the asymmetry with the `unrendered` check above: there, being loose is
 * permissive (it spares a class from being called dead). Here, being loose
 * ACCUSES. So this side has to be strict.
 */
function classNamesIn(source) {
  const names = new Set();
  // In a className position: `className="a b"`, `className={cn('a', x)}`,
  // `` className={`a ${b}`} ``. A window, because the expression forms vary.
  for (const at of source.matchAll(/className/g)) {
    const window = source.slice(at.index, at.index + 200);
    for (const t of window.matchAll(RENDERED)) {
      // `--semiont-x` is a custom property, not a class.
      if (window[t.index - 1] === '-') continue;
      // `semiont-badge-${kind}` is a concatenation PREFIX, not a class.
      if (window.startsWith('${', t.index + t[0].length)) continue;
      // A name touching the window's edge was CUT by it: the window is a fixed
      // slice, so a class straddling the boundary yields a fragment
      // (`semiont-error-boun`) that no stylesheet could ever define. Dropping
      // these loses a class ending exactly at the edge, which is the right way
      // to be wrong for a check that accuses.
      if (t.index + t[0].length >= window.length) continue;
      names.add(t[0]);
    }
  }
  // Selector form — `querySelector('.semiont-x')`, `closest('.semiont-x')`.
  // A literal dot before the prefix is unambiguous: no valid JS reads a
  // property with a hyphen in it.
  for (const m of source.matchAll(/\.(semiont-[a-zA-Z0-9_-]+)/g)) names.add(m[1]);
  return names;
}
let markup = '';
const renderedIn = new Map(); // class -> Set<file>
for (const root of MARKUP_ROOTS) {
  for (const file of walk(root, ['.tsx', '.ts'])) {
    const source = fs.readFileSync(file, 'utf8');
    markup += source;
    for (const cls of classNamesIn(source)) {
      if (!renderedIn.has(cls)) renderedIn.set(cls, new Set());
      renderedIn.get(cls).add(file);
    }
  }
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

/**
 * The reverse of `unrendered`: markup names a class, no stylesheet mentions it.
 * `mentioned` is the right denominator — a class styled only inside an
 * `@media` block is still styled, just conditionally.
 */
const unstyled = [];
for (const [cls, files] of [...renderedIn].sort()) {
  if (ALLOWLIST.has(cls)) continue;
  if (mentioned.has(cls)) continue;
  unstyled.push([cls, [...files]]);
}

const known = (list, cls) => list.includes(cls);
const newDuplicates = duplicated.filter(([cls]) => !known(baseline.duplicated, cls));
const newUnrendered = unrendered.filter(([cls]) => !known(baseline.unrendered, cls));
const newUnstyled = unstyled.filter(([cls]) => !known(baseline.unstyled, cls));
const fixedDuplicates = baseline.duplicated.filter((c) => !duplicated.some(([cls]) => cls === c));
const fixedUnrendered = baseline.unrendered.filter((c) => !unrendered.some(([cls]) => cls === c));
const fixedUnstyled = baseline.unstyled.filter((c) => !unstyled.some(([cls]) => cls === c));

let failed = false;
if (newDuplicates.length) {
  failed = true;
  console.error(`\n✖ ${newDuplicates.length} NEW class(es) defined in more than one file:\n`);
  for (const [cls, files] of newDuplicates) console.error(`  .${cls}\n      ${files.join('\n      ')}`);
  console.error('\n  One file owns a class. Delete the copies, or qualify the variant.');
}
if (fixedDuplicates.length || fixedUnrendered.length || fixedUnstyled.length) {
  failed = true;
  console.error(
    `\n✖ ${fixedDuplicates.length + fixedUnrendered.length + fixedUnstyled.length} baseline ` +
    'entr(ies) are now clean — ' +
    'delete them from scripts/lint/css-classes-baseline.json so they cannot come back:\n',
  );
  for (const c of [...fixedDuplicates, ...fixedUnrendered, ...fixedUnstyled]) console.error(`  .${c}`);
}
if (newUnrendered.length) {
  failed = true;
  console.error(`\n✖ ${newUnrendered.length} NEW class(es) styled but rendered by no markup:\n`);
  for (const [cls, files] of newUnrendered) console.error(`  .${cls}\n      ${files.join('\n      ')}`);
  console.error('\n  Delete the rules, or add the class to ALLOWLIST here with the reason.');
}
if (newUnstyled.length) {
  failed = true;
  console.error(`\n✖ ${newUnstyled.length} NEW class(es) rendered by markup but styled nowhere:\n`);
  for (const [cls, files] of newUnstyled) console.error(`  .${cls}\n      ${files.join('\n      ')}`);
  console.error(
    '\n  The markup refers to nothing: the element renders unstyled, which on a\n' +
    '  themed background can mean invisible. Write the rule, or fix the name.',
  );
}
if (process.argv.includes('--debt')) {
  console.error(
    `\nBaseline debt: ${duplicated.length} duplicated, ${unrendered.length} unrendered, ` +
    `${unstyled.length} unstyled`,
  );
  for (const [cls, files] of [...duplicated, ...unrendered, ...unstyled]) {
    console.error(`  .${cls}  (${files.join(', ')})`);
  }
}
if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({
    // Carried forward, not regenerated: the note records WHEN and WHY each
    // tranche was frozen, which a rewrite would silently discard.
    _note: baseline._note,
    _note_unstyled: baseline._note_unstyled
      ?? 'Unstyled debt frozen 2026-09-24: markup naming classes no stylesheet defines, '
         + 'found when /auth/error rendered invisible. Entries may only be REMOVED.',
    duplicated: duplicated.map(([cls]) => cls),
    unrendered: unrendered.map(([cls]) => cls),
    unstyled: unstyled.map(([cls]) => cls),
  }, null, 2)}\n`);
  console.log(`Wrote baseline: ${duplicated.length} duplicated, ${unrendered.length} unrendered, ${unstyled.length} unstyled`);
  process.exit(0);
}

if (failed) process.exit(1);

console.log(
  `✅ no new CSS-class debt (${definedIn.size} classes defined, ${mentioned.size} styled)`,
);
if (duplicated.length || unrendered.length || unstyled.length) {
  console.log(
    `   carrying ${duplicated.length} duplicated + ${unrendered.length} unrendered + ` +
    `${unstyled.length} unstyled from the baseline — run with --debt to list, ` +
    'see .plans/CLEAN-PROGRESS.md',
  );
}
