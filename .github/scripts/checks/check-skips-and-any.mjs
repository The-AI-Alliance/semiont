#!/usr/bin/env node
/**
 * No test is skipped, and the tree's explicit `any` can only fall.
 *
 * Two standing rules say never: no test is skipped without the user's
 * explicit permission, and nothing is typed `any` without it. Nothing held
 * either: a skipped suite hid for months that it could not pass as written,
 * and a payload read `as any` hid two bugs of the History panel.
 *
 * Scanned: every TypeScript and JavaScript file git tracks, tests included.
 * A generated file is ignored by git, so it is never read.
 *
 * 1. A skip fails wherever it is: `.skip`, `.todo`, `.fixme`, `.skipIf` or
 *    `.runIf` on `describe`, `it`, `test`, `suite` or `bench`.
 * 2. Each file's count of `any` used as a type is held to the baseline,
 *    `skips-and-any-baseline.json`, exactly: one more fails, and so does one
 *    fewer that the baseline still counts, so the baseline only shrinks and
 *    is deleted when it is empty. An entry is a file and a count, not a line,
 *    so an unrelated edit moves nothing.
 *
 * `any` counts where a type stands: after `:`, `<`, `,`, `|`, `&`, `(`, `[`,
 * `=`, `>` (an arrow's return), `?` (a conditional type's branch) or `as`, `extends`, `satisfies`, `keyof`,
 * `readonly`, `is`, and before what may follow a type. Comments and the
 * text of strings and templates are blanked first, so prose is not counted
 * and a template's `${…}` is.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { repositoryFiles } from './repository-files.mjs';
import { withoutComments } from './source-text.mjs';

const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'skips-and-any-baseline.json');
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : {};

const TYPESCRIPT = /\.(ts|tsx|mts|cts)$/;
const SCANNED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const SKIP = /\b(?:describe|it|test|suite|bench)(?:\.\w+)*?\.(skip|todo|fixme|skipIf|runIf)\b/g;
const ANY =
  /(?:(?<=[:<,|&(\[=>?]\s*)|(?<=\b(?:as|extends|satisfies|keyof|readonly|is)\s+))any(?![\w$])(?=\s*(?:[\[\]>,)};|&=?{]|$))/gm;

/** What a regular expression literal follows; after anything else, a `/` divides. */
const REGEX_FOLLOWS = /^$|[=(,:[!&|?{};]/;

/** Where the regular expression literal opened at `start` closes, on its line; -1 when it does not. */
function regexEnd(text, start) {
  let inClass = false;
  for (let i = start + 1; i < text.length && text[i] !== '\n'; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '[') inClass = true;
    else if (text[i] === ']') inClass = false;
    else if (text[i] === '/' && !inClass) return i;
  }
  return -1;
}

/**
 * The text with the literal text of every string, template and regular
 * expression blanked and a template's `${…}` kept, line numbers held. A quote
 * with no closing quote on its line is an apostrophe of JSX text, not a
 * string, and is left.
 */
function withoutStrings(text) {
  const out = [];
  // Open templates, and the brace depth at which each `${` of one opened.
  const stack = [];
  let braces = 0;
  // The last character of code that is not white space: what a `/` follows.
  let last = '';
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  const literal = (start, end) => {
    out.push(text[start], text.slice(start + 1, end).replace(/[^\n]/g, ' '), text[end]);
    last = text[end];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (stack[stack.length - 1] === 'template') {
      if (ch === '\\') {
        out.push(' ', blank(text[i + 1] ?? ''));
        i++;
      } else if (ch === '`') {
        stack.pop();
        out.push(ch);
        last = ch;
      } else if (ch === '$' && text[i + 1] === '{') {
        stack.push(braces);
        braces++;
        out.push('${');
        i++;
      } else {
        out.push(blank(ch));
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== ch && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      if (text[end] === ch) {
        literal(i, end);
        i = end;
        continue;
      }
    } else if (ch === '/' && REGEX_FOLLOWS.test(last)) {
      const end = regexEnd(text, i);
      if (end !== -1) {
        literal(i, end);
        i = end;
        continue;
      }
    } else if (ch === '`') {
      stack.push('template');
    } else if (ch === '{') {
      braces++;
    } else if (ch === '}') {
      braces--;
      if (stack[stack.length - 1] === braces) stack.pop();
    }
    out.push(ch);
    if (!/\s/.test(ch)) last = ch;
  }
  return out.join('');
}

/** The line of each match of `re` in `text`. */
function linesOf(text, re) {
  return [...text.matchAll(re)].map((m) => ({ line: text.slice(0, m.index).split('\n').length, what: m[0] }));
}

const skips = [];
const anys = new Map();
for (const file of repositoryFiles(process.cwd()).filter((f) => SCANNED.test(f))) {
  const text = withoutStrings(withoutComments(readFileSync(file, 'utf8')));
  for (const site of linesOf(text, SKIP)) skips.push({ file, ...site });
  if (TYPESCRIPT.test(file)) {
    const sites = linesOf(text, ANY);
    if (sites.length > 0) anys.set(file, sites);
  }
}

let failed = false;

for (const { file, line, what } of skips) {
  failed = true;
  console.error(`✖ ${file}:${line}: ${what} — a test is skipped`);
}

for (const [file, sites] of anys) {
  const allowed = baseline[file] ?? 0;
  if (sites.length > allowed) {
    failed = true;
    console.error(`\n✖ ${file} has ${sites.length} \`any\`; the baseline counts ${allowed}:`);
    for (const s of sites) console.error(`    line ${s.line}`);
  }
}
for (const [file, allowed] of Object.entries(baseline)) {
  const count = anys.get(file)?.length ?? 0;
  if (count < allowed) {
    failed = true;
    console.error(`\n✖ ${file} has ${count} \`any\`; the baseline counts ${allowed} — lower it to ${count}${count === 0 ? ' by removing the entry' : ''}.`);
  }
}

if (failed) {
  console.error(
    '\n  A test is skipped only with the user\'s explicit permission, and nothing is\n' +
      '  typed `any` without it. Type it as what it is, or `unknown` narrowed where it\n' +
      '  is read. The baseline is the debt the tree carried when this gate began:\n' +
      '  nothing is added to it, and an entry fixed is lowered or removed.\n',
  );
  process.exit(1);
}
const total = [...anys.values()].reduce((n, s) => n + s.length, 0);
console.log(`✅ skips and any: no test skipped; ${total} \`any\` in ${anys.size} files, each counted by the baseline`);
