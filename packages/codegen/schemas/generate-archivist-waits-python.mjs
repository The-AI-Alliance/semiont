#!/usr/bin/env node
// generate-archivist-waits-python.mjs — generate how long the Python services
// wait for the Archivist from the Archivist's document,
// protocol/specs/src/archivist/openapi.json, whose `x-semiont-limits` the
// gateway reads too:
//
//   packages/python/service/src/semiont_service/_archivist_waits.py
//
// --check compares without writing (the CI drift gate).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeOrCheck } from '../lib/committed-source.mjs';
import { pyBanner, pyComment } from '../lib/python-source.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = 'protocol/specs/src/archivist/openapi.json';
const OUT = resolve(ROOT, 'packages/python/service/src/semiont_service/_archivist_waits.py');
const CHECK = process.argv.includes('--check');

const limits = JSON.parse(readFileSync(resolve(ROOT, SOURCE), 'utf8'))['x-semiont-limits'];

function seconds(key) {
  const value = limits?.[key];
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`✗ ${SOURCE}: x-semiont-limits.${key} is ${JSON.stringify(value)}, not a positive integer`);
    process.exit(1);
  }
  return value;
}

const text = `${pyBanner(SOURCE, 'packages/codegen/schemas/generate-archivist-waits-python.mjs')}
"""How long a caller waits for the Archivist: its document's \`x-semiont-limits\`."""

from typing import Final

__all__ = ["CONNECT_SECONDS", "READ_SECONDS"]

${pyComment('How long the Archivist is given to take a connection (`connectSeconds`).')}
CONNECT_SECONDS: Final = ${seconds('connectSeconds')}

${pyComment('How long the Archivist is given for each part of an answer (`readSeconds`): for the answer to begin once its request is sent whole, and for each next part. No bound is put on a whole answer.')}
READ_SECONDS: Final = ${seconds('readSeconds')}
`;

writeOrCheck(ROOT, OUT, text, CHECK);
