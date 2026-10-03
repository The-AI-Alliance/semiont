// go-source.mjs — what the generators of committed Go share: a comment wrapped
// as gofmt leaves it, and the write that is also the drift gate.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, relative } from 'node:path';

/** `text` as `//` comment lines, wrapped at `width` columns, behind `indent`. */
export function goComment(text, indent = '', width = 78) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && `${indent}// ${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${indent}// ${l}`).join('\n');
}

/**
 * Write `text` to `path`, or with `check` only compare. Exits 1 when `check`
 * finds the committed file differs from what the source generates.
 */
export function writeOrCheck(root, path, text, check) {
  const name = relative(root, path);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (current === text) {
    console.log(`ok    ${name}`);
    return;
  }
  console.log(`${current ? 'DRIFT' : 'new  '} ${name}`);
  if (check) process.exit(1);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
