// committed-source.mjs — what every generator of committed source shares: the
// write that is also the drift gate.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, relative } from 'node:path';

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
