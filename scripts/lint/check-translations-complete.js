#!/usr/bin/env node
/**
 * Every translation key exists in every supported locale — in BOTH directions.
 *
 * `en.json` is the reference set. A key present in `en` and missing elsewhere
 * ships the KEY NAME to that user: `useTranslations` returns the key when it
 * cannot resolve one, so a gap renders as `codeCompleteCreated` where a
 * sentence belongs. Nothing throws, nothing logs in production, and it is
 * invisible to anyone testing in English — which is everyone, most of the time.
 *
 * Extra keys are reported too, and deliberately not as a lesser problem: a key
 * that exists only in `de.json` is either a typo of a real key (so the real one
 * is silently untranslated in German) or a leftover from a deletion that swept
 * `en` and missed the rest. Both are worth a build failure.
 *
 * Scope is BOTH translation sets, because the repo has two with different
 * owners and it is easy to update one and forget the other:
 *   • packages/react-ui/translations   — react-ui component copy
 *   • apps/browser/messages-source    — host-specific copy
 * (`apps/browser/messages/` is generated from these and gitignored; it is
 * deliberately NOT checked — checking build output would just restate this.)
 *
 * WHY THIS IS GENERAL AND NOT PER-FEATURE. An earlier version of this gate
 * checked one namespace's keys against a hand-maintained list. That is strictly
 * worse: it needs editing for every new feature, it says nothing about the other
 * 400 keys, and its own list drifts. Locale completeness is one invariant over
 * the whole corpus — so it is one check over the whole corpus.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SETS = [
  { label: 'packages/react-ui/translations', dir: path.join(ROOT, 'packages/react-ui/translations') },
  { label: 'apps/browser/messages-source', dir: path.join(ROOT, 'apps/browser/messages-source') },
];

/** Flattened dotted key paths, so a nested namespace is compared structurally. */
function keyPaths(value, prefix = '') {
  const out = new Set();
  for (const [k, v] of Object.entries(value)) {
    const key = `${prefix}${k}`;
    out.add(key);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const nested of keyPaths(v, `${key}.`)) out.add(nested);
    }
  }
  return out;
}

const sample = (items, n = 8) => {
  const list = [...items].sort();
  return list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} …and ${list.length - n} more`;
};

let failed = false;

for (const { label, dir } of SETS) {
  if (!fs.existsSync(dir)) {
    console.error(`❌ ${label}: directory not found`);
    failed = true;
    continue;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const reference = files.find((f) => f === 'en.json');
  if (!reference) {
    console.error(`❌ ${label}: no en.json to compare against`);
    failed = true;
    continue;
  }

  const refKeys = keyPaths(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')));
  const problems = [];

  for (const file of files) {
    if (file === 'en.json') continue;
    const keys = keyPaths(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
    const missing = [...refKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !refKeys.has(k));
    if (missing.length) problems.push(`   ${file} — MISSING ${missing.length}: ${sample(missing)}`);
    if (extra.length) problems.push(`   ${file} — EXTRA ${extra.length}: ${sample(extra)}`);
  }

  if (problems.length) {
    failed = true;
    console.error(`\n❌ ${label}: locales out of sync with en.json\n`);
    console.error(problems.join('\n'));
  } else {
    console.log(`✅ ${label}: ${refKeys.size} keys present in all ${files.length} locales`);
  }
}

if (failed) {
  console.error(
    '\n   A missing key does not throw — useTranslations returns the key itself,\n' +
    '   so this ships as a raw key shown to a user in that language.\n',
  );
  process.exit(1);
}
