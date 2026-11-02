// identifier-kinds.mjs — the one reading of specs/src/identifiers/kinds.json
// and each kind's schema that every generator of the id types shares: a kind
// is named, and its schema is a string with a pattern and a description.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The kinds the table at `kindsPath` names, each with its schema from
 * `schemasDir` (`name`, `type`, `pattern`, `description`). `refuse(message)`
 * is called for a table that cannot be generated from, and does not return.
 */
export function readIdentifierKinds(kindsPath, schemasDir, refuse) {
  const { kinds } = JSON.parse(readFileSync(kindsPath, 'utf8'));
  if (!Array.isArray(kinds) || kinds.length === 0) refuse('lists no kinds');

  const read = [];
  for (const { schema: name } of kinds) {
    if (typeof name !== 'string' || !/^[A-Z][A-Za-z]*Id$/.test(name)) refuse(`${JSON.stringify(name)} is not a kind's name: PascalCase, ending in Id`);
    const schema = JSON.parse(readFileSync(resolve(schemasDir, `${name}.json`), 'utf8'));
    if (schema.type !== 'string' || typeof schema.pattern !== 'string' || typeof schema.description !== 'string') {
      refuse(`${name} is not a string with a pattern and a description`);
    }
    try {
      new RegExp(schema.pattern, 'u');
    } catch (error) {
      refuse(`${name}'s pattern is not a regular expression: ${error.message}`);
    }
    read.push({ name, ...schema });
  }
  return read;
}
